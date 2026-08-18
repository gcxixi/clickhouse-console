package clickhouse

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestClassify(t *testing.T) {
	cases := map[string]string{"SELECT 1": "query", "WITH 1 AS x SELECT x": "query", "INSERT INTO x VALUES (1)": "dml", "ALTER TABLE x DELETE WHERE 1": "dml"}
	cases["ALTER TABLE x UPDATE value = 'done' WHERE id = 1"] = "dml"
	cases["SYSTEM FLUSH LOGS"] = "ddl"
	cases["GRANT SELECT ON db.* TO analyst"] = "grant"
	cases["REVOKE SELECT ON db.* FROM analyst"] = "grant"
	cases["SELECT 'a;b' AS value"] = "query"
	cases["SELECT 1 /* ; is part of a comment */"] = "query"
	for sql, want := range cases {
		got, err := Classify(sql)
		if err != nil || got != want {
			t.Fatalf("Classify(%q)=%q,%v; want %q", sql, got, err, want)
		}
	}
	for _, sql := range []string{"", "SELECT 1; DROP TABLE x"} {
		if _, err := Classify(sql); err == nil {
			t.Fatalf("Classify(%q) should fail", sql)
		}
	}
}

func TestSplitStatements(t *testing.T) {
	input := "-- prepare\nCREATE TABLE `a;b` (value String); INSERT INTO `a;b` VALUES ('x;y'); /* outer ; /* nested ; */ still outer ; */ DROP TABLE `a;b`; -- trailing"
	statements, err := SplitStatements(input)
	if err != nil {
		t.Fatal(err)
	}
	if len(statements) != 3 {
		t.Fatalf("statements = %#v", statements)
	}
	if !strings.HasPrefix(statements[0], "-- prepare\nCREATE") || !strings.Contains(statements[1], "'x;y'") || !strings.Contains(statements[2], "DROP TABLE") {
		t.Fatalf("unexpected statements: %#v", statements)
	}
	for _, input := range []string{"SELECT 'unterminated", "SELECT 1 /* unterminated", "SELECT $tag$unterminated"} {
		if _, err = SplitStatements(input); err == nil {
			t.Fatalf("SplitStatements(%q) should fail", input)
		}
	}
	statements, err = SplitStatements(" ; -- only comment\n ; SELECT 1;;")
	if err != nil || len(statements) != 1 || statements[0] != "SELECT 1" {
		t.Fatalf("empty statements: %#v, %v", statements, err)
	}
	statements, err = SplitStatements("#! comment ;\nSELECT $sql$one; two$sql$; // comment ;\nSELECT $$three; four$$;")
	if err != nil || len(statements) != 2 || !strings.Contains(statements[0], "one; two") || !strings.Contains(statements[1], "three; four") {
		t.Fatalf("ClickHouse syntax: %#v, %v", statements, err)
	}
	for _, sql := range []string{"# comment\nSELECT 1", "// comment\nSELECT 1", "/* outer /* inner */ outer */ SELECT 1"} {
		if kind, classifyErr := Classify(sql); classifyErr != nil || kind != "query" {
			t.Fatalf("Classify(%q) = %q, %v", sql, kind, classifyErr)
		}
	}
	if kind, classifyErr := Classify("/* maintenance */ ALTER TABLE events DELETE WHERE id = 1"); classifyErr != nil || kind != "dml" {
		t.Fatalf("commented mutation = %q, %v", kind, classifyErr)
	}
}

