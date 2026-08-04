package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	ch "github.com/gcxixi/clickhouse-console/internal/clickhouse"
	"github.com/gcxixi/clickhouse-console/internal/store"
)

func TestBasePathRoutesAssetsAndScopesCookie(t *testing.T) {
	db, _, err := store.Open(t.TempDir(), "admin", "test-password-123")
	if err != nil {
		t.Fatal(err)
	}
	handler := New(db, []Cluster{{Alias: "default", Client: nil}}, slog.New(slog.NewTextHandler(io.Discard, nil)), "/clickhouse")

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

func TestRootDeploymentStillWorks(t *testing.T) {
	db, _, err := store.Open(t.TempDir(), "admin", "test-password-123")
	if err != nil {
		t.Fatal(err)
	}
	handler := New(db, []Cluster{{Alias: "default", Client: nil}}, slog.New(slog.NewTextHandler(io.Discard, nil)), "")
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
	handler := New(db, []Cluster{
		{Alias: "alpha", Client: ch.New(alpha.URL, "", "", "default", 100, time.Second)},
		{Alias: "beta", Client: ch.New(beta.URL, "", "", "default", 100, time.Second)},
	}, slog.New(slog.NewTextHandler(io.Discard, nil)), "")

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
