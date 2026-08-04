package clickhouse

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type Client struct {
	endpoint, user, password, database string
	maxRows                            int
	timeout                            time.Duration
	http                               *http.Client
}
type Column struct {
	Name string `json:"name"`
	Type string `json:"type"`
}
type Result struct {
	Meta       []Column         `json:"meta,omitempty"`
	Data       []map[string]any `json:"data,omitempty"`
	Rows       int              `json:"rows"`
	Statistics any              `json:"statistics,omitempty"`
	ElapsedMS  int64            `json:"elapsed_ms"`
	Kind       string           `json:"kind"`
}
type Monitoring struct {
	GeneratedAt time.Time        `json:"generated_at"`
	Metrics     []map[string]any `json:"metrics"`
	Async       []map[string]any `json:"asynchronous_metrics"`
	Events      []map[string]any `json:"events"`
	Parts       []map[string]any `json:"parts"`
	Disks       []map[string]any `json:"disks"`
}

var firstWord = regexp.MustCompile(`(?is)^\s*(?:--[^\n]*\n|/\*.*?\*/\s*)*([a-z]+)`)

func New(endpoint, user, password, database string, maxRows int, timeout time.Duration) *Client {
	return &Client{endpoint: strings.TrimSpace(endpoint), user: user, password: password, database: database, maxRows: maxRows, timeout: timeout, http: &http.Client{Timeout: timeout + 5*time.Second}}
}
func Classify(sql string) (string, error) {
	s := strings.TrimSpace(sql)
	if s == "" {
		return "", errors.New("SQL is required")
	}
	trimmed := strings.TrimSpace(strings.TrimSuffix(s, ";"))
	if hasStatementSeparator(trimmed) {
		return "", errors.New("multiple SQL statements are not allowed")
	}
	m := firstWord.FindStringSubmatch(trimmed)
	if len(m) < 2 {
		return "", errors.New("unable to classify SQL")
	}
	w := strings.ToUpper(m[1])
	switch w {
	case "SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH", "EXISTS", "CHECK":
		return "query", nil
	case "INSERT", "UPDATE", "DELETE", "OPTIMIZE":
		return "dml", nil
	case "ALTER":
		upper := strings.ToUpper(trimmed)
		if regexp.MustCompile(`(?s)^\s*ALTER\s+TABLE\b.*\b(UPDATE|DELETE)\b`).MatchString(upper) {
			return "dml", nil
		}
		return "ddl", nil
	case "CREATE", "DROP", "TRUNCATE", "RENAME", "ATTACH", "DETACH", "SYSTEM", "KILL":
		return "ddl", nil
	default:
		return "", fmt.Errorf("unsupported SQL statement: %s", w)
	}
}

func hasStatementSeparator(sql string) bool {
	var quote byte
	lineComment, blockComment := false, false
	for i := 0; i < len(sql); i++ {
		c := sql[i]
		if lineComment {
			if c == '\n' {
				lineComment = false
			}
			continue
		}
		if blockComment {
			if c == '*' && i+1 < len(sql) && sql[i+1] == '/' {
				blockComment = false
				i++
			}
			continue
		}
		if quote != 0 {
			if c == '\\' {
				i++
				continue
			}
			if c == quote {
				if i+1 < len(sql) && sql[i+1] == quote {
					i++
					continue
				}
				quote = 0
			}
			continue
		}
		if c == '-' && i+1 < len(sql) && sql[i+1] == '-' {
			lineComment = true
			i++
			continue
		}
		if c == '/' && i+1 < len(sql) && sql[i+1] == '*' {
			blockComment = true
			i++
			continue
		}
		if c == '\'' || c == '"' || c == '`' {
			quote = c
			continue
		}
		if c == ';' {
			return true
		}
	}
	return false
}
func (c *Client) Execute(ctx context.Context, sql string) (Result, error) {
	kind, err := Classify(sql)
	if err != nil {
		return Result{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	q := strings.TrimSpace(sql)
	if kind == "query" && !regexp.MustCompile(`(?i)\bFORMAT\s+\w+\s*;?$`).MatchString(q) {
		q = strings.TrimSuffix(q, ";") + " FORMAT JSON"
	}
	u, err := url.Parse(c.endpoint)
	if err != nil {
		return Result{}, err
	}
	params := u.Query()
	params.Set("database", c.database)
	params.Set("max_result_rows", fmt.Sprint(c.maxRows))
	params.Set("result_overflow_mode", "break")
	u.RawQuery = params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewBufferString(q))
	if err != nil {
		return Result{}, err
	}
	req.Header.Set("Content-Type", "text/plain; charset=utf-8")
	if c.user != "" {
		req.SetBasicAuth(c.user, c.password)
	}
	start := time.Now()
	resp, err := c.http.Do(req)
	if err != nil {
		return Result{}, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return Result{}, err
	}
	if resp.StatusCode >= 300 {
		return Result{}, fmt.Errorf("ClickHouse: %s", strings.TrimSpace(string(body)))
	}
	r := Result{Kind: kind, ElapsedMS: time.Since(start).Milliseconds()}
	if kind == "query" {
		if err = json.Unmarshal(body, &r); err != nil {
			return Result{}, fmt.Errorf("decode ClickHouse response: %w", err)
		}
		r.Kind = kind
		r.ElapsedMS = time.Since(start).Milliseconds()
	}
	return r, nil
}
func (c *Client) Ping(ctx context.Context) error {
	r, err := c.Execute(ctx, "SELECT 1 AS ok")
	if err != nil {
		return err
	}
	if len(r.Data) != 1 {
		return errors.New("unexpected ping response")
	}
	return nil
}

func (c *Client) Monitor(ctx context.Context) (Monitoring, error) {
	queries := map[string]string{
		"metrics": "SELECT metric, value FROM system.metrics ORDER BY metric",
		"async":   "SELECT replaceRegexpAll(toString(metric), '-', '_') AS metric, value FROM system.asynchronous_metrics ORDER BY metric",
		"events":  "SELECT event, value FROM system.events ORDER BY event",
		"parts":   "SELECT database, table, disk_name, sum(bytes) AS bytes, count() AS parts, sum(rows) AS rows FROM system.parts WHERE active = 1 GROUP BY database, table, disk_name ORDER BY bytes DESC LIMIT 100",
		"disks":   "SELECT name, sum(free_space) AS free_space_in_bytes, sum(total_space) AS total_space_in_bytes FROM system.disks GROUP BY name ORDER BY name",
	}
	type response struct {
		name string
		data []map[string]any
		err  error
	}
	results := make(chan response, len(queries))
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	for name, query := range queries {
		go func() {
			result, err := c.Execute(ctx, query)
			results <- response{name: name, data: result.Data, err: err}
		}()
	}
	collected := make(map[string][]map[string]any, len(queries))
	for range queries {
		result := <-results
		if result.err != nil {
			cancel()
			return Monitoring{}, fmt.Errorf("read %s monitoring data: %w", result.name, result.err)
		}
		collected[result.name] = result.data
	}
	return Monitoring{
		GeneratedAt: time.Now().UTC(), Metrics: collected["metrics"], Async: collected["async"],
		Events: collected["events"], Parts: collected["parts"], Disks: collected["disks"],
	}, nil
}
