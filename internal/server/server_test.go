package server

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gcxixi/clickhouse-console/internal/alerting"
	ch "github.com/gcxixi/clickhouse-console/internal/clickhouse"
	"github.com/gcxixi/clickhouse-console/internal/clusterconfig"
	"github.com/gcxixi/clickhouse-console/internal/store"
)

func TestBasePathRoutesAssetsAndScopesCookie(t *testing.T) {
	db, _, err := store.Open(t.TempDir(), "admin", "test-password-123")
	if err != nil {
		t.Fatal(err)
	}
	handler := New(db, testPlatformStore(t), []Cluster{{Alias: "default", Source: "environment", Client: nil}}, 100, time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)), "/clickhouse", nil, nil, nil, "")

	request := func(method, target, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, target, strings.NewReader(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		return recorder
	}

	redirect := request(http.MethodGet, "/clickhouse?from=proxy", "")
	if redirect.Code != http.StatusPermanentRedirect || redirect.Header().Get("Location") != "/clickhouse/?from=proxy" {
		t.Fatalf("redirect = %d %q", redirect.Code, redirect.Header().Get("Location"))
	}
	index := request(http.MethodGet, "/clickhouse/", "")
	if index.Code != http.StatusOK || !strings.Contains(index.Body.String(), `href="app.css"`) {
		t.Fatalf("prefixed index = %d %q", index.Code, index.Body.String())
	}
	asset := request(http.MethodGet, "/clickhouse/app.js", "")
	if asset.Code != http.StatusOK || !strings.Contains(asset.Body.String(), "new URL('api/'") {
		t.Fatalf("prefixed asset = %d", asset.Code)
	}
	if outside := request(http.MethodGet, "/app.js", ""); outside.Code != http.StatusNotFound {
		t.Fatalf("unprefixed asset status = %d; want 404", outside.Code)
	}

	login := request(http.MethodPost, "/clickhouse/api/login", `{"username":"admin","password":"test-password-123"}`)
	if login.Code != http.StatusOK {
		t.Fatalf("login status = %d: %s", login.Code, login.Body.String())
	}
	cookies := login.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Path != "/clickhouse/" {
		t.Fatalf("login cookies = %#v", cookies)
	}
}

func TestPlatformClusterCredentialsUseEncryptedEnvelope(t *testing.T) {
	db, _, err := store.Open(t.TempDir(), "admin", "test-password-123")
	if err != nil {
		t.Fatal(err)
	}
	platform := testPlatformStore(t)
	handler := New(db, platform, []Cluster{{Alias: "default", URL: "http://env-user:env-pass@default:8123?password=hidden&keep=1", Database: "default", Source: "environment"}}, 100, time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)), "", nil, nil, nil, "")
	request := func(method, target string, body []byte, csrf string, cookie *http.Cookie) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, target, strings.NewReader(string(body)))
		if len(body) > 0 {
			req.Header.Set("Content-Type", "application/json")
		}
		if csrf != "" {
			req.Header.Set("X-CSRF-Token", csrf)
		}
		if cookie != nil {
			req.AddCookie(cookie)
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		return recorder
	}
	login := request(http.MethodPost, "/api/login", []byte(`{"username":"admin","password":"test-password-123"}`), "", nil)
	var loginData struct {
		CSRF string `json:"csrf"`
	}
	if login.Code != http.StatusOK || json.Unmarshal(login.Body.Bytes(), &loginData) != nil {
		t.Fatalf("login failed: %d %s", login.Code, login.Body.String())
	}
	cookie := login.Result().Cookies()[0]
	keyResponse := request(http.MethodGet, "/api/clusters/transport-key", nil, "", cookie)
	var jwk struct{ N, E string }
	if keyResponse.Code != http.StatusOK || json.Unmarshal(keyResponse.Body.Bytes(), &jwk) != nil {
		t.Fatalf("transport key failed: %d %s", keyResponse.Code, keyResponse.Body.String())
	}
	nBytes, _ := base64.RawURLEncoding.DecodeString(jwk.N)
	eBytes, _ := base64.RawURLEncoding.DecodeString(jwk.E)
	exponent := 0
	for _, value := range eBytes {
		exponent = exponent<<8 | int(value)
	}
	publicKey := &rsa.PublicKey{N: new(big.Int).SetBytes(nBytes), E: exponent}
	envelope := encryptTestCredentials(t, publicKey, "transport-test-user", "transport-test-password")
	body, _ := json.Marshal(map[string]any{"alias": "platform", "url": "http://platform:8123", "database": "default", "update_credentials": true, "credentials": envelope})
	created := request(http.MethodPost, "/api/clusters", body, loginData.CSRF, cookie)
	if created.Code != http.StatusCreated {
		t.Fatalf("create cluster failed: %d %s", created.Code, created.Body.String())
	}
	if strings.Contains(created.Body.String(), "transport-test-user") || strings.Contains(created.Body.String(), "transport-test-password") {
		t.Fatalf("credential leaked in API response: %s", created.Body.String())
	}
	configs, err := platform.Configs()
	if err != nil || len(configs) != 1 || configs[0].User != "transport-test-user" || configs[0].Password != "transport-test-password" {
		t.Fatalf("stored config = %#v, %v", configs, err)
	}
	listed := request(http.MethodGet, "/api/clusters", nil, "", cookie)
	if listed.Code != http.StatusOK || strings.Contains(listed.Body.String(), "transport-test-user") || strings.Contains(listed.Body.String(), "transport-test-password") || strings.Contains(listed.Body.String(), "env-pass") || strings.Contains(listed.Body.String(), "hidden") {
		t.Fatalf("credential leaked in list response: %d %s", listed.Code, listed.Body.String())
	}
}