func TestMonitorCollectsExporterMetricSources(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]bool{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		query := string(body)
		w.Header().Set("Content-Type", "application/json")
		var response, kind string
		switch {
		case strings.Contains(query, "system.asynchronous_metrics"):
			kind = "async"
			response = `{"data":[{"metric":"Uptime","value":3600}],"rows":1}`
		case strings.Contains(query, "system.metrics"):
			kind = "metrics"
			response = `{"data":[{"metric":"Query","value":2}],"rows":1}`
		case strings.Contains(query, "system.events"):
			kind = "events"
			response = `{"data":[{"event":"Query","value":100}],"rows":1}`
		case strings.Contains(query, "system.parts"):
			kind = "parts"
			response = `{"data":[{"database":"default","table":"events","disk_name":"default","bytes":1024,"parts":1,"rows":10}],"rows":1}`
		case strings.Contains(query, "system.disks"):
			kind = "disks"
			response = `{"data":[{"name":"default","free_space_in_bytes":1024,"total_space_in_bytes":2048}],"rows":1}`
		default:
			t.Errorf("unexpected monitoring query: %s", query)
			response = `{"data":[],"rows":0}`
		}
		mu.Lock()
		seen[kind] = true
		mu.Unlock()
		_, _ = io.WriteString(w, response)
	}))
	defer ts.Close()
	client := New(ts.URL, "", "", "default", 1000, time.Second)
	snapshot, err := client.Monitor(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Metrics) != 1 || len(snapshot.Async) != 1 || len(snapshot.Events) != 1 || len(snapshot.Parts) != 1 || len(snapshot.Disks) != 1 {
		t.Fatalf("unexpected monitoring snapshot: %#v", snapshot)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 5 {
		t.Fatalf("monitoring queries seen: %#v", seen)
	}
}

func TestExecuteQuery(t *testing.T) {
	var body, requestPath, route string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		requestPath = r.URL.Path
		route = r.URL.Query().Get("route")
		if u, p, ok := r.BasicAuth(); !ok || u != "u" || p != "p" {
			t.Error("missing auth")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"meta":[{"name":"n","type":"UInt8"}],"data":[{"n":1}],"rows":1}`)
	}))
	defer ts.Close()
	c := New(ts.URL+"/gateway/ck/?route=preserved", "u", "p", "default", 10, time.Second)
	res, err := c.Execute(context.Background(), "SELECT 1 AS n")
	if err != nil {
		t.Fatal(err)
	}
	if res.Rows != 1 || !strings.HasSuffix(body, "FORMAT JSON") {
		t.Fatalf("unexpected result/body: %+v %q", res, body)
	}
	if requestPath != "/gateway/ck/" || route != "preserved" {
		t.Fatalf("ClickHouse endpoint changed to path %q with route %q", requestPath, route)
	}
	encoded, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	response := string(encoded)
	if !strings.Contains(response, `"meta":[{"name":"n","type":"UInt8"}]`) || strings.Contains(response, `"Name"`) {
		t.Fatalf("result metadata has frontend-incompatible field names: %s", response)
	}
}

func TestExecuteReportsResponseSizeLimitInsteadOfJSONDecodeError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"data":[{"value":"this response is intentionally too large"}],"rows":1}`)
	}))
	defer ts.Close()

	client := New(ts.URL, "", "", "default", 100, time.Second, WithMaxResultBytes(32))
	_, err := client.Execute(context.Background(), "SELECT value")
	if err == nil || !strings.Contains(err.Error(), "CH_CONSOLE_MAX_RESULT_BYTES") {
		t.Fatalf("Execute() error = %v; want an actionable response-size error", err)
	}
	if strings.Contains(err.Error(), "unexpected end of JSON") {
		t.Fatalf("Execute() exposed a misleading JSON truncation error: %v", err)
	}
}

func TestDryRunUsesSemanticAnalysisForSelectAndSyntaxForDDL(t *testing.T) {
	var queries []string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		queries = append(queries, string(body))
		if strings.Contains(string(body), "broken_function") {
			http.Error(w, "unknown function", http.StatusBadRequest)
		}
	}))
	defer ts.Close()
	client := New(ts.URL+"/?route=preserved", "u", "p", "default", 100, time.Second)
	validation, _, err := client.DryRun(context.Background(), "SELECT count() FROM system.numbers")
	if err != nil || validation != "semantic" {
		t.Fatalf("SELECT dry run = %q, %v", validation, err)
	}
	validation, _, err = client.DryRun(context.Background(), "CREATE TABLE probe (id UInt64) ENGINE = MergeTree ORDER BY id")
	if err != nil || validation != "syntax" {
		t.Fatalf("DDL dry run = %q, %v", validation, err)
	}
	validation, _, err = client.DryRun(context.Background(), "SELECT broken_function(1)")
	if err == nil || validation != "semantic" || !strings.Contains(err.Error(), "unknown function") {
		t.Fatalf("invalid SELECT dry run = %q, %v", validation, err)
	}
	if len(queries) != 3 || !strings.HasPrefix(queries[0], "EXPLAIN QUERY TREE SELECT") || !strings.HasPrefix(queries[1], "EXPLAIN AST CREATE") {
		t.Fatalf("dry run queries = %#v", queries)
	}
}

