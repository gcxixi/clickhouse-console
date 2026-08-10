package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gcxixi/clickhouse-console/internal/alertconfig"
	"github.com/gcxixi/clickhouse-console/internal/alerting"
	ch "github.com/gcxixi/clickhouse-console/internal/clickhouse"
	"github.com/gcxixi/clickhouse-console/internal/store"
)

type alertQueryExecutor struct{ s *Server }

func (e alertQueryExecutor) Evaluate(ctx context.Context, cluster, statement string) (alerting.Evaluation, error) {
	kind, err := ch.Classify(statement)
	if err != nil {
		return alerting.Evaluation{}, err
	}
	if kind != "query" {
		return alerting.Evaluation{}, errors.New("alert SQL must be read-only")
	}
	client, ok := e.s.clusterClient(cluster)
	if !ok {
		return alerting.Evaluation{}, fmt.Errorf("cluster %q not found", cluster)
	}
	result, err := client.Execute(ctx, statement)
	if err != nil {
		return alerting.Evaluation{}, err
	}
	if len(result.Data) == 0 || len(result.Meta) == 0 {
		return alerting.Evaluation{Value: "no rows"}, nil
	}
	value := result.Data[0][result.Meta[0].Name]
	active, display, err := alertValue(value)
	return alerting.Evaluation{Active: active, Value: display}, err
}

func alertValue(value any) (bool, string, error) {
	display := fmt.Sprint(value)
	switch typed := value.(type) {
	case bool:
		return typed, display, nil
	case float64:
		return typed != 0, display, nil
	case float32:
		return typed != 0, display, nil
	case int:
		return typed != 0, display, nil
	case int64:
		return typed != 0, display, nil
	case json.Number:
		number, err := typed.Float64()
		return number != 0, display, err
	case string:
		normalized := strings.ToLower(strings.TrimSpace(typed))
		if normalized == "true" || normalized == "yes" || normalized == "firing" || normalized == "1" {
			return true, typed, nil
		}
		if normalized == "false" || normalized == "no" || normalized == "inactive" || normalized == "0" || normalized == "" {
			return false, typed, nil
		}
		if number, err := strconv.ParseFloat(normalized, 64); err == nil {
			return number != 0, typed, nil
		}
		return false, typed, errors.New("first alert query value must be boolean or numeric")
	case nil:
		return false, "NULL", nil
	default:
		return false, display, errors.New("first alert query value must be scalar")
	}
}

type alertingConfigRequest struct {
	Enabled        bool               `json:"enabled"`
	Driver         string             `json:"driver"`
	HistoryLimit   int                `json:"history_limit"`
	UpdateDatabase bool               `json:"update_database"`
	Database       credentialEnvelope `json:"database"`
}

func (s *Server) alertingConfig(w http.ResponseWriter, r *http.Request) {
	if s.alertEnvironment != nil {
		writeJSON(w, 200, alertconfig.Public{Enabled: s.alertEnvironment.Enabled, Configured: s.alertEnvironment.Configured, Driver: s.alertEnvironment.Driver, Source: "environment", HistoryLimit: s.alertEnvironment.HistoryLimit, CredentialsConfigured: s.alertEnvironment.DSN != "", Running: s.alerts.Enabled(), Error: s.alertStartupError})
		return
	}
	output := s.alertConfig.Public()
	output.Running = s.alerts.Enabled()
	output.Error = s.alertStartupError
	writeJSON(w, 200, output)
}

func (s *Server) updateAlertingConfig(w http.ResponseWriter, r *http.Request) {
	if s.alertEnvironment != nil {
		writeErr(w, 409, "environment-managed alerting configuration is read-only")
		return
	}
	var input alertingConfigRequest
	if !decode(w, r, &input) {
		return
	}
	current, err := s.alertConfig.Config()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	dsn := current.DSN
	if input.UpdateDatabase {
		plain, decryptErr := s.decryptEnvelope(input.Database)
		if decryptErr != nil {
			writeErr(w, 400, decryptErr.Error())
			return
		}
		defer clear(plain)
		var secret struct {
			Secret string `json:"secret"`
		}
		if json.Unmarshal(plain, &secret) != nil || strings.TrimSpace(secret.Secret) == "" {
			writeErr(w, 400, "invalid encrypted database configuration")
			return
		}
		dsn = secret.Secret
	} else if current.Configured && input.Driver != current.Driver {
		writeErr(w, 400, "database connection must be updated when changing driver")
		return
	}
	var repo alerting.Repository
	if input.Enabled {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		repo, err = alerting.OpenRepository(ctx, input.Driver, dsn)
		cancel()
		if err != nil {
			s.log.Error("update alerting database connection", "driver", input.Driver, "error", err)
			writeErr(w, 400, "unable to connect to alerting database; see server logs")
			return
		}
	}
	config, err := s.alertConfig.Save(input.Enabled, input.Driver, dsn, input.HistoryLimit, input.UpdateDatabase)
	if err != nil {
		if repo != nil {
			_ = repo.Close()
		}
		writeErr(w, 400, err.Error())
		return
	}
	if config.Enabled {
		s.alerts.Configure(repo, config.HistoryLimit)
	} else {
		s.alerts.Disable()
	}
	s.alertStartupError = ""
	ss, _ := getSession(r)
	s.db.AddAudit(store.Audit{User: ss.User.Username, Cluster: ss.ActiveCluster, Action: "alerting.config", Statement: config.Driver, Status: "ok", RemoteAddr: remote(r)})
	output := s.alertConfig.Public()
	output.Running = s.alerts.Enabled()
	writeJSON(w, 200, output)
}

