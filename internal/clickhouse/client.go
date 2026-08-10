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
	Meta               []Column          `json:"meta,omitempty"`
	Data               []map[string]any  `json:"data,omitempty"`
	Rows               int               `json:"rows"`
	Statistics         any               `json:"statistics,omitempty"`
	ElapsedMS          int64             `json:"elapsed_ms"`
	Kind               string            `json:"kind"`
	StatementCount     int               `json:"statement_count,omitempty"`
	ExecutedStatements int               `json:"executed_statements,omitempty"`
	Statements         []StatementResult `json:"statements,omitempty"`
}
type StatementResult struct {
	Index     int    `json:"index"`
	Kind      string `json:"kind"`
	Rows      int    `json:"rows"`
	ElapsedMS int64  `json:"elapsed_ms"`
}
type SchemaObject struct {
	Name      string `json:"name"`
	Engine    string `json:"engine"`
	Statement string `json:"statement"`
}
type DatabaseSchema struct {
	DatabaseStatement string         `json:"database_statement"`
	Objects           []SchemaObject `json:"objects"`
}
type Monitoring struct {
	GeneratedAt time.Time        `json:"generated_at"`
	Metrics     []map[string]any `json:"metrics"`
	Async       []map[string]any `json:"asynchronous_metrics"`
	Events      []map[string]any `json:"events"`
	Parts       []map[string]any `json:"parts"`
	Disks       []map[string]any `json:"disks"`
}

var (
	firstWord     = regexp.MustCompile(`(?i)^([a-z]+)`)
	alterMutation = regexp.MustCompile(`(?is)^ALTER\s+TABLE\b.*\b(UPDATE|DELETE)\b`)
)

func New(endpoint, user, password, database string, maxRows int, timeout time.Duration) *Client {
	return &Client{endpoint: strings.TrimSpace(endpoint), user: user, password: password, database: database, maxRows: maxRows, timeout: timeout, http: &http.Client{Timeout: timeout + 5*time.Second}}
}
func Classify(sql string) (string, error) {
	statements, err := SplitStatements(sql)
	if err != nil {
		return "", err
	}
	if len(statements) == 0 {
		return "", errors.New("SQL is required")
	}
	if len(statements) != 1 {
		return "", errors.New("expected exactly one SQL statement")
	}
	trimmed := statements[0]
	statementBody := strings.TrimLeft(trimmed[leadingTriviaLength(trimmed):], " \t\r\n\f")
	m := firstWord.FindStringSubmatch(statementBody)
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
		if alterMutation.MatchString(statementBody) {
			return "dml", nil
		}
		return "ddl", nil
	case "CREATE", "DROP", "TRUNCATE", "RENAME", "ATTACH", "DETACH", "SYSTEM", "KILL":
		return "ddl", nil
	default:
		return "", fmt.Errorf("unsupported SQL statement: %s", w)
	}
}

func SplitStatements(sql string) ([]string, error) {
	var statements []string
	var current strings.Builder
	var quote byte
	var heredoc string
	lineComment, blockCommentDepth := false, 0
	hasCode := false
	for i := 0; i < len(sql); i++ {
		c := sql[i]
		if heredoc != "" {
			if strings.HasPrefix(sql[i:], heredoc) {
				current.WriteString(heredoc)
				i += len(heredoc) - 1
				heredoc = ""
			} else {
				current.WriteByte(c)
			}
			continue
		}
		if lineComment {
			current.WriteByte(c)
			if c == '\n' {
				lineComment = false
			}
			continue
		}
		if blockCommentDepth > 0 {
			current.WriteByte(c)
			if c == '/' && i+1 < len(sql) && sql[i+1] == '*' {
				current.WriteByte(sql[i+1])
				blockCommentDepth++
				i++
			} else if c == '*' && i+1 < len(sql) && sql[i+1] == '/' {
				current.WriteByte(sql[i+1])
				blockCommentDepth--
				i++
			}
			continue
		}
		if quote != 0 {
			current.WriteByte(c)
			if c == '\\' {
				if i+1 < len(sql) {
					i++
					current.WriteByte(sql[i])
				}
				continue
			}
			if c == quote {
				if i+1 < len(sql) && sql[i+1] == quote {
					i++
					current.WriteByte(sql[i])
					continue
				}
				quote = 0
			}
			continue
		}
		if delimiter := lineCommentDelimiter(sql, i); delimiter != "" {
			current.WriteString(delimiter)
			lineComment = true
			i += len(delimiter) - 1
			continue
		}
		if c == '/' && i+1 < len(sql) && sql[i+1] == '*' {
			current.WriteString("/*")
			blockCommentDepth = 1
			i++
			continue
		}
		if delimiter := heredocDelimiterAt(sql, i); delimiter != "" {
			current.WriteString(delimiter)
			hasCode = true
			heredoc = delimiter
			i += len(delimiter) - 1
			continue
		}
		if c == '\'' || c == '"' || c == '`' {
			current.WriteByte(c)
			hasCode = true
			quote = c
			continue
		}
		if c == ';' {
			if hasCode {
				statements = append(statements, strings.TrimSpace(current.String()))
			}
			current.Reset()
			hasCode = false
			continue
		}
		current.WriteByte(c)
		if !strings.ContainsRune(" \t\r\n", rune(c)) {
			hasCode = true
		}
	}
	if quote != 0 {
		return nil, errors.New("unterminated quoted string or identifier")
	}
	if heredoc != "" {
		return nil, errors.New("unterminated heredoc")
	}
	if blockCommentDepth > 0 {
		return nil, errors.New("unterminated block comment")
	}
	if hasCode {
		statements = append(statements, strings.TrimSpace(current.String()))
	}
	return statements, nil
}