func TestDatabaseSchema(t *testing.T) {
	var queries []string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		query := string(body)
		queries = append(queries, query)
		w.Header().Set("Content-Type", "application/json")
		if strings.HasPrefix(query, "SHOW CREATE DATABASE") {
			response, _ := json.Marshal(map[string]any{"data": []map[string]any{{"statement": "CREATE DATABASE `analytics'prod` ENGINE = Atomic"}}, "rows": 1})
			_, _ = w.Write(response)
			return
		}
		response, _ := json.Marshal(map[string]any{"data": []map[string]any{{
			"names":      []string{"events", "events_view"},
			"engines":    []string{"MergeTree", "View"},
			"statements": []string{"CREATE TABLE `analytics'prod`.events (id UInt64) ENGINE = MergeTree ORDER BY id", "CREATE VIEW `analytics'prod`.events_view AS SELECT * FROM `analytics'prod`.events"},
		}}, "rows": 1})
		_, _ = w.Write(response)
	}))
	defer ts.Close()
	client := New(ts.URL, "", "", "default", 100, time.Second)
	schema, err := client.DatabaseSchema(context.Background(), "analytics'prod")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(schema.DatabaseStatement, "CREATE DATABASE") || len(schema.Objects) != 2 || schema.Objects[1].Engine != "View" {
		t.Fatalf("schema = %#v", schema)
	}
	if len(queries) != 2 || !strings.Contains(queries[0], "`analytics'prod`") || !strings.Contains(queries[1], "database = 'analytics\\'prod'") {
		t.Fatalf("queries = %#v", queries)
	}
}

func TestProcesses(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), "system.processes") {
			http.Error(w, "expected system.processes query", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"meta":[{"name":"query_id","type":"String"}],"data":[{"query_id":"q-123","user":"default","address":"127.0.0.1","elapsed":2.5,"read_rows":1000,"read_bytes":4096,"total_rows_approx":10000,"memory_usage":1048576,"query":"SELECT count() FROM numbers(10000000)"}],"rows":1}`)
	}))
	defer ts.Close()

	client := New(ts.URL, "", "", "default", 100, time.Second)
	processes, err := client.Processes(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(processes) != 1 {
		t.Fatalf("processes count = %d; want 1", len(processes))
	}
	p := processes[0]
	if p.QueryID != "q-123" || p.User != "default" || p.Elapsed != 2.5 || p.ReadRows != 1000 || p.ReadBytes != 4096 || p.MemoryUsage != 1048576 || !strings.Contains(p.Query, "numbers") {
		t.Fatalf("unexpected process: %#v", p)
	}
}

func TestKillQuery(t *testing.T) {
	var executedQuery string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		executedQuery = string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"rows":0}`)
	}))
	defer ts.Close()

	client := New(ts.URL, "", "", "default", 100, time.Second)
	if err := client.KillQuery(context.Background(), ""); err == nil {
		t.Fatal("empty queryID should fail")
	}
	if err := client.KillQuery(context.Background(), "q'123; DROP"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(executedQuery, "KILL QUERY WHERE query_id = 'q\\'123; DROP' SYNC") {
		t.Fatalf("unexpected kill query: %q", executedQuery)
	}
}

func TestStreamQuery(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		query := string(body)
		if !strings.Contains(query, "FORMAT CSVWithNames") {
			http.Error(w, "missing format", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/csv")
		_, _ = io.WriteString(w, "n,name\n1,hello\n2,world\n")
	}))
	defer ts.Close()

	client := New(ts.URL, "", "", "default", 100, time.Second)
	var buf strings.Builder
	err := client.StreamQuery(context.Background(), "SELECT n, name FROM table", "CSVWithNames", &buf)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), "n,name\n1,hello\n2,world\n") {
		t.Fatalf("streamed content = %q", buf.String())
	}

	if err = client.StreamQuery(context.Background(), "DROP TABLE abc", "CSVWithNames", &buf); err == nil {
		t.Fatal("streaming non-query should fail")
	}
	if err = client.StreamQuery(context.Background(), "SELECT 1", "invalid format!", &buf); err == nil {
		t.Fatal("streaming invalid format should fail")
	}
}
