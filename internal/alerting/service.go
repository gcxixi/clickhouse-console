package alerting

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Service struct {
	mu           sync.RWMutex
	repo         Repository
	codec        *SecretCodec
	executor     Executor
	sender       Sender
	log          *slog.Logger
	historyLimit int
	running      map[int64]bool
	wake         chan struct{}
	stop         chan struct{}
	done         chan struct{}
}

func NewService(executor Executor, sender Sender, codec *SecretCodec, log *slog.Logger) *Service {
	s := &Service{executor: executor, sender: sender, codec: codec, log: log, historyLimit: 300, running: map[int64]bool{}, wake: make(chan struct{}, 1), stop: make(chan struct{}), done: make(chan struct{})}
	go s.loop()
	return s
}

func (s *Service) SetExecutor(executor Executor) {
	s.mu.Lock()
	s.executor = executor
	s.mu.Unlock()
	s.Wake()
}

func (s *Service) Configure(repo Repository, historyLimit int) {
	if historyLimit < 1 {
		historyLimit = 300
	}
	s.mu.Lock()
	old := s.repo
	s.repo, s.historyLimit = repo, historyLimit
	s.mu.Unlock()
	if repo != nil {
		if err := repo.Prune(context.Background(), historyLimit); err != nil {
			s.log.Error("prune alert history after configuration", "error", err)
		}
	}
	if old != nil && old != repo {
		_ = old.Close()
	}
	s.Wake()
}

func (s *Service) Disable() {
	s.mu.Lock()
	old := s.repo
	s.repo = nil
	s.mu.Unlock()
	if old != nil {
		_ = old.Close()
	}
}

func (s *Service) Close() error {
	close(s.stop)
	<-s.done
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.repo != nil {
		err := s.repo.Close()
		s.repo = nil
		return err
	}
	return nil
}

func (s *Service) Enabled() bool { s.mu.RLock(); defer s.mu.RUnlock(); return s.repo != nil }
func (s *Service) repository() (Repository, int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.repo == nil {
		return nil, 0, errors.New("alerting is not configured")
	}
	return s.repo, s.historyLimit, nil
}
func (s *Service) Wake() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Service) loop() {
	defer close(s.done)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-ticker.C:
			s.schedule()
		case <-s.wake:
			s.schedule()
		}
	}
}

func (s *Service) schedule() {
	repo, _, err := s.repository()
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	rules, err := repo.Rules(ctx)
	cancel()
	if err != nil {
		s.log.Error("load alert rules", "error", err)
		return
	}
	now := time.Now().UTC()
	for _, rule := range rules {
		if !rule.Enabled || rule.IntervalSeconds < 1 {
			continue
		}
		if rule.LastEvaluatedAt != nil && now.Before(rule.LastEvaluatedAt.Add(time.Duration(rule.IntervalSeconds)*time.Second)) {
			continue
		}
		s.mu.Lock()
		if s.running[rule.ID] {
			s.mu.Unlock()
			continue
		}
		s.running[rule.ID] = true
		s.mu.Unlock()
		go func(rule Rule, expected Repository) {
			defer func() { s.mu.Lock(); delete(s.running, rule.ID); s.mu.Unlock() }()
			s.evaluate(expected, rule)
		}(rule, repo)
	}
}

