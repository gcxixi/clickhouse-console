package alerting

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("alerting record not found")

type SQLRepository struct {
	db      *sql.DB
	dialect string
}

func OpenRepository(ctx context.Context, driver, dsn string) (*SQLRepository, error) {
	driver = strings.ToLower(strings.TrimSpace(driver))
	dbDriver := map[string]string{"sqlite": "sqlite", "postgres": "pgx", "mysql": "mysql"}[driver]
	if dbDriver == "" {
		return nil, fmt.Errorf("unsupported alerting database driver %q", driver)
	}
	db, err := sql.Open(dbDriver, dsn)
	if err != nil {
		return nil, err
	}
	if driver == "sqlite" {
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
	} else {
		db.SetMaxOpenConns(8)
		db.SetMaxIdleConns(2)
	}
	db.SetConnMaxLifetime(30 * time.Minute)
	if err = db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("connect alerting database: %w", err)
	}
	repo := &SQLRepository{db: db, dialect: driver}
	if err = repo.migrate(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate alerting database: %w", err)
	}
	return repo, nil
}

func (r *SQLRepository) Close() error { return r.db.Close() }

func (r *SQLRepository) migrate(ctx context.Context) error {
	id := "INTEGER PRIMARY KEY AUTOINCREMENT"
	if r.dialect == "postgres" {
		id = "BIGSERIAL PRIMARY KEY"
	} else if r.dialect == "mysql" {
		id = "BIGINT AUTO_INCREMENT PRIMARY KEY"
	}
	statements := []string{
		fmt.Sprintf(`CREATE TABLE IF NOT EXISTS alert_webhooks (
            id %s, name VARCHAR(200) NOT NULL, url_hint VARCHAR(500) NOT NULL,
            target_encrypted TEXT NOT NULL, auth_encrypted TEXT NOT NULL,
            auth_configured INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
        )`, id),
		fmt.Sprintf(`CREATE TABLE IF NOT EXISTS alert_rules (
            id %s, name VARCHAR(200) NOT NULL, cluster_alias VARCHAR(64) NOT NULL,
            sql_text TEXT NOT NULL, interval_seconds BIGINT NOT NULL, for_seconds BIGINT NOT NULL,
            webhook_id BIGINT NULL, enabled INTEGER NOT NULL DEFAULT 1, state VARCHAR(16) NOT NULL DEFAULT 'inactive',
            active_since BIGINT NULL, last_evaluated_at BIGINT NULL, last_value TEXT NOT NULL,
            last_error TEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
        )`, id),
		fmt.Sprintf(`CREATE TABLE IF NOT EXISTS alert_events (
            id %s, rule_id BIGINT NOT NULL, rule_name VARCHAR(200) NOT NULL, cluster_alias VARCHAR(64) NOT NULL,
            status VARCHAR(16) NOT NULL, value_text TEXT NOT NULL, started_at BIGINT NOT NULL,
            ended_at BIGINT NULL, created_at BIGINT NOT NULL
        )`, id),
		fmt.Sprintf(`CREATE TABLE IF NOT EXISTS alert_deliveries (
            id %s, event_id BIGINT NOT NULL, rule_id BIGINT NOT NULL, rule_name VARCHAR(200) NOT NULL,
            webhook_id BIGINT NOT NULL, webhook_name VARCHAR(200) NOT NULL, status VARCHAR(16) NOT NULL,
            http_status INTEGER NOT NULL, error_text TEXT NOT NULL, response_body TEXT NOT NULL,
            created_at BIGINT NOT NULL, sent_at BIGINT NULL
        )`, id),
	}
	for _, statement := range statements {
		if _, err := r.db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func (r *SQLRepository) bind(query string) string {
	if r.dialect != "postgres" {
		return query
	}
	var b strings.Builder
	n := 1
	for _, char := range query {
		if char == '?' {
			fmt.Fprintf(&b, "$%d", n)
			n++
		} else {
			b.WriteRune(char)
		}
	}
	return b.String()
}

func millis(t time.Time) int64             { return t.UTC().UnixMilli() }
func timeFromMillis(value int64) time.Time { return time.UnixMilli(value).UTC() }
func nullableMillis(t *time.Time) any {
	if t == nil {
		return nil
	}
	return millis(*t)
}
func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func (r *SQLRepository) Rules(ctx context.Context) ([]Rule, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id,name,cluster_alias,sql_text,interval_seconds,for_seconds,webhook_id,enabled,state,active_since,last_evaluated_at,last_value,last_error,created_at,updated_at FROM alert_rules ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []Rule
	for rows.Next() {
		item, err := scanRule(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (r *SQLRepository) Rule(ctx context.Context, id int64) (Rule, error) {
	row := r.db.QueryRowContext(ctx, r.bind(`SELECT id,name,cluster_alias,sql_text,interval_seconds,for_seconds,webhook_id,enabled,state,active_since,last_evaluated_at,last_value,last_error,created_at,updated_at FROM alert_rules WHERE id=?`), id)
	item, err := scanRule(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Rule{}, ErrNotFound
	}
	return item, err
}

type scanner interface{ Scan(...any) error }

func scanRule(row scanner) (Rule, error) {
	var item Rule
	var webhookID, activeSince, evaluated sql.NullInt64
	var enabled, created, updated int64
	err := row.Scan(&item.ID, &item.Name, &item.Cluster, &item.SQL, &item.IntervalSeconds, &item.ForSeconds, &webhookID, &enabled, &item.State, &activeSince, &evaluated, &item.LastValue, &item.LastError, &created, &updated)
	if err != nil {
		return Rule{}, err
	}
	item.Enabled = enabled != 0
	item.CreatedAt, item.UpdatedAt = timeFromMillis(created), timeFromMillis(updated)
	if webhookID.Valid {
		value := webhookID.Int64
		item.WebhookID = &value
	}
	if activeSince.Valid {
		value := timeFromMillis(activeSince.Int64)
		item.ActiveSince = &value
	}
	if evaluated.Valid {
		value := timeFromMillis(evaluated.Int64)
		item.LastEvaluatedAt = &value
	}
	return item, nil
}

func (r *SQLRepository) CreateRule(ctx context.Context, input RuleInput) (Rule, error) {
	now := time.Now().UTC()
	args := []any{input.Name, input.Cluster, input.SQL, input.IntervalSeconds, input.ForSeconds, input.WebhookID, boolInt(input.Enabled), StateInactive, "", "", millis(now), millis(now)}
	query := `INSERT INTO alert_rules(name,cluster_alias,sql_text,interval_seconds,for_seconds,webhook_id,enabled,state,last_value,last_error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
	id, err := r.insertID(ctx, query, args...)
	if err != nil {
		return Rule{}, err
	}
	return r.Rule(ctx, id)
}

func (r *SQLRepository) UpdateRule(ctx context.Context, id int64, input RuleInput) (Rule, error) {
	result, err := r.db.ExecContext(ctx, r.bind(`UPDATE alert_rules SET name=?,cluster_alias=?,sql_text=?,interval_seconds=?,for_seconds=?,webhook_id=?,enabled=?,state=?,active_since=NULL,last_error='',updated_at=? WHERE id=?`), input.Name, input.Cluster, input.SQL, input.IntervalSeconds, input.ForSeconds, input.WebhookID, boolInt(input.Enabled), StateInactive, millis(time.Now()), id)
	if err != nil {
		return Rule{}, err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return Rule{}, ErrNotFound
	}
	return r.Rule(ctx, id)
}

func (r *SQLRepository) DeleteRule(ctx context.Context, id int64) error {
	result, err := r.db.ExecContext(ctx, r.bind(`DELETE FROM alert_rules WHERE id=?`), id)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *SQLRepository) UpdateRuleState(ctx context.Context, id int64, state RuleState) error {
	_, err := r.db.ExecContext(ctx, r.bind(`UPDATE alert_rules SET state=?,active_since=?,last_evaluated_at=?,last_value=?,last_error=?,updated_at=? WHERE id=?`), state.State, nullableMillis(state.ActiveSince), millis(state.LastEvaluatedAt), state.LastValue, state.LastError, millis(time.Now()), id)
	return err
}

func (r *SQLRepository) Webhooks(ctx context.Context) ([]Webhook, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id,name,url_hint,target_encrypted,auth_encrypted,auth_configured,created_at,updated_at FROM alert_webhooks ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []Webhook
	for rows.Next() {
		item, err := scanWebhook(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (r *SQLRepository) Webhook(ctx context.Context, id int64) (Webhook, error) {
	item, err := scanWebhook(r.db.QueryRowContext(ctx, r.bind(`SELECT id,name,url_hint,target_encrypted,auth_encrypted,auth_configured,created_at,updated_at FROM alert_webhooks WHERE id=?`), id))
	if errors.Is(err, sql.ErrNoRows) {
		return Webhook{}, ErrNotFound
	}
	return item, err
}

func scanWebhook(row scanner) (Webhook, error) {
	var item Webhook
	var auth, created, updated int64
	err := row.Scan(&item.ID, &item.Name, &item.URLHint, &item.TargetEncrypted, &item.AuthEncrypted, &auth, &created, &updated)
	if err != nil {
		return Webhook{}, err
	}
	item.AuthConfigured = auth != 0
	item.CredentialsPresent = item.TargetEncrypted != ""
	item.CreatedAt, item.UpdatedAt = timeFromMillis(created), timeFromMillis(updated)
	return item, nil
}

func (r *SQLRepository) CreateWebhook(ctx context.Context, input WebhookInput) (Webhook, error) {
	now := time.Now().UTC()
	id, err := r.insertID(ctx, `INSERT INTO alert_webhooks(name,url_hint,target_encrypted,auth_encrypted,auth_configured,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, input.Name, input.URLHint, input.TargetEncrypted, input.AuthEncrypted, boolInt(input.AuthConfigured), millis(now), millis(now))
	if err != nil {
		return Webhook{}, err
	}
	return r.Webhook(ctx, id)
}

func (r *SQLRepository) UpdateWebhook(ctx context.Context, id int64, input WebhookInput, updateTarget bool) (Webhook, error) {
	var result sql.Result
	var err error
	if updateTarget {
		result, err = r.db.ExecContext(ctx, r.bind(`UPDATE alert_webhooks SET name=?,url_hint=?,target_encrypted=?,auth_encrypted=?,auth_configured=?,updated_at=? WHERE id=?`), input.Name, input.URLHint, input.TargetEncrypted, input.AuthEncrypted, boolInt(input.AuthConfigured), millis(time.Now()), id)
	} else {
		result, err = r.db.ExecContext(ctx, r.bind(`UPDATE alert_webhooks SET name=?,updated_at=? WHERE id=?`), input.Name, millis(time.Now()), id)
	}
	if err != nil {
		return Webhook{}, err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return Webhook{}, ErrNotFound
	}
	return r.Webhook(ctx, id)
}

func (r *SQLRepository) DeleteWebhook(ctx context.Context, id int64) error {
	var count int
	if err := r.db.QueryRowContext(ctx, r.bind(`SELECT COUNT(*) FROM alert_rules WHERE webhook_id=?`), id).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return errors.New("webhook is used by an alert rule")
	}
	result, err := r.db.ExecContext(ctx, r.bind(`DELETE FROM alert_webhooks WHERE id=?`), id)
	if err != nil {
		return err
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		return ErrNotFound
	}
	return nil
}

func (r *SQLRepository) CreateEvent(ctx context.Context, event Event) (Event, error) {
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now().UTC()
	}
	id, err := r.insertID(ctx, `INSERT INTO alert_events(rule_id,rule_name,cluster_alias,status,value_text,started_at,ended_at,created_at) VALUES(?,?,?,?,?,?,?,?)`, event.RuleID, event.RuleName, event.Cluster, event.Status, event.Value, millis(event.StartedAt), nullableMillis(event.EndedAt), millis(event.CreatedAt))
	event.ID = id
	return event, err
}

func (r *SQLRepository) Events(ctx context.Context, limit int) ([]Event, error) {
	rows, err := r.db.QueryContext(ctx, r.bind(`SELECT id,rule_id,rule_name,cluster_alias,status,value_text,started_at,ended_at,created_at FROM alert_events ORDER BY id DESC LIMIT ?`), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []Event
	for rows.Next() {
		var item Event
		var started, created int64
		var ended sql.NullInt64
		if err = rows.Scan(&item.ID, &item.RuleID, &item.RuleName, &item.Cluster, &item.Status, &item.Value, &started, &ended, &created); err != nil {
			return nil, err
		}
		item.StartedAt, item.CreatedAt = timeFromMillis(started), timeFromMillis(created)
		if ended.Valid {
			value := timeFromMillis(ended.Int64)
			item.EndedAt = &value
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (r *SQLRepository) CreateDelivery(ctx context.Context, item Delivery) (Delivery, error) {
	if item.CreatedAt.IsZero() {
		item.CreatedAt = time.Now().UTC()
	}
	id, err := r.insertID(ctx, `INSERT INTO alert_deliveries(event_id,rule_id,rule_name,webhook_id,webhook_name,status,http_status,error_text,response_body,created_at,sent_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, item.EventID, item.RuleID, item.RuleName, item.WebhookID, item.WebhookName, item.Status, item.HTTPStatus, item.Error, item.ResponseBody, millis(item.CreatedAt), nullableMillis(item.SentAt))
	item.ID = id
	return item, err
}

func (r *SQLRepository) Deliveries(ctx context.Context, limit int) ([]Delivery, error) {
	rows, err := r.db.QueryContext(ctx, r.bind(`SELECT id,event_id,rule_id,rule_name,webhook_id,webhook_name,status,http_status,error_text,response_body,created_at,sent_at FROM alert_deliveries ORDER BY id DESC LIMIT ?`), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []Delivery
	for rows.Next() {
		var item Delivery
		var created int64
		var sent sql.NullInt64
		if err = rows.Scan(&item.ID, &item.EventID, &item.RuleID, &item.RuleName, &item.WebhookID, &item.WebhookName, &item.Status, &item.HTTPStatus, &item.Error, &item.ResponseBody, &created, &sent); err != nil {
			return nil, err
		}
		item.CreatedAt = timeFromMillis(created)
		if sent.Valid {
			value := timeFromMillis(sent.Int64)
			item.SentAt = &value
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (r *SQLRepository) Prune(ctx context.Context, limit int) error {
	if limit < 1 {
		return nil
	}
	for _, table := range []string{"alert_events", "alert_deliveries"} {
		var cutoff int64
		query := fmt.Sprintf(`SELECT id FROM %s ORDER BY id DESC LIMIT 1 OFFSET ?`, table)
		err := r.db.QueryRowContext(ctx, r.bind(query), limit-1).Scan(&cutoff)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		deleteQuery := fmt.Sprintf(`DELETE FROM %s WHERE id < ?`, table)
		if _, err = r.db.ExecContext(ctx, r.bind(deleteQuery), cutoff); err != nil {
			return err
		}
	}
	return nil
}

func (r *SQLRepository) insertID(ctx context.Context, query string, args ...any) (int64, error) {
	if r.dialect == "postgres" {
		var id int64
		err := r.db.QueryRowContext(ctx, r.bind(query+` RETURNING id`), args...).Scan(&id)
		return id, err
	}
	result, err := r.db.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}
