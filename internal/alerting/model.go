package alerting

import (
	"context"
	"time"
)

const (
	StateInactive = "inactive"
	StatePending  = "pending"
	StateFiring   = "firing"
)

type Rule struct {
	ID              int64      `json:"id"`
	Name            string     `json:"name"`
	Cluster         string     `json:"cluster"`
	SQL             string     `json:"sql"`
	IntervalSeconds int64      `json:"interval_seconds"`
	ForSeconds      int64      `json:"for_seconds"`
	WebhookID       *int64     `json:"webhook_id,omitempty"`
	Enabled         bool       `json:"enabled"`
	State           string     `json:"state"`
	ActiveSince     *time.Time `json:"active_since,omitempty"`
	LastEvaluatedAt *time.Time `json:"last_evaluated_at,omitempty"`
	LastValue       string     `json:"last_value,omitempty"`
	LastError       string     `json:"last_error,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

type RuleInput struct {
	Name            string `json:"name"`
	Cluster         string `json:"cluster"`
	SQL             string `json:"sql"`
	IntervalSeconds int64  `json:"interval_seconds"`
	ForSeconds      int64  `json:"for_seconds"`
	WebhookID       *int64 `json:"webhook_id"`
	Enabled         bool   `json:"enabled"`
}

type Webhook struct {
	ID                 int64     `json:"id"`
	Name               string    `json:"name"`
	URLHint            string    `json:"url_hint"`
	TargetEncrypted    string    `json:"-"`
	AuthEncrypted      string    `json:"-"`
	AuthConfigured     bool      `json:"auth_configured"`
	CredentialsPresent bool      `json:"credentials_configured"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

type WebhookInput struct {
	Name            string
	URLHint         string
	TargetEncrypted string
	AuthEncrypted   string
	AuthConfigured  bool
}

type Event struct {
	ID        int64      `json:"id"`
	RuleID    int64      `json:"rule_id"`
	RuleName  string     `json:"rule_name"`
	Cluster   string     `json:"cluster"`
	Status    string     `json:"status"`
	Value     string     `json:"value"`
	StartedAt time.Time  `json:"started_at"`
	EndedAt   *time.Time `json:"ended_at,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
}

type Delivery struct {
	ID           int64      `json:"id"`
	EventID      int64      `json:"event_id"`
	RuleID       int64      `json:"rule_id"`
	RuleName     string     `json:"rule_name"`
	WebhookID    int64      `json:"webhook_id"`
	WebhookName  string     `json:"webhook_name"`
	Status       string     `json:"status"`
	HTTPStatus   int        `json:"http_status"`
	Error        string     `json:"error,omitempty"`
	ResponseBody string     `json:"response_body,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	SentAt       *time.Time `json:"sent_at,omitempty"`
}

type RuleState struct {
	State           string
	ActiveSince     *time.Time
	LastEvaluatedAt time.Time
	LastValue       string
	LastError       string
}

type Repository interface {
	Rules(context.Context) ([]Rule, error)
	Rule(context.Context, int64) (Rule, error)
	CreateRule(context.Context, RuleInput) (Rule, error)
	UpdateRule(context.Context, int64, RuleInput) (Rule, error)
	DeleteRule(context.Context, int64) error
	UpdateRuleState(context.Context, int64, RuleState) error

	Webhooks(context.Context) ([]Webhook, error)
	Webhook(context.Context, int64) (Webhook, error)
	CreateWebhook(context.Context, WebhookInput) (Webhook, error)
	UpdateWebhook(context.Context, int64, WebhookInput, bool) (Webhook, error)
	DeleteWebhook(context.Context, int64) error

	CreateEvent(context.Context, Event) (Event, error)
	Events(context.Context, int) ([]Event, error)
	CreateDelivery(context.Context, Delivery) (Delivery, error)
	Deliveries(context.Context, int) ([]Delivery, error)
	Prune(context.Context, int) error
	Close() error
}

type Evaluation struct {
	Active bool
	Value  string
}

type Executor interface {
	Evaluate(context.Context, string, string) (Evaluation, error)
}

type Sender interface {
	Send(context.Context, WebhookTarget, Payload) SendResult
}

type WebhookTarget struct {
	Name, URL, Authorization string
}

type SendResult struct {
	StatusCode int
	Body       string
	Err        error
}