func encryptTestCredentials(t *testing.T, publicKey *rsa.PublicKey, user, password string) credentialEnvelope {
	t.Helper()
	aesKey := make([]byte, 32)
	if _, err := rand.Read(aesKey); err != nil {
		t.Fatal(err)
	}
	block, _ := aes.NewCipher(aesKey)
	aead, _ := cipher.NewGCM(block)
	nonce := make([]byte, aead.NonceSize())
	_, _ = rand.Read(nonce)
	plain, _ := json.Marshal(map[string]string{"user": user, "password": password})
	ciphertext := aead.Seal(nil, nonce, plain, nil)
	wrapped, err := rsa.EncryptOAEP(sha256.New(), rand.Reader, publicKey, aesKey, nil)
	if err != nil {
		t.Fatal(err)
	}
	return credentialEnvelope{Key: base64.StdEncoding.EncodeToString(wrapped), Nonce: base64.StdEncoding.EncodeToString(nonce), Ciphertext: base64.StdEncoding.EncodeToString(ciphertext)}
}

func TestRootDeploymentStillWorks(t *testing.T) {
	db, _, err := store.Open(t.TempDir(), "admin", "test-password-123")
	if err != nil {
		t.Fatal(err)
	}
	handler := New(db, testPlatformStore(t), []Cluster{{Alias: "default", Source: "environment", Client: nil}}, 100, time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)), "", nil, nil, nil, "")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("root deployment status = %d", recorder.Code)
	}
}