func (s *Server) alertRules(w http.ResponseWriter, r *http.Request) {
	items, err := s.alerts.Rules(r.Context())
	if err != nil {
		writeErr(w, 409, err.Error())
		return
	}
	writeJSON(w, 200, items)
}
func (s *Server) createAlertRule(w http.ResponseWriter, r *http.Request) {
	var input alerting.RuleInput
	if !decode(w, r, &input) {
		return
	}
	if err := s.validateAlertRule(input); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	item, err := s.alerts.CreateRule(r.Context(), input)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	s.auditAlert(r, "alert.rule.create", fmt.Sprintf("#%d %s", item.ID, item.Name))
	writeJSON(w, 201, item)
}
func (s *Server) updateAlertRule(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var input alerting.RuleInput
	if !decode(w, r, &input) {
		return
	}
	if err := s.validateAlertRule(input); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	item, err := s.alerts.UpdateRule(r.Context(), id, input)
	if err != nil {
		alertingError(w, err)
		return
	}
	s.auditAlert(r, "alert.rule.update", fmt.Sprintf("#%d %s", item.ID, item.Name))
	writeJSON(w, 200, item)
}
func (s *Server) deleteAlertRule(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := s.alerts.DeleteRule(r.Context(), id); err != nil {
		alertingError(w, err)
		return
	}
	s.auditAlert(r, "alert.rule.delete", fmt.Sprintf("#%d", id))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) validateAlertRule(input alerting.RuleInput) error {
	kind, err := ch.Classify(input.SQL)
	if err != nil {
		return err
	}
	if kind != "query" {
		return errors.New("alert SQL must be read-only")
	}
	if _, ok := s.clusterClient(input.Cluster); !ok {
		return errors.New("selected cluster does not exist")
	}
	if input.WebhookID != nil {
		webhooks, fetchErr := s.alerts.Webhooks(context.Background())
		if fetchErr != nil {
			return fetchErr
		}
		found := false
		for _, item := range webhooks {
			if item.ID == *input.WebhookID {
				found = true
				break
			}
		}
		if !found {
			return errors.New("selected webhook does not exist")
		}
	}
	return nil
}

type webhookRequest struct {
	Name         string             `json:"name"`
	UpdateTarget bool               `json:"update_target"`
	Target       credentialEnvelope `json:"target"`
}

func (s *Server) alertWebhooks(w http.ResponseWriter, r *http.Request) {
	items, err := s.alerts.Webhooks(r.Context())
	if err != nil {
		writeErr(w, 409, err.Error())
		return
	}
	writeJSON(w, 200, items)
}
func (s *Server) createAlertWebhook(w http.ResponseWriter, r *http.Request) {
	var input webhookRequest
	if !decode(w, r, &input) {
		return
	}
	target, auth, err := s.decryptWebhookTarget(input.Target)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	item, err := s.alerts.CreateWebhook(r.Context(), input.Name, target, auth)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	s.auditAlert(r, "alert.webhook.create", fmt.Sprintf("#%d %s", item.ID, item.Name))
	writeJSON(w, 201, item)
}
func (s *Server) updateAlertWebhook(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var input webhookRequest
	if !decode(w, r, &input) {
		return
	}
	target, auth := "", ""
	var err error
	if input.UpdateTarget {
		target, auth, err = s.decryptWebhookTarget(input.Target)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
	}
	item, err := s.alerts.UpdateWebhook(r.Context(), id, input.Name, target, auth, input.UpdateTarget)
	if err != nil {
		alertingError(w, err)
		return
	}
	s.auditAlert(r, "alert.webhook.update", fmt.Sprintf("#%d %s", item.ID, item.Name))
	writeJSON(w, 200, item)
}
func (s *Server) deleteAlertWebhook(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := s.alerts.DeleteWebhook(r.Context(), id); err != nil {
		alertingError(w, err)
		return
	}
	s.auditAlert(r, "alert.webhook.delete", fmt.Sprintf("#%d", id))
	w.WriteHeader(http.StatusNoContent)
}
func (s *Server) decryptWebhookTarget(envelope credentialEnvelope) (string, string, error) {
	plain, err := s.decryptEnvelope(envelope)
	if err != nil {
		return "", "", err
	}
	defer clear(plain)
	var target struct {
		URL           string `json:"url"`
		Authorization string `json:"authorization"`
	}
	if json.Unmarshal(plain, &target) != nil || strings.TrimSpace(target.URL) == "" {
		return "", "", errors.New("invalid encrypted webhook target")
	}
	return target.URL, target.Authorization, nil
}

func (s *Server) alertEvents(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	items, err := s.alerts.Events(r.Context(), limit)
	if err != nil {
		writeErr(w, 409, err.Error())
		return
	}
	writeJSON(w, 200, items)
}
func (s *Server) alertDeliveries(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	items, err := s.alerts.Deliveries(r.Context(), limit)
	if err != nil {
		writeErr(w, 409, err.Error())
		return
	}
	writeJSON(w, 200, items)
}

func pathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id < 1 {
		writeErr(w, 400, "invalid id")
		return 0, false
	}
	return id, true
}
func alertingError(w http.ResponseWriter, err error) {
	if errors.Is(err, alerting.ErrNotFound) {
		writeErr(w, 404, err.Error())
	} else {
		writeErr(w, 400, err.Error())
	}
}
func (s *Server) auditAlert(r *http.Request, action, statement string) {
	ss, _ := getSession(r)
	s.db.AddAudit(store.Audit{User: ss.User.Username, Cluster: ss.ActiveCluster, Action: action, Statement: statement, Status: "ok", RemoteAddr: remote(r)})
}