func (s *Service) evaluate(repo Repository, rule Rule) {
	deadline := time.Duration(rule.IntervalSeconds) * time.Second
	if deadline > 30*time.Second {
		deadline = 30 * time.Second
	}
	if deadline < 2*time.Second {
		deadline = 2 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), deadline)
	s.mu.RLock()
	executor := s.executor
	s.mu.RUnlock()
	if executor == nil {
		cancel()
		return
	}
	result, err := executor.Evaluate(ctx, rule.Cluster, rule.SQL)
	cancel()
	now := time.Now().UTC()
	state := RuleState{State: rule.State, ActiveSince: rule.ActiveSince, LastEvaluatedAt: now, LastDeliveredAt: rule.LastDeliveredAt, LastValue: result.Value}
	if state.State == StatePending && (rule.LastEvaluatedAt == nil || now.Sub(*rule.LastEvaluatedAt) > 2*time.Duration(rule.IntervalSeconds)*time.Second) {
		state.State, state.ActiveSince = StateInactive, nil
	}
	if err != nil {
		state.LastError = truncate(err.Error(), 1000)
		if state.State == StatePending {
			state.State, state.ActiveSince = StateInactive, nil
		}
		if updateErr := repo.UpdateRuleState(context.Background(), rule.ID, state); updateErr != nil {
			s.log.Error("store alert evaluation error", "rule", rule.ID, "error", updateErr)
		}
		return
	}
	if result.Active {
		if state.State == StateInactive || state.State == "" {
			state.State = StatePending
			state.ActiveSince = &now
		}
		if state.ActiveSince == nil {
			value := now
			state.ActiveSince = &value
		}
		if state.State == StatePending && now.Sub(*state.ActiveSince) >= time.Duration(rule.ForSeconds)*time.Second {
			state.State = StateFiring
			s.emit(repo, rule, &state, "firing", nil)
		} else if state.State == StateFiring && rule.RepeatIntervalSeconds > 0 {
			if state.LastDeliveredAt == nil || now.Sub(*state.LastDeliveredAt) >= time.Duration(rule.RepeatIntervalSeconds)*time.Second {
				s.emit(repo, rule, &state, "firing", nil)
			}
		}
	} else {
		if state.State == StateFiring {
			ended := now
			s.emit(repo, rule, &state, "resolved", &ended)
			state.LastDeliveredAt = nil
		}
		state.State, state.ActiveSince = StateInactive, nil
	}
	if err = repo.UpdateRuleState(context.Background(), rule.ID, state); err != nil {
		s.log.Error("store alert state", "rule", rule.ID, "error", err)
	}
}

func (s *Service) emit(repo Repository, rule Rule, state *RuleState, status string, ended *time.Time) {
	started := state.LastEvaluatedAt
	if state.ActiveSince != nil {
		started = *state.ActiveSince
	}
	event, err := repo.CreateEvent(context.Background(), Event{RuleID: rule.ID, RuleName: rule.Name, Cluster: rule.Cluster, Status: status, Value: state.LastValue, StartedAt: started, EndedAt: ended, CreatedAt: time.Now().UTC()})
	if err != nil {
		s.log.Error("store alert event", "rule", rule.ID, "error", err)
		return
	}
	now := time.Now().UTC()
	if rule.SilencedUntil != nil && now.Before(*rule.SilencedUntil) {
		s.log.Info("alert is silenced; skipping delivery", "rule", rule.ID, "silenced_until", rule.SilencedUntil)
		return
	}
	if rule.WebhookID != nil {
		webhook, fetchErr := repo.Webhook(context.Background(), *rule.WebhookID)
		if fetchErr != nil {
			s.log.Error("load alert webhook", "rule", rule.ID, "error", fetchErr)
		} else {
			s.deliver(repo, rule, event, webhook)
			state.LastDeliveredAt = &now
		}
	}
	s.mu.RLock()
	limit := s.historyLimit
	s.mu.RUnlock()
	if err = repo.Prune(context.Background(), limit); err != nil {
		s.log.Error("prune alert history", "error", err)
	}
}

func (s *Service) deliver(repo Repository, rule Rule, event Event, webhook Webhook) {
	targetURL, err := s.codec.Decrypt(webhook.TargetEncrypted)
	if err != nil {
		s.storeDelivery(repo, rule, event, webhook, SendResult{Err: err})
		return
	}
	authorization := ""
	if webhook.AuthEncrypted != "" {
		authorization, err = s.codec.Decrypt(webhook.AuthEncrypted)
		if err != nil {
			s.storeDelivery(repo, rule, event, webhook, SendResult{Err: err})
			return
		}
	}
	labels := map[string]string{"alertname": rule.Name, "rule_id": strconv.FormatInt(rule.ID, 10), "cluster": rule.Cluster}
	payload := Payload{Version: "1", GroupKey: fmt.Sprintf("rule:%d", rule.ID), Status: event.Status, Receiver: webhook.Name, GroupLabels: labels, CommonLabels: labels, Alerts: []PayloadAlert{{Status: event.Status, Labels: labels, Annotations: map[string]string{"summary": rule.Name, "sql": rule.SQL, "value": event.Value}, StartsAt: event.StartedAt, EndsAt: event.EndedAt}}}
	result := s.sender.Send(context.Background(), WebhookTarget{Name: webhook.Name, URL: targetURL, Authorization: authorization, ChannelType: webhook.ChannelType}, payload)
	s.storeDelivery(repo, rule, event, webhook, result)
}