func TestSessionClusterSwitchRoutesQueries(t *testing.T) {
	clickhouseServer := func(alias string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"meta":[{"name":"cluster","type":"String"}],"data":[{"cluster":"`+alias+`"}],"rows":1}`)
		}))
	}
	alpha := clickhouseServer("alpha")
	defer alpha.Close()
	beta := clickhouseServer("beta")
	defer beta.Close()
	db, _, err := store.Open(t.TempDir(), "admin", "test-password-123")
	if err != nil {
		t.Fatal(err)
	}
	handler := New(db, testPlatformStore(t), []Cluster{
		{Alias: "alpha", Client: ch.New(alpha.URL, "", "", "default", 100, time.Second)},
		{Alias: "beta", Client: ch.New(beta.URL, "", "", "default", 100, time.Second)},
	}, 100, time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)), "", nil, nil, nil, "")

	request := func(method, target, body, csrf string, cookie *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, target, strings.NewReader(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if csrf != "" {
			req.Header.Set("X-CSRF-Token", csrf)
		}
		if cookie != nil {
			req.AddCookie(cookie)
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, req)
		return recorder
	}
	login := request(http.MethodPost, "/api/login", `{"username":"admin","password":"test-password-123"}`, "", nil)
	if login.Code != http.StatusOK {
		t.Fatalf("login = %d: %s", login.Code, login.Body.String())
	}
	var session struct {
		CSRF          string              `json:"csrf"`
		ActiveCluster string              `json:"active_cluster"`
		Clusters      []map[string]string `json:"clusters"`
	}
	if err = json.Unmarshal(login.Body.Bytes(), &session); err != nil {
		t.Fatal(err)
	}
	if session.ActiveCluster != "alpha" || len(session.Clusters) != 2 {
		t.Fatalf("unexpected session: %#v", session)
	}
	cookie := login.Result().Cookies()[0]
	query := func() string {
		response := request(http.MethodPost, "/api/query", `{"sql":"SELECT cluster"}`, session.CSRF, cookie)
		if response.Code != http.StatusOK {
			t.Fatalf("query = %d: %s", response.Code, response.Body.String())
		}
		return response.Body.String()
	}
	if body := query(); !strings.Contains(body, `"cluster":"alpha"`) {
		t.Fatalf("alpha query response: %s", body)
	}
	badSwitch := request(http.MethodPost, "/api/cluster", `{"alias":"beta","confirm_alias":"alpha"}`, session.CSRF, cookie)
	if badSwitch.Code != http.StatusBadRequest {
		t.Fatalf("unconfirmed switch = %d", badSwitch.Code)
	}
	goodSwitch := request(http.MethodPost, "/api/cluster", `{"alias":"beta","confirm_alias":"beta"}`, session.CSRF, cookie)
	if goodSwitch.Code != http.StatusOK || !strings.Contains(goodSwitch.Body.String(), `"active_cluster":"beta"`) {
		t.Fatalf("confirmed switch = %d: %s", goodSwitch.Code, goodSwitch.Body.String())
	}
	if body := query(); !strings.Contains(body, `"cluster":"beta"`) {
		t.Fatalf("beta query response: %s", body)
	}
	audits := db.Audits(20)
	found := false
	for _, audit := range audits {
		if audit.Action == "cluster.switch" && audit.Cluster == "beta" {
			found = true
		}
	}
	if !found {
		t.Fatal("cluster switch was not audited")
	}
}

func TestAlertValue(t *testing.T) {
	for _, test := range []struct {
		value  any
		active bool
	}{{true, true}, {false, false}, {float64(1), true}, {float64(0), false}, {"firing", true}, {"0", false}, {nil, false}} {
		active, _, err := alertValue(test.value)
		if err != nil || active != test.active {
			t.Fatalf("alertValue(%#v) = %v, %v", test.value, active, err)
		}
	}
	if _, _, err := alertValue("not-a-number"); err == nil {
		t.Fatal("invalid scalar should fail")
	}
}

func TestBatchSQLExecutionAndRolePreflight(t *testing.T) {
	var mu sync.Mutex
	var executed []string
	clickhouseServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		statement := string(body)
		mu.Lock()
		executed = append(executed, statement)
		mu.Unlock()
		if strings.Contains(statement, "bad_table") {
			http.Error(w, "simulated failure", http.StatusBadRequest)
		}
	}))
	defer clickhouseServer.Close()
	db, _, err := store.Open(t.TempDir(), "admin", "test-password-123")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.CreateUser("viewer", "viewer-password-123", "viewer"); err != nil {
		t.Fatal(err)
	}
	handler := New(db, testPlatformStore(t), []Cluster{{Alias: "default", Client: ch.New(clickhouseServer.URL, "", "", "default", 100, time.Second)}}, 100, time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)), "", nil, nil, nil, "")
	type loginResponse struct {
		CSRF string `json:"csrf"`
	}
	login := func(username, password string) (*http.Cookie, string) {
		body, _ := json.Marshal(map[string]string{"username": username, "password": password})
		req := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(body))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("login %s = %d: %s", username, rec.Code, rec.Body.String())
		}
		var session loginResponse
		if err = json.Unmarshal(rec.Body.Bytes(), &session); err != nil {
			t.Fatal(err)
		}
		return rec.Result().Cookies()[0], session.CSRF
	}
	run := func(cookie *http.Cookie, csrf, sql string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"sql": sql})
		req := httptest.NewRequest(http.MethodPost, "/api/query", bytes.NewReader(body))
		req.AddCookie(cookie)
		req.Header.Set("X-CSRF-Token", csrf)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	adminCookie, adminCSRF := login("admin", "test-password-123")
	success := run(adminCookie, adminCSRF, "CREATE TABLE one (id UInt8); DROP TABLE one;")
	if success.Code != http.StatusOK || !strings.Contains(success.Body.String(), `"statement_count":2`) {
		t.Fatalf("batch success = %d: %s", success.Code, success.Body.String())
	}
	mu.Lock()
	countAfterSuccess := len(executed)
	mu.Unlock()
	if countAfterSuccess != 2 {
		t.Fatalf("executed = %#v", executed)
	}
	viewerCookie, viewerCSRF := login("viewer", "viewer-password-123")
	denied := run(viewerCookie, viewerCSRF, "SELECT 1; DROP TABLE protected;")
	if denied.Code != http.StatusForbidden || !strings.Contains(denied.Body.String(), "statement 2/2") {
		t.Fatalf("viewer batch = %d: %s", denied.Code, denied.Body.String())
	}
	mu.Lock()
	if len(executed) != countAfterSuccess {
		t.Fatalf("unauthorized batch partially executed: %#v", executed)
	}
	mu.Unlock()
	failed := run(adminCookie, adminCSRF, "CREATE TABLE before_failure (id UInt8); DROP TABLE bad_table;")
	if failed.Code != http.StatusBadRequest || !strings.Contains(failed.Body.String(), `"executed_statements":1`) {
		t.Fatalf("failed batch = %d: %s", failed.Code, failed.Body.String())
	}
}

func TestGrantFeatureFlagAndRoleAuthorization(t *testing.T) {
	var executed int
	clickhouseServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		executed++
	}))
	defer clickhouseServer.Close()
	db, _, err := store.Open(t.TempDir(), "admin", "test-password-123")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.CreateUser("editor", "editor-password-123", "editor"); err != nil {
		t.Fatal(err)
	}
	newHandler := func(enabled bool) http.Handler {
		return New(db, testPlatformStore(t), []Cluster{{Alias: "default", Client: ch.New(clickhouseServer.URL, "", "", "default", 100, time.Second)}}, 100, time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)), "", nil, nil, nil, "", SecurityOptions{EnableGrant: enabled})
	}
	requestGrant := func(handler http.Handler, username, password string) *httptest.ResponseRecorder {
		loginBody, _ := json.Marshal(map[string]string{"username": username, "password": password})
		loginRequest := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(loginBody))
		loginResponse := httptest.NewRecorder()
		handler.ServeHTTP(loginResponse, loginRequest)
		var session struct {
			CSRF string `json:"csrf"`
		}
		if err := json.Unmarshal(loginResponse.Body.Bytes(), &session); err != nil {
			t.Fatal(err)
		}
		body, _ := json.Marshal(map[string]string{"sql": "GRANT SELECT ON default.* TO analyst"})
		req := httptest.NewRequest(http.MethodPost, "/api/query", bytes.NewReader(body))
		req.AddCookie(loginResponse.Result().Cookies()[0])
		req.Header.Set("X-CSRF-Token", session.CSRF)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	if response := requestGrant(newHandler(false), "admin", "test-password-123"); response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "CH_CONSOLE_ENABLE_GRANT") {
		t.Fatalf("disabled GRANT = %d: %s", response.Code, response.Body.String())
	}
	if executed != 0 {
		t.Fatalf("disabled GRANT reached ClickHouse %d times", executed)
	}
	if response := requestGrant(newHandler(true), "editor", "editor-password-123"); response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "admin role") {
		t.Fatalf("editor GRANT = %d: %s", response.Code, response.Body.String())
	}
	if executed != 0 {
		t.Fatalf("editor GRANT reached ClickHouse %d times", executed)
	}
	if response := requestGrant(newHandler(true), "admin", "test-password-123"); response.Code != http.StatusOK {
		t.Fatalf("enabled admin GRANT = %d: %s", response.Code, response.Body.String())
	}
	if executed != 1 {
		t.Fatalf("enabled admin GRANT executions = %d; want 1", executed)
	}
	audits := db.Audits(10)
	if len(audits) == 0 || audits[0].Action != "grant" || audits[0].Status != "ok" {
		t.Fatalf("GRANT audit = %#v", audits)
	}
}

func TestDryRunDoesNotExecuteOriginalStatements(t *testing.T) {
	var checked []string
	clickhouseServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		checked = append(checked, string(body))
		if !strings.HasPrefix(string(body), "EXPLAIN ") {
			t.Errorf("dry run executed original statement: %s", body)
		}
		if strings.Contains(string(body), "broken_function") {
			http.Error(w, "unknown function", http.StatusBadRequest)
		}
	}))
	defer clickhouseServer.Close()
	db, _, err := store.Open(t.TempDir(), "admin", "test-password-123")
	if err != nil {
		t.Fatal(err)
	}
	handler := New(db, testPlatformStore(t), []Cluster{{Alias: "default", Client: ch.New(clickhouseServer.URL, "", "", "default", 100, time.Second)}}, 100, time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)), "", nil, nil, nil, "")
	loginBody, _ := json.Marshal(map[string]string{"username": "admin", "password": "test-password-123"})
	loginRequest := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(loginBody))
	loginResponse := httptest.NewRecorder()
	handler.ServeHTTP(loginResponse, loginRequest)
	var session struct {
		CSRF string `json:"csrf"`
	}
	if loginResponse.Code != http.StatusOK || json.Unmarshal(loginResponse.Body.Bytes(), &session) != nil {
		t.Fatalf("login = %d: %s", loginResponse.Code, loginResponse.Body.String())
	}
	run := func(sql string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"sql": sql})
		req := httptest.NewRequest(http.MethodPost, "/api/query/dry-run", bytes.NewReader(body))
		req.AddCookie(loginResponse.Result().Cookies()[0])
		req.Header.Set("X-CSRF-Token", session.CSRF)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}
	success := run("SELECT 1; CREATE TABLE probe (id UInt64) ENGINE = MergeTree ORDER BY id;")
	if success.Code != http.StatusOK || !strings.Contains(success.Body.String(), `"statement_count":2`) || !strings.Contains(success.Body.String(), `"validation":"semantic"`) || !strings.Contains(success.Body.String(), `"validation":"syntax"`) {
		t.Fatalf("dry run success = %d: %s", success.Code, success.Body.String())
	}
	failed := run("SELECT broken_function(1)")
	if failed.Code != http.StatusBadRequest || !strings.Contains(failed.Body.String(), `"failed_statement":1`) {
		t.Fatalf("dry run failure = %d: %s", failed.Code, failed.Body.String())
	}
	if len(checked) != 3 || !strings.HasPrefix(checked[0], "EXPLAIN QUERY TREE") || !strings.HasPrefix(checked[1], "EXPLAIN AST") {
		t.Fatalf("checked statements = %#v", checked)
	}
}

func TestExportDatabaseSchema(t *testing.T) {
	clickhouseServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		query := string(body)
		w.Header().Set("Content-Type", "application/json")
		if strings.HasPrefix(query, "SHOW CREATE DATABASE") {
			_, _ = io.WriteString(w, `{"data":[{"statement":"CREATE DATABASE analytics ENGINE = Atomic"}],"rows":1}`)
			return
		}
		response, _ := json.Marshal(map[string]any{"data": []map[string]any{{
			"names":      []string{"events", "daily"},
			"engines":    []string{"MergeTree", "View"},
			"statements": []string{"CREATE TABLE analytics.events (id UInt64) ENGINE = MergeTree ORDER BY id", "CREATE VIEW analytics.daily AS SELECT count() FROM analytics.events"},
		}}, "rows": 1})
		_, _ = w.Write(response)
	}))
	defer clickhouseServer.Close()
	db, _, err := store.Open(t.TempDir(), "admin", "test-password-123")
	if err != nil {
		t.Fatal(err)
	}
	handler := New(db, testPlatformStore(t), []Cluster{{Alias: "default", Client: ch.New(clickhouseServer.URL, "", "", "default", 100, time.Second)}}, 100, time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)), "", nil, nil, nil, "")
	loginBody, _ := json.Marshal(map[string]string{"username": "admin", "password": "test-password-123"})
	loginRequest := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(loginBody))
	loginResponse := httptest.NewRecorder()
	handler.ServeHTTP(loginResponse, loginRequest)
	if loginResponse.Code != http.StatusOK {
		t.Fatalf("login = %d: %s", loginResponse.Code, loginResponse.Body.String())
	}
	exportRequest := httptest.NewRequest(http.MethodGet, "/api/schema/export?database=analytics", nil)
	exportRequest.AddCookie(loginResponse.Result().Cookies()[0])
	exportResponse := httptest.NewRecorder()
	handler.ServeHTTP(exportResponse, exportRequest)
	if exportResponse.Code != http.StatusOK {
		t.Fatalf("export = %d: %s", exportResponse.Code, exportResponse.Body.String())
	}
	if contentType := exportResponse.Header().Get("Content-Type"); contentType != "application/sql; charset=utf-8" {
		t.Fatalf("content type = %q", contentType)
	}
	if disposition := exportResponse.Header().Get("Content-Disposition"); disposition != `attachment; filename="analytics-schema.sql"` {
		t.Fatalf("content disposition = %q", disposition)
	}
	content := exportResponse.Body.String()
	for _, expected := range []string{"-- Cluster: default", "CREATE DATABASE analytics ENGINE = Atomic;", "CREATE TABLE analytics.events", "CREATE VIEW analytics.daily"} {
		if !strings.Contains(content, expected) {
			t.Fatalf("export missing %q: %s", expected, content)
		}
	}
	audits := db.Audits(1)
	if len(audits) != 1 || audits[0].Action != "schema.export" || audits[0].Rows != 2 || audits[0].Status != "ok" {
		t.Fatalf("audit = %#v", audits)
	}
}

func testPlatformStore(t *testing.T) *clusterconfig.Store {
	t.Helper()
	platform, err := clusterconfig.Open(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	return platform
}

func TestProcessesAndKillQueryIntegration(t *testing.T) {
	var killedQueryID string
	clickhouseServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		query := string(body)
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(query, "system.processes") {
			_, _ = io.WriteString(w, `{"meta":[{"name":"query_id","type":"String"}],"data":[{"query_id":"q-42","user":"default","address":"127.0.0.1","elapsed":5.2,"read_rows":5000,"read_bytes":20480,"total_rows_approx":50000,"memory_usage":2097152,"query":"SELECT count() FROM numbers(1000000)"}],"rows":1}`)
			return
		}
		if strings.HasPrefix(query, "KILL QUERY") {
			killedQueryID = query
			_, _ = io.WriteString(w, `{"rows":0}`)
			return
		}
		http.Error(w, "unexpected query: "+query, http.StatusBadRequest)
	}))
	defer clickhouseServer.Close()

	db, _, err := store.Open(t.TempDir(), "admin", "test-password-123")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.CreateUser("viewer", "viewer-password-123", "viewer"); err != nil {
		t.Fatal(err)
	}
	handler := New(db, testPlatformStore(t), []Cluster{{Alias: "default", Client: ch.New(clickhouseServer.URL, "", "", "default", 100, time.Second)}}, 100, time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)), "", nil, nil, nil, "")

	login := func(username, password string) (*http.Cookie, string) {
		body, _ := json.Marshal(map[string]string{"username": username, "password": password})
		req := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(body))
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("login %s = %d", username, rec.Code)
		}
		var session struct {
			CSRF string `json:"csrf"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &session)
		return rec.Result().Cookies()[0], session.CSRF
	}

	adminCookie, adminCSRF := login("admin", "test-password-123")
	viewerCookie, viewerCSRF := login("viewer", "viewer-password-123")

	// 1. GET /api/processes
	req := httptest.NewRequest(http.MethodGet, "/api/processes", nil)
	req.AddCookie(adminCookie)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get processes status = %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"query_id":"q-42"`) {
		t.Fatalf("processes response missing query: %s", rec.Body.String())
	}

	// 2. Viewer cannot kill
	killBody, _ := json.Marshal(map[string]string{"query_id": "q-42"})
	killReq := httptest.NewRequest(http.MethodPost, "/api/processes/kill", bytes.NewReader(killBody))
	killReq.AddCookie(viewerCookie)
	killReq.Header.Set("X-CSRF-Token", viewerCSRF)
	killRec := httptest.NewRecorder()
	handler.ServeHTTP(killRec, killReq)
	if killRec.Code != http.StatusForbidden {
		t.Fatalf("viewer kill status = %d; want 403", killRec.Code)
	}

	// 3. Admin can kill
	killReq = httptest.NewRequest(http.MethodPost, "/api/processes/kill", bytes.NewReader(killBody))
	killReq.AddCookie(adminCookie)
	killReq.Header.Set("X-CSRF-Token", adminCSRF)
	killRec = httptest.NewRecorder()
	handler.ServeHTTP(killRec, killReq)
	if killRec.Code != http.StatusOK || !strings.Contains(killRec.Body.String(), `"status":"killed"`) {
		t.Fatalf("admin kill status = %d: %s", killRec.Code, killRec.Body.String())
	}
	if !strings.Contains(killedQueryID, "KILL QUERY WHERE query_id = 'q-42' SYNC") {
		t.Fatalf("clickhouse received unexpected kill query: %s", killedQueryID)
	}

	// Check audit log
	audits := db.Audits(5)
	var foundKillAudit bool
	for _, a := range audits {
		if a.Action == "query.kill" && a.Statement == "q-42" && a.Status == "ok" {
			foundKillAudit = true
		}
	}
	if !foundKillAudit {
		t.Fatalf("query.kill audit not found in %#v", audits)
	}
}

func TestStreamExportIntegration(t *testing.T) {
	clickhouseServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		query := string(body)
		if !strings.Contains(query, "FORMAT CSVWithNames") {
			http.Error(w, "unexpected format in query: "+query, http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/csv")
		_, _ = io.WriteString(w, "id,name\n101,alice\n102,bob\n")
	}))
	defer clickhouseServer.Close()

	db, _, err := store.Open(t.TempDir(), "admin", "test-password-123")
	if err != nil {
		t.Fatal(err)
	}
	handler := New(db, testPlatformStore(t), []Cluster{{Alias: "default", Client: ch.New(clickhouseServer.URL, "", "", "default", 100, time.Second)}}, 100, time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)), "", nil, nil, nil, "")

	loginBody, _ := json.Marshal(map[string]string{"username": "admin", "password": "test-password-123"})
	loginReq := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(loginBody))
	loginRec := httptest.NewRecorder()
	handler.ServeHTTP(loginRec, loginReq)
	var session struct {
		CSRF string `json:"csrf"`
	}
	_ = json.Unmarshal(loginRec.Body.Bytes(), &session)

	exportBody, _ := json.Marshal(map[string]string{
		"sql":      "SELECT id, name FROM users",
		"format":   "CSVWithNames",
		"filename": "users_dump",
	})
	req := httptest.NewRequest(http.MethodPost, "/api/query/stream-export", bytes.NewReader(exportBody))
	req.AddCookie(loginRec.Result().Cookies()[0])
	req.Header.Set("X-CSRF-Token", session.CSRF)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("stream export status = %d: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/csv; charset=utf-8" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if cd := rec.Header().Get("Content-Disposition"); cd != `attachment; filename="users_dump.csv"` {
		t.Fatalf("Content-Disposition = %q", cd)
	}
	if !strings.Contains(rec.Body.String(), "101,alice\n102,bob\n") {
		t.Fatalf("unexpected export content: %s", rec.Body.String())
	}

	// Verify non-query SQL is rejected
	badBody, _ := json.Marshal(map[string]string{"sql": "DROP TABLE users"})
	badReq := httptest.NewRequest(http.MethodPost, "/api/query/stream-export", bytes.NewReader(badBody))
	badReq.AddCookie(loginRec.Result().Cookies()[0])
	badReq.Header.Set("X-CSRF-Token", session.CSRF)
	badRec := httptest.NewRecorder()
	handler.ServeHTTP(badRec, badReq)
	if badRec.Code != http.StatusBadRequest {
		t.Fatalf("bad export status = %d; want 400", badRec.Code)
	}
}

func TestAlertWebhookTestingAndChannelsIntegration(t *testing.T) {
	var receivedPayload []byte
	webhookReceiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedPayload, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"errcode":0,"errmsg":"ok"}`)
	}))
	defer webhookReceiver.Close()

	db, _, err := store.Open(t.TempDir(), "admin", "test-password-123")
	if err != nil {
		t.Fatal(err)
	}
	key := make([]byte, 32)
	codec, _ := alerting.NewSecretCodec(key)
	service := alerting.NewService(nil, alerting.NewHTTPSender(5*time.Second), codec, slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer service.Close()

	dsn := "file:" + filepath.Join(t.TempDir(), "alerts.db") + "?_pragma=busy_timeout(5000)"
	repo, err := alerting.OpenRepository(context.Background(), "sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	service.Configure(repo, 300)

	handler := New(db, testPlatformStore(t), []Cluster{{Alias: "default", Source: "environment", Client: nil}}, 100, time.Second, slog.New(slog.NewTextHandler(io.Discard, nil)), "", service, nil, nil, "")

	loginBody, _ := json.Marshal(map[string]string{"username": "admin", "password": "test-password-123"})
	loginReq := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(loginBody))
	loginRec := httptest.NewRecorder()
	handler.ServeHTTP(loginRec, loginReq)
	var session struct {
		CSRF string `json:"csrf"`
	}
	_ = json.Unmarshal(loginRec.Body.Bytes(), &session)
	cookie := loginRec.Result().Cookies()[0]

	// Create a Webhook directly via repo with WeCom channel type
	encTarget, _ := codec.Encrypt(webhookReceiver.URL)
	createdWebhook, err := repo.CreateWebhook(context.Background(), alerting.WebhookInput{
		Name:            "WeCom Bot",
		ChannelType:     "wecom",
		URLHint:         "https://qyapi.weixin.qq.com/robot/send",
		TargetEncrypted: encTarget,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Trigger test: POST /api/alerting/webhooks/{id}/test
	testReq := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/api/alerting/webhooks/%d/test", createdWebhook.ID), nil)
	testReq.AddCookie(cookie)
	testReq.Header.Set("X-CSRF-Token", session.CSRF)
	testRec := httptest.NewRecorder()
	handler.ServeHTTP(testRec, testReq)

	if testRec.Code != http.StatusOK {
		t.Fatalf("test webhook status = %d: %s", testRec.Code, testRec.Body.String())
	}
	if !strings.Contains(testRec.Body.String(), `"status":"ok"`) || !strings.Contains(testRec.Body.String(), `"http_status":200`) {
		t.Fatalf("test webhook response: %s", testRec.Body.String())
	}
	if !strings.Contains(string(receivedPayload), `"msgtype":"markdown"`) {
		t.Fatalf("wecom payload not formatted properly: %s", string(receivedPayload))
	}
}
