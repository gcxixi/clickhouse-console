package alerting

import (
	"context"
	"io"
	"log/slog"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func openTestRepository(t *testing.T) *SQLRepository {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "alerts.db") + "?_pragma=busy_timeout(5000)"
	repo, err := OpenRepository(context.Background(), "sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	return repo
}

func TestSQLRepositoryRuleLifecycleAndPrune(t *testing.T) {
	repo := openTestRepository(t)
	ctx := context.Background()
	webhook, err := repo.CreateWebhook(ctx, WebhookInput{Name: "primary", URLHint: "https://example.test/hook", TargetEncrypted: "ciphertext", AuthConfigured: true, AuthEncrypted: "auth"})
	if err != nil {
		t.Fatal(err)
	}
	rule, err := repo.CreateRule(ctx, RuleInput{Name: "errors", Cluster: "default", SQL: "SELECT 1", IntervalSeconds: 60, ForSeconds: 30, WebhookID: &webhook.ID, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if rule.ID != 1 || rule.State != StateInactive || !rule.Enabled {
		t.Fatalf("unexpected rule: %#v", rule)
	}
	now := time.Now().UTC()
	if err = repo.UpdateRuleState(ctx, rule.ID, RuleState{State: StatePending, ActiveSince: &now, LastEvaluatedAt: now, LastValue: "1"}); err != nil {
		t.Fatal(err)
	}
	updated, err := repo.Rule(ctx, rule.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.State != StatePending || updated.ActiveSince == nil {
		t.Fatalf("state not persisted: %#v", updated)
	}
	for i := 0; i < 5; i++ {
		if _, err = repo.CreateEvent(ctx, Event{RuleID: rule.ID, RuleName: rule.Name, Cluster: rule.Cluster, Status: "firing", Value: "1", StartedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	if err = repo.Prune(ctx, 3); err != nil {
		t.Fatal(err)
	}
	events, err := repo.Events(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 {
		t.Fatalf("events after prune = %d", len(events))
	}
	if err = repo.DeleteWebhook(ctx, webhook.ID); err == nil {
		t.Fatal("used webhook should not be deletable")
	}
	if err = repo.DeleteRule(ctx, rule.ID); err != nil {
		t.Fatal(err)
	}
	if err = repo.DeleteWebhook(ctx, webhook.ID); err != nil {
		t.Fatal(err)
	}
}

type fakeExecutor struct {
	mu     sync.Mutex
	active bool
	value  string
}

func (f *fakeExecutor) Evaluate(context.Context, string, string) (Evaluation, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return Evaluation{Active: f.active, Value: f.value}, nil
}

type fakeSender struct {
	mu       sync.Mutex
	payloads []Payload
}

func (f *fakeSender) Send(_ context.Context, _ WebhookTarget, payload Payload) SendResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.payloads = append(f.payloads, payload)
	return SendResult{StatusCode: 204}
}

func TestServiceForStateMachineSendsFiringAndResolved(t *testing.T) {
	repo := openTestRepository(t)
	codec, err := NewSecretCodec(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	target, err := codec.Encrypt("https://example.test/hook")
	if err != nil {
		t.Fatal(err)
	}
	webhook, err := repo.CreateWebhook(context.Background(), WebhookInput{Name: "primary", URLHint: "https://example.test/hook", TargetEncrypted: target})
	if err != nil {
		t.Fatal(err)
	}
	rule, err := repo.CreateRule(context.Background(), RuleInput{Name: "queue backlog", Cluster: "default", SQL: "SELECT 1", IntervalSeconds: 60, ForSeconds: 0, WebhookID: &webhook.ID, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	executor := &fakeExecutor{active: true, value: "1"}
	sender := &fakeSender{}
	service := NewService(executor, sender, codec, slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer service.Close()
	service.evaluate(repo, rule)
	firing, err := repo.Rule(context.Background(), rule.ID)
	if err != nil {
		t.Fatal(err)
	}
	if firing.State != StateFiring {
		t.Fatalf("state = %s", firing.State)
	}
	executor.mu.Lock()
	executor.active = false
	executor.value = "0"
	executor.mu.Unlock()
	service.evaluate(repo, firing)
	resolved, err := repo.Rule(context.Background(), rule.ID)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.State != StateInactive {
		t.Fatalf("state = %s", resolved.State)
	}
	events, err := repo.Events(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 || events[0].Status != "resolved" || events[1].Status != "firing" {
		t.Fatalf("events = %#v", events)
	}
	sender.mu.Lock()
	defer sender.mu.Unlock()
	if len(sender.payloads) != 2 || sender.payloads[0].Status != "firing" || sender.payloads[1].Status != "resolved" {
		t.Fatalf("payloads = %#v", sender.payloads)
	}
}

func TestServiceResetsStalePendingWindow(t *testing.T) {
	repo := openTestRepository(t)
	rule, err := repo.CreateRule(context.Background(), RuleInput{Name: "stale", Cluster: "default", SQL: "SELECT 1", IntervalSeconds: 60, ForSeconds: 600, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	activeSince := time.Now().Add(-20 * time.Minute)
	lastEvaluation := time.Now().Add(-5 * time.Minute)
	if err = repo.UpdateRuleState(context.Background(), rule.ID, RuleState{State: StatePending, ActiveSince: &activeSince, LastEvaluatedAt: lastEvaluation, LastValue: "1"}); err != nil {
		t.Fatal(err)
	}
	rule, err = repo.Rule(context.Background(), rule.ID)
	if err != nil {
		t.Fatal(err)
	}
	codec, _ := NewSecretCodec(make([]byte, 32))
	service := NewService(&fakeExecutor{active: true, value: "1"}, &fakeSender{}, codec, slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer service.Close()
	service.evaluate(repo, rule)
	updated, err := repo.Rule(context.Background(), rule.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.State != StatePending || updated.ActiveSince == nil || updated.ActiveSince.Before(time.Now().Add(-time.Minute)) {
		t.Fatalf("pending window was not restarted: %#v", updated)
	}
}