func (s *Service) storeDelivery(repo Repository, rule Rule, event Event, webhook Webhook, result SendResult) {
	now := time.Now().UTC()
	status := "sent"
	errorText := ""
	if result.Err != nil {
		status = "failed"
		if result.StatusCode > 0 {
			errorText = fmt.Sprintf("webhook returned HTTP %d", result.StatusCode)
		} else {
			errorText = "webhook request failed"
		}
	}
	_, err := repo.CreateDelivery(context.Background(), Delivery{EventID: event.ID, RuleID: rule.ID, RuleName: rule.Name, WebhookID: webhook.ID, WebhookName: webhook.Name, Status: status, HTTPStatus: result.StatusCode, Error: errorText, ResponseBody: result.Body, CreatedAt: now, SentAt: &now})
	if err != nil {
		s.log.Error("store webhook delivery", "rule", rule.ID, "error", err)
	}
}

func (s *Service) TestWebhook(ctx context.Context, id int64) (SendResult, error) {
	repo, _, err := s.repository()
	if err != nil {
		return SendResult{}, err
	}
	webhook, err := repo.Webhook(ctx, id)
	if err != nil {
		return SendResult{}, err
	}
	targetURL, err := s.codec.Decrypt(webhook.TargetEncrypted)
	if err != nil {
		return SendResult{}, fmt.Errorf("decrypt webhook target: %w", err)
	}
	authorization := ""
	if webhook.AuthEncrypted != "" {
		authorization, err = s.codec.Decrypt(webhook.AuthEncrypted)
		if err != nil {
			return SendResult{}, fmt.Errorf("decrypt webhook authorization: %w", err)
		}
	}
	now := time.Now().UTC()
	labels := map[string]string{"alertname": "测试报警规则", "rule_id": "0", "cluster": "test"}
	payload := Payload{
		Version:      "1",
		GroupKey:     "rule:0",
		Status:       "firing",
		Receiver:     webhook.Name,
		GroupLabels:  labels,
		CommonLabels: labels,
		Alerts: []PayloadAlert{{
			Status:      "firing",
			Labels:      labels,
			Annotations: map[string]string{"summary": "这是一条来自 ClickHouse Console 的 Webhook 测试消息", "sql": "SELECT 1", "value": "1"},
			StartsAt:    now,
		}},
	}
	result := s.sender.Send(ctx, WebhookTarget{Name: webhook.Name, URL: targetURL, Authorization: authorization, ChannelType: webhook.ChannelType}, payload)
	dummyRule := Rule{ID: 0, Name: "Webhook 测试"}
	dummyEvent := Event{ID: 0, Status: "firing", Value: "1", StartedAt: now}
	s.storeDelivery(repo, dummyRule, dummyEvent, webhook, result)
	return result, nil
}