func heredocDelimiterAt(sql string, start int) string {
	if start >= len(sql) || sql[start] != '$' {
		return ""
	}
	for i := start + 1; i < len(sql); i++ {
		if sql[i] == '$' {
			return sql[start : i+1]
		}
		if !isWordByte(sql[i]) {
			return ""
		}
	}
	return ""
}

func lineCommentDelimiter(sql string, start int) string {
	if strings.HasPrefix(sql[start:], "--") || strings.HasPrefix(sql[start:], "//") || strings.HasPrefix(sql[start:], "#!") {
		return sql[start : start+2]
	}
	if sql[start] == '#' && start+1 < len(sql) && (sql[start+1] == ' ' || sql[start+1] == '\t') {
		return "#"
	}
	return ""
}

func leadingTriviaLength(sql string) int {
	for i := 0; i < len(sql); {
		switch sql[i] {
		case ' ', '\t', '\r', '\n', '\f':
			i++
			continue
		}
		if delimiter := lineCommentDelimiter(sql, i); delimiter != "" {
			i += len(delimiter)
			for i < len(sql) && sql[i] != '\n' {
				i++
			}
			continue
		}
		if !strings.HasPrefix(sql[i:], "/*") {
			return i
		}
		depth := 1
		i += 2
		for i < len(sql) && depth > 0 {
			if strings.HasPrefix(sql[i:], "/*") {
				depth++
				i += 2
			} else if strings.HasPrefix(sql[i:], "*/") {
				depth--
				i += 2
			} else {
				i++
			}
		}
	}
	return len(sql)
}

func isWordByte(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
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

func (c *Client) DatabaseSchema(ctx context.Context, database string) (DatabaseSchema, error) {
	if strings.TrimSpace(database) == "" {
		return DatabaseSchema{}, errors.New("database is required")
	}
	if len(database) > 256 || strings.IndexByte(database, 0) >= 0 {
		return DatabaseSchema{}, errors.New("invalid database name")
	}
	databaseResult, err := c.Execute(ctx, "SHOW CREATE DATABASE "+quoteIdentifier(database))
	if err != nil {
		return DatabaseSchema{}, err
	}
	databaseStatement, err := resultString(databaseResult, "statement")
	if err != nil {
		return DatabaseSchema{}, fmt.Errorf("read database definition: %w", err)
	}
	objectsSQL := "SELECT toJSONString(groupArray(tuple(name, engine, create_table_query))) AS objects_json FROM (" +
		"SELECT name, engine, create_table_query FROM system.tables WHERE database = " + quoteString(database) +
		" ORDER BY multiIf(engine IN ('View', 'MaterializedView', 'LiveView', 'WindowView'), 2, engine = 'Dictionary', 1, 0), name)"
	objectsResult, err := c.Execute(ctx, objectsSQL)
	if err != nil {
		return DatabaseSchema{}, err
	}
	objectsJSON, err := resultString(objectsResult, "objects_json")
	if err != nil {
		return DatabaseSchema{}, fmt.Errorf("read database objects: %w", err)
	}
	var rows [][]string
	if err = json.Unmarshal([]byte(objectsJSON), &rows); err != nil {
		return DatabaseSchema{}, fmt.Errorf("decode database objects: %w", err)
	}
	objects := make([]SchemaObject, 0, len(rows))
	for _, row := range rows {
		if len(row) != 3 || strings.TrimSpace(row[2]) == "" {
			return DatabaseSchema{}, errors.New("invalid database object definition")
		}
		objects = append(objects, SchemaObject{Name: row[0], Engine: row[1], Statement: row[2]})
	}
	return DatabaseSchema{DatabaseStatement: databaseStatement, Objects: objects}, nil
}

func resultString(result Result, key string) (string, error) {
	if len(result.Data) != 1 {
		return "", errors.New("unexpected ClickHouse response")
	}
	value, ok := result.Data[0][key]
	if !ok {
		return "", fmt.Errorf("missing %s", key)
	}
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		return "", fmt.Errorf("invalid %s", key)
	}
	return text, nil
}

func quoteIdentifier(value string) string {
	return "`" + strings.ReplaceAll(value, "`", "``") + "`"
}

func quoteString(value string) string {
	value = strings.ReplaceAll(value, "\\", "\\\\")
	return "'" + strings.ReplaceAll(value, "'", "\\'") + "'"
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
