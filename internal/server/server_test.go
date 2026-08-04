package server

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gcxixi/clickhouse-console/internal/store"
)

func TestBasePathRoutesAssetsAndScopesCookie(t *testing.T) {
	db, _, err := store.Open(t.TempDir(), "admin", "test-password-123")
	if err != nil {
		t.Fatal(err)
	}
	handler := New(db, nil, slog.New(slog.NewTextHandler(io.Discard, nil)), "/clickhouse")

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
	handler := New(db, nil, slog.New(slog.NewTextHandler(io.Discard, nil)), "")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("root deployment status = %d", recorder.Code)
	}
}