func (s *Service) Rules(ctx context.Context) ([]Rule, error) {
	repo, _, err := s.repository()
	if err != nil {
		return nil, err
	}
	return repo.Rules(ctx)
}
func (s *Service) CreateRule(ctx context.Context, input RuleInput) (Rule, error) {
	if err := validateRule(input); err != nil {
		return Rule{}, err
	}
	repo, _, err := s.repository()
	if err != nil {
		return Rule{}, err
	}
	item, err := repo.CreateRule(ctx, input)
	s.Wake()
	return item, err
}
func (s *Service) UpdateRule(ctx context.Context, id int64, input RuleInput) (Rule, error) {
	if err := validateRule(input); err != nil {
		return Rule{}, err
	}
	repo, _, err := s.repository()
	if err != nil {
		return Rule{}, err
	}
	item, err := repo.UpdateRule(ctx, id, input)
	s.Wake()
	return item, err
}
func (s *Service) DeleteRule(ctx context.Context, id int64) error {
	repo, _, err := s.repository()
	if err != nil {
		return err
	}
	return repo.DeleteRule(ctx, id)
}
func (s *Service) Webhooks(ctx context.Context) ([]Webhook, error) {
	repo, _, err := s.repository()
	if err != nil {
		return nil, err
	}
	return repo.Webhooks(ctx)
}
func (s *Service) CreateWebhook(ctx context.Context, name, channelType, target, authorization string) (Webhook, error) {
	input, err := s.webhookInput(name, channelType, target, authorization)
	if err != nil {
		return Webhook{}, err
	}
	repo, _, err := s.repository()
	if err != nil {
		return Webhook{}, err
	}
	return repo.CreateWebhook(ctx, input)
}
func (s *Service) UpdateWebhook(ctx context.Context, id int64, name, channelType, target, authorization string, updateTarget bool) (Webhook, error) {
	if !updateTarget {
		if strings.TrimSpace(name) == "" {
			return Webhook{}, errors.New("webhook name is required")
		}
		repo, _, err := s.repository()
		if err != nil {
			return Webhook{}, err
		}
		return repo.UpdateWebhook(ctx, id, WebhookInput{Name: strings.TrimSpace(name), ChannelType: strings.ToLower(strings.TrimSpace(channelType))}, false)
	}
	input, err := s.webhookInput(name, channelType, target, authorization)
	if err != nil {
		return Webhook{}, err
	}
	repo, _, err := s.repository()
	if err != nil {
		return Webhook{}, err
	}
	return repo.UpdateWebhook(ctx, id, input, true)
}
func (s *Service) DeleteWebhook(ctx context.Context, id int64) error {
	repo, _, err := s.repository()
	if err != nil {
		return err
	}
	return repo.DeleteWebhook(ctx, id)
}
func (s *Service) Events(ctx context.Context, limit int) ([]Event, error) {
	repo, max, err := s.repository()
	if err != nil {
		return nil, err
	}
	return repo.Events(ctx, normalizeLimit(limit, max))
}
func (s *Service) Deliveries(ctx context.Context, limit int) ([]Delivery, error) {
	repo, max, err := s.repository()
	if err != nil {
		return nil, err
	}
	return repo.Deliveries(ctx, normalizeLimit(limit, max))
}

func (s *Service) webhookInput(name, channelType, target, authorization string) (WebhookInput, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 200 {
		return WebhookInput{}, errors.New("webhook name must be 1-200 characters")
	}
	channelType = strings.ToLower(strings.TrimSpace(channelType))
	if channelType == "" {
		channelType = "generic"
	}
	if channelType != "generic" && channelType != "wecom" && channelType != "feishu" && channelType != "dingtalk" && channelType != "slack" {
		return WebhookInput{}, fmt.Errorf("unsupported channel type %q", channelType)
	}
	parsed, err := url.Parse(strings.TrimSpace(target))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil {
		return WebhookInput{}, errors.New("webhook URL must be a valid http(s) URL without embedded credentials")
	}
	encrypted, err := s.codec.Encrypt(parsed.String())
	if err != nil {
		return WebhookInput{}, err
	}
	authEncrypted := ""
	if authorization != "" {
		if len(authorization) > 2048 {
			return WebhookInput{}, errors.New("authorization header is too long")
		}
		authEncrypted, err = s.codec.Encrypt(authorization)
		if err != nil {
			return WebhookInput{}, err
		}
	}
	hint := parsed.Scheme + "://" + parsed.Host
	return WebhookInput{Name: name, ChannelType: channelType, URLHint: hint, TargetEncrypted: encrypted, AuthEncrypted: authEncrypted, AuthConfigured: authorization != ""}, nil
}
func validateRule(input RuleInput) error {
	if strings.TrimSpace(input.Name) == "" || len(input.Name) > 200 {
		return errors.New("rule name must be 1-200 characters")
	}
	if strings.TrimSpace(input.Cluster) == "" || len(input.Cluster) > 64 {
		return errors.New("cluster is required")
	}
	if strings.TrimSpace(input.SQL) == "" || len(input.SQL) > 65535 {
		return errors.New("SQL must be 1-65535 characters")
	}
	if input.IntervalSeconds < 5 || input.IntervalSeconds > 86400 {
		return errors.New("evaluation interval must be between 5 seconds and 24 hours")
	}
	if input.ForSeconds < 0 || input.ForSeconds > 2592000 {
		return errors.New("for duration must be between 0 and 30 days")
	}
	if input.RepeatIntervalSeconds < 0 || input.RepeatIntervalSeconds > 2592000 {
		return errors.New("repeat interval must be between 0 and 30 days")
	}
	return nil
}
func normalizeLimit(value, max int) int {
	if value < 1 || value > max {
		return max
	}
	return value
}
func truncate(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[:max]
}
