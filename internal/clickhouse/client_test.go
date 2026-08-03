package clickhouse

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClassify(t *testing.T) {
	cases := map[string]string{"SELECT 1": "query", "WITH 1 AS x SELECT x": "query", "INSERT INTO x VALUES (1)": "dml", "ALTER TABLE x DELETE WHERE 1": "dml"}
	cases["ALTER TABLE x UPDATE value = 'done' WHERE id = 1"] = "dml"
	cases["SYSTEM FLUSH LOGS"] = "ddl"
	cases["SELECT 'a;b' AS value"] = "query"
	cases["SELECT 1 /* ; is part of a comment */"] = "query"
	for sql, want := range cases {
		got, err := Classify(sql)
		if err != nil || got != want {
			t.Fatalf("Classify(%q)=%q,%v; want %q", sql, got, err, want)
		}
	}
	for _, sql := range []string{"", "SELECT 1; DROP TABLE x", "GRANT ALL ON *.* TO x"} {
		if _, err := Classify(sql); err == nil {
			t.Fatalf("Classify(%q) should fail", sql)
		}
	}
}

func TestExecuteQuery(t *testing.T) {
	var body string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		if u, p, ok := r.BasicAuth(); !ok || u != "u" || p != "p" {
			t.Error("missing auth")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"meta":[{"name":"n","type":"UInt8"}],"data":[{"n":1}],"rows":1}`)
	}))
	defer ts.Close()
	c := New(ts.URL, "u", "p", "default", 10, time.Second)
	res, err := c.Execute(context.Background(), "SELECT 1 AS n")
	if err != nil {
		t.Fatal(err)
	}
	if res.Rows != 1 || !strings.HasSuffix(body, "FORMAT JSON") {
		t.Fatalf("unexpected result/body: %+v %q", res, body)
	}
}
