package server

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gcxixi/clickhouse-console/internal/alertconfig"
	"github.com/gcxixi/clickhouse-console/internal/alerting"
	ch "github.com/gcxixi/clickhouse-console/internal/clickhouse"
	"github.com/gcxixi/clickhouse-console/internal/clusterconfig"
	"github.com/gcxixi/clickhouse-console/internal/store"
)

//go:embed web/*
var webFS embed.FS

type session struct {
	User          store.PublicUser
	CSRF          string
	ActiveCluster string
	Expires       time.Time
}
type Cluster struct {
	ID, Alias, URL, Database, Source string
	Client                           *ch.Client
}
type Server struct {
	db                *store.Store
	platform          *clusterconfig.Store
	clusters          map[string]Cluster
	aliases           []string
	maxRows           int
	timeout           time.Duration
	log               *slog.Logger
	mu                sync.RWMutex
	sessions          map[string]session
	basePath          string
	cookiePath        string
	keyOnce           sync.Once
	key               *rsa.PrivateKey
	keyErr            error
	alerts            *alerting.Service
	alertConfig       *alertconfig.Store
	alertEnvironment  *alertconfig.Config
	alertStartupError string
}

func New(db *store.Store, platform *clusterconfig.Store, configured []Cluster, maxRows int, timeout time.Duration, log *slog.Logger, basePath string, alerts *alerting.Service, alertConfig *alertconfig.Store, alertEnvironment *alertconfig.Config, alertStartupError string) http.Handler {
	if len(configured) == 0 {
		panic("at least one ClickHouse cluster is required")
	}
	cookiePath := "/"
	if basePath != "" {
		cookiePath = basePath + "/"
	}
	s := &Server{db: db, platform: platform, clusters: make(map[string]Cluster, len(configured)), aliases: make([]string, 0, len(configured)), maxRows: maxRows, timeout: timeout, log: log, sessions: map[string]session{}, basePath: basePath, cookiePath: cookiePath, alerts: alerts, alertConfig: alertConfig, alertEnvironment: alertEnvironment, alertStartupError: alertStartupError}
	for _, cluster := range configured {
		s.clusters[cluster.Alias] = cluster
		s.aliases = append(s.aliases, cluster.Alias)
	}
	if alerts != nil {
		alerts.SetExecutor(alertQueryExecutor{s: s})
	}
	m := http.NewServeMux()
	m.HandleFunc("POST /api/login", s.login)
	m.HandleFunc("POST /api/logout", s.auth(s.logout))
	m.HandleFunc("GET /api/session", s.auth(s.getSession))
	m.HandleFunc("GET /api/health", s.auth(s.health))
	m.HandleFunc("POST /api/cluster", s.auth(s.switchCluster))
	m.HandleFunc("POST /api/query", s.auth(s.query))
	m.HandleFunc("POST /api/query/dry-run", s.auth(s.dryRun))
	m.HandleFunc("GET /api/schema/export", s.auth(s.exportDatabaseSchema))
	m.HandleFunc("GET /api/monitor", s.auth(s.monitor))
	m.HandleFunc("GET /api/clusters", s.admin(s.listClusters))
	m.HandleFunc("GET /api/clusters/transport-key", s.admin(s.transportKey))
	m.HandleFunc("GET /api/transport-key", s.admin(s.transportKey))
	m.HandleFunc("POST /api/clusters", s.admin(s.createCluster))
	m.HandleFunc("PUT /api/clusters/{id}", s.admin(s.updateCluster))
	m.HandleFunc("DELETE /api/clusters/{id}", s.admin(s.deleteCluster))
	m.HandleFunc("GET /api/users", s.admin(s.users))
	m.HandleFunc("POST /api/users", s.admin(s.createUser))
	m.HandleFunc("PATCH /api/users/{id}", s.admin(s.updateUser))
	m.HandleFunc("GET /api/audit", s.admin(s.audit))
	m.HandleFunc("GET /api/alerting/config", s.admin(s.alertingConfig))
	m.HandleFunc("PUT /api/alerting/config", s.admin(s.updateAlertingConfig))
	m.HandleFunc("GET /api/alerting/rules", s.admin(s.alertRules))
	m.HandleFunc("POST /api/alerting/rules", s.admin(s.createAlertRule))
	m.HandleFunc("PUT /api/alerting/rules/{id}", s.admin(s.updateAlertRule))
	m.HandleFunc("DELETE /api/alerting/rules/{id}", s.admin(s.deleteAlertRule))
	m.HandleFunc("GET /api/alerting/webhooks", s.admin(s.alertWebhooks))
	m.HandleFunc("POST /api/alerting/webhooks", s.admin(s.createAlertWebhook))
	m.HandleFunc("PUT /api/alerting/webhooks/{id}", s.admin(s.updateAlertWebhook))
	m.HandleFunc("DELETE /api/alerting/webhooks/{id}", s.admin(s.deleteAlertWebhook))
	m.HandleFunc("GET /api/alerting/events", s.admin(s.alertEvents))
	m.HandleFunc("GET /api/alerting/deliveries", s.admin(s.alertDeliveries))
	sub, _ := fs.Sub(webFS, "web")
	m.Handle("/", http.FileServer(http.FS(sub)))
	if basePath == "" {
		return securityHeaders(m)
	}
	outer := http.NewServeMux()
	outer.Handle(basePath+"/", http.StripPrefix(basePath, m))
	outer.HandleFunc(basePath, func(w http.ResponseWriter, r *http.Request) {
		target := basePath + "/"
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusPermanentRedirect)
	})
	return securityHeaders(outer)
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var in struct{ Username, Password string }
	if !decode(w, r, &in) {
		return
	}
	u, ok := s.db.Authenticate(in.Username, in.Password)
	if !ok {
		s.db.AddAudit(store.Audit{User: in.Username, Action: "login", Status: "denied", RemoteAddr: remote(r)})
		writeErr(w, 401, "invalid username or password")
		return
	}
	sid := token()
	csrf := token()
	aliases := s.clusterAliases()
	ss := session{User: u, CSRF: csrf, ActiveCluster: aliases[0], Expires: time.Now().Add(12 * time.Hour)}
	s.mu.Lock()
	s.sessions[sid] = ss
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "ch_session", Value: sid, Path: s.cookiePath, HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https", MaxAge: 43200})
	s.db.AddAudit(store.Audit{User: u.Username, Cluster: ss.ActiveCluster, Action: "login", Status: "ok", RemoteAddr: remote(r)})
	writeJSON(w, 200, s.sessionResponse(ss))
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	sid, _ := r.Cookie("ch_session")
	if sid != nil {
		s.mu.Lock()
		delete(s.sessions, sid.Value)
		s.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: "ch_session", Path: s.cookiePath, MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	w.WriteHeader(204)
}
func (s *Server) getSession(w http.ResponseWriter, r *http.Request) {
	ss, _ := getSession(r)
	writeJSON(w, 200, s.sessionResponse(ss))
}
func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ss, _ := getSession(r)
	client, ok := s.clusterClient(ss.ActiveCluster)
	if !ok {
		writeErr(w, 409, "active cluster is no longer available")
		return
	}
	err := client.Ping(r.Context())
	if err != nil {
		writeJSON(w, 503, map[string]any{"status": "down", "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]string{"status": "ok", "cluster": ss.ActiveCluster})
}
func (s *Server) switchCluster(w http.ResponseWriter, r *http.Request) {
	ss, _ := getSession(r)
	var in struct {
		Alias        string `json:"alias"`
		ConfirmAlias string `json:"confirm_alias"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Alias == "" || in.ConfirmAlias != in.Alias {
		writeErr(w, 400, "cluster switch confirmation does not match")
		return
	}
	cookie, _ := r.Cookie("ch_session")
	s.mu.Lock()
	if _, exists := s.clusters[in.Alias]; !exists {
		s.mu.Unlock()
		writeErr(w, 404, "cluster not found")
		return
	}
	updated, ok := s.sessions[cookie.Value]
	if ok {
		updated.ActiveCluster = in.Alias
		s.sessions[cookie.Value] = updated
	}
	s.mu.Unlock()
	if !ok {
		writeErr(w, 401, "session expired")
		return
	}
	s.db.AddAudit(store.Audit{User: ss.User.Username, Cluster: in.Alias, Action: "cluster.switch", Statement: ss.ActiveCluster + " -> " + in.Alias, Status: "ok", RemoteAddr: remote(r)})
	writeJSON(w, 200, s.sessionResponse(updated))
}
func (s *Server) query(w http.ResponseWriter, r *http.Request) {
	ss, _ := getSession(r)
	var in struct {
		SQL string `json:"sql"`
	}
	if !decode(w, r, &in) {
		return
	}
	statements, err := ch.SplitStatements(in.SQL)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if len(statements) == 0 {
		writeErr(w, 400, "SQL is required")
		return
	}
	if len(statements) > 100 {
		writeErr(w, 400, "a batch can contain at most 100 SQL statements")
		return
	}
	kinds := make([]string, len(statements))
	for i, statement := range statements {
		kinds[i], err = ch.Classify(statement)
		if err != nil {
			writeErr(w, 400, fmt.Sprintf("statement %d/%d: %v", i+1, len(statements), err))
			return
		}
		if err = authorizeSQLKind(ss.User.Role, kinds[i]); err != nil {
			writeErr(w, 403, fmt.Sprintf("statement %d/%d: %v", i+1, len(statements), err))
			return
		}
	}
	start := time.Now()
	client, ok := s.clusterClient(ss.ActiveCluster)
	if !ok {
		writeErr(w, 409, "active cluster is no longer available")
		return
	}
	action := kinds[0]
	if len(statements) > 1 {
		action = "batch"
	}
	a := store.Audit{User: ss.User.Username, Cluster: ss.ActiveCluster, Action: action, Statement: truncate(in.SQL, 2000), RemoteAddr: remote(r), Status: "ok"}
	var final ch.Result
	summaries := make([]ch.StatementResult, 0, len(statements))
	for i, statement := range statements {
		result, executeErr := client.Execute(r.Context(), statement)
		if executeErr != nil {
			a.Status = "error"
			a.DurationMS = time.Since(start).Milliseconds()
			a.Error = truncate(fmt.Sprintf("statement %d/%d: %v", i+1, len(statements), executeErr), 1000)
			s.db.AddAudit(a)
			writeJSON(w, 400, map[string]any{"error": fmt.Sprintf("statement %d/%d failed: %v", i+1, len(statements), executeErr), "failed_statement": i + 1, "executed_statements": i, "statement_count": len(statements)})
			return
		}
		final = result
		summaries = append(summaries, ch.StatementResult{Index: i + 1, Kind: result.Kind, Rows: result.Rows, ElapsedMS: result.ElapsedMS})
	}
	a.DurationMS = time.Since(start).Milliseconds()
	a.Rows = final.Rows
	s.db.AddAudit(a)
	if len(statements) == 1 {
		writeJSON(w, 200, final)
		return
	}
	final.Kind = "batch"
	final.ElapsedMS = a.DurationMS
	final.StatementCount = len(statements)
	final.ExecutedStatements = len(statements)
	final.Statements = summaries
	writeJSON(w, 200, final)
}

func authorizeSQLKind(role, kind string) error {
	if role == "viewer" && kind != "query" {
		return errors.New("viewer role can only run read queries")
	}
	if role == "editor" && kind == "ddl" {
		return errors.New("admin role is required for DDL")
	}
	return nil
}
func (s *Server) dryRun(w http.ResponseWriter, r *http.Request) {
	ss, _ := getSession(r)
	var input struct {
		SQL string `json:"sql"`
	}
	if !decode(w, r, &input) {
		return
	}
	statements, err := ch.SplitStatements(input.SQL)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if len(statements) == 0 {
		writeErr(w, 400, "SQL is required")
		return
	}
	if len(statements) > 100 {
		writeErr(w, 400, "a batch can contain at most 100 SQL statements")
		return
	}
	for i, statement := range statements {
		kind, classifyErr := ch.Classify(statement)
		if classifyErr != nil {
			writeErr(w, 400, fmt.Sprintf("statement %d/%d: %v", i+1, len(statements), classifyErr))
			return
		}
		if authorizeErr := authorizeSQLKind(ss.User.Role, kind); authorizeErr != nil {
			writeErr(w, 403, fmt.Sprintf("statement %d/%d: %v", i+1, len(statements), authorizeErr))
			return
		}
	}
	client, ok := s.clusterClient(ss.ActiveCluster)
	if !ok {
		writeErr(w, 409, "active cluster is no longer available")
		return
	}
	start := time.Now()
	audit := store.Audit{User: ss.User.Username, Cluster: ss.ActiveCluster, Action: "dry-run", Statement: truncate(input.SQL, 2000), RemoteAddr: remote(r), Status: "ok"}
	results := make([]map[string]any, 0, len(statements))
	for i, statement := range statements {
		kind, _ := ch.Classify(statement)
		validation, elapsed, dryRunErr := client.DryRun(r.Context(), statement)
		if dryRunErr != nil {
			audit.Status = "error"
			audit.DurationMS = time.Since(start).Milliseconds()
			audit.Error = truncate(fmt.Sprintf("statement %d/%d: %v", i+1, len(statements), dryRunErr), 1000)
			s.db.AddAudit(audit)
			writeJSON(w, 400, map[string]any{"error": fmt.Sprintf("statement %d/%d dry run failed: %v", i+1, len(statements), dryRunErr), "failed_statement": i + 1, "checked_statements": i, "statement_count": len(statements), "validation": validation})
			return
		}
		results = append(results, map[string]any{"index": i + 1, "kind": kind, "validation": validation, "elapsed_ms": elapsed})
	}
	audit.DurationMS = time.Since(start).Milliseconds()
	audit.Rows = len(statements)
	s.db.AddAudit(audit)
	writeJSON(w, 200, map[string]any{"kind": "dry_run", "statement_count": len(statements), "checked_statements": len(statements), "elapsed_ms": audit.DurationMS, "statements": results})
}
func (s *Server) exportDatabaseSchema(w http.ResponseWriter, r *http.Request) {
	ss, _ := getSession(r)
	database := r.URL.Query().Get("database")
	if strings.TrimSpace(database) == "" || len(database) > 256 || strings.IndexByte(database, 0) >= 0 {
		writeErr(w, 400, "valid database is required")
		return
	}
	client, ok := s.clusterClient(ss.ActiveCluster)
	if !ok {
		writeErr(w, 409, "active cluster is no longer available")
		return
	}
	start := time.Now()
	schema, err := client.DatabaseSchema(r.Context(), database)
	audit := store.Audit{User: ss.User.Username, Cluster: ss.ActiveCluster, Action: "schema.export", Statement: database, DurationMS: time.Since(start).Milliseconds(), RemoteAddr: remote(r), Status: "ok"}
	if err != nil {
		audit.Status = "error"
		audit.Error = truncate(err.Error(), 1000)
		s.db.AddAudit(audit)
		writeErr(w, 502, err.Error())
		return
	}
	audit.Rows = len(schema.Objects)
	s.db.AddAudit(audit)
	filename := exportFilename(database)
	w.Header().Set("Content-Type", "application/sql; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("X-Export-Filename", filename)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, renderDatabaseSchema(ss.ActiveCluster, database, schema, time.Now().UTC()))
}

func renderDatabaseSchema(cluster, database string, schema ch.DatabaseSchema, generatedAt time.Time) string {
	var output strings.Builder
	output.WriteString("-- ClickHouse database schema export\n")
	output.WriteString("-- Cluster: " + singleLineComment(cluster) + "\n")
	output.WriteString("-- Database: " + singleLineComment(database) + "\n")
	output.WriteString("-- Generated at: " + generatedAt.Format(time.RFC3339) + "\n\n")
	appendDDL := func(statement string) {
		statement = strings.TrimSpace(statement)
		output.WriteString(statement)
		if !strings.HasSuffix(statement, ";") {
			output.WriteByte(';')
		}
		output.WriteString("\n\n")
	}
	appendDDL(schema.DatabaseStatement)
	for _, object := range schema.Objects {
		output.WriteString("-- " + singleLineComment(object.Engine) + ": " + singleLineComment(object.Name) + "\n")
		appendDDL(object.Statement)
	}
	return output.String()
}

func singleLineComment(value string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(value)
}

func exportFilename(database string) string {
	var name strings.Builder
	for _, r := range database {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' {
			name.WriteRune(r)
		} else {
			name.WriteByte('_')
		}
	}
	if name.Len() == 0 {
		name.WriteString("database")
	}
	return name.String() + "-schema.sql"
}
func (s *Server) monitor(w http.ResponseWriter, r *http.Request) {
	ss, _ := getSession(r)
	client, ok := s.clusterClient(ss.ActiveCluster)
	if !ok {
		writeErr(w, 409, "active cluster is no longer available")
		return
	}
	snapshot, err := client.Monitor(r.Context())
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]any{"cluster": ss.ActiveCluster, "snapshot": snapshot})
}

type credentialEnvelope struct {
	Key        string `json:"key"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

type clusterRequest struct {
	Alias             string             `json:"alias"`
	URL               string             `json:"url"`
	Database          string             `json:"database"`
	UpdateCredentials bool               `json:"update_credentials"`
	Credentials       credentialEnvelope `json:"credentials"`
}

func (s *Server) listClusters(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	items := make([]map[string]any, 0, len(s.aliases))
	for _, alias := range s.aliases {
		items = append(items, clusterJSON(s.clusters[alias]))
	}
	s.mu.RUnlock()
	writeJSON(w, 200, items)
}

func (s *Server) transportKey(w http.ResponseWriter, r *http.Request) {
	key, err := s.transportPrivateKey()
	if err != nil {
		writeErr(w, 500, "unable to initialize credential encryption")
		return
	}
	exponent := key.PublicKey.E
	exponentBytes := []byte{byte(exponent >> 16), byte(exponent >> 8), byte(exponent)}
	for len(exponentBytes) > 1 && exponentBytes[0] == 0 {
		exponentBytes = exponentBytes[1:]
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, 200, map[string]string{
		"kty": "RSA", "alg": "RSA-OAEP-256", "use": "enc",
		"n": base64.RawURLEncoding.EncodeToString(key.PublicKey.N.Bytes()),
		"e": base64.RawURLEncoding.EncodeToString(exponentBytes),
	})
}

func (s *Server) createCluster(w http.ResponseWriter, r *http.Request) {
	ss, _ := getSession(r)
	var in clusterRequest
	if !decode(w, r, &in) {
		return
	}
	user, password, err := s.decryptCredentials(in.Credentials)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	s.mu.Lock()
	for alias := range s.clusters {
		if strings.EqualFold(alias, strings.TrimSpace(in.Alias)) {
			s.mu.Unlock()
			writeErr(w, 400, "cluster alias already exists")
			return
		}
	}
	created, err := s.platform.Create(clusterconfig.Input{Alias: in.Alias, URL: in.URL, Database: in.Database, User: user, Password: password})
	if err == nil {
		cluster := Cluster{ID: created.ID, Alias: created.Alias, URL: created.URL, Database: created.Database, Source: "platform", Client: ch.New(created.URL, user, password, created.Database, s.maxRows, s.timeout)}
		s.clusters[created.Alias] = cluster
		s.aliases = append(s.aliases, created.Alias)
	}
	s.mu.Unlock()
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	s.db.AddAudit(store.Audit{User: ss.User.Username, Cluster: created.Alias, Action: "cluster.create", Statement: created.Alias, Status: "ok", RemoteAddr: remote(r)})
	writeJSON(w, 201, map[string]any{"cluster": publicClusterJSON(created), "aliases": s.clusterAliases()})
}

func (s *Server) updateCluster(w http.ResponseWriter, r *http.Request) {
	ss, _ := getSession(r)
	var in clusterRequest
	if !decode(w, r, &in) {
		return
	}
	user, password := "", ""
	var err error
	if in.UpdateCredentials {
		user, password, err = s.decryptCredentials(in.Credentials)
		if err != nil {
			writeErr(w, 400, err.Error())
			return
		}
	}
	s.mu.Lock()
	var current Cluster
	for _, cluster := range s.clusters {
		if cluster.ID == r.PathValue("id") && cluster.Source == "platform" {
			current = cluster
			break
		}
	}
	if current.ID == "" {
		s.mu.Unlock()
		writeErr(w, 404, "platform cluster not found")
		return
	}
	updated, config, err := s.platform.Update(current.ID, clusterconfig.Input{Alias: current.Alias, URL: in.URL, Database: in.Database, User: user, Password: password}, in.UpdateCredentials)
	if err == nil {
		s.clusters[current.Alias] = Cluster{ID: updated.ID, Alias: updated.Alias, URL: updated.URL, Database: updated.Database, Source: "platform", Client: ch.New(updated.URL, config.User, config.Password, updated.Database, s.maxRows, s.timeout)}
	}
	s.mu.Unlock()
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	s.db.AddAudit(store.Audit{User: ss.User.Username, Cluster: updated.Alias, Action: "cluster.update", Statement: updated.Alias, Status: "ok", RemoteAddr: remote(r)})
	writeJSON(w, 200, map[string]any{"cluster": publicClusterJSON(updated)})
}

func (s *Server) deleteCluster(w http.ResponseWriter, r *http.Request) {
	ss, _ := getSession(r)
	s.mu.Lock()
	var target Cluster
	for _, cluster := range s.clusters {
		if cluster.ID == r.PathValue("id") && cluster.Source == "platform" {
			target = cluster
			break
		}
	}
	if target.ID == "" {
		s.mu.Unlock()
		writeErr(w, 404, "platform cluster not found")
		return
	}
	for _, active := range s.sessions {
		if active.ActiveCluster == target.Alias {
			s.mu.Unlock()
			writeErr(w, 409, "cluster is active in a user session and cannot be deleted")
			return
		}
	}
	if err := s.platform.Delete(target.ID); err != nil {
		s.mu.Unlock()
		writeErr(w, 400, err.Error())
		return
	}
	delete(s.clusters, target.Alias)
	for i, alias := range s.aliases {
		if alias == target.Alias {
			s.aliases = append(s.aliases[:i], s.aliases[i+1:]...)
			break
		}
	}
	s.mu.Unlock()
	s.db.AddAudit(store.Audit{User: ss.User.Username, Cluster: target.Alias, Action: "cluster.delete", Statement: target.Alias, Status: "ok", RemoteAddr: remote(r)})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) transportPrivateKey() (*rsa.PrivateKey, error) {
	s.keyOnce.Do(func() { s.key, s.keyErr = rsa.GenerateKey(rand.Reader, 2048) })
	return s.key, s.keyErr
}

func (s *Server) decryptCredentials(envelope credentialEnvelope) (string, string, error) {
	plain, err := s.decryptEnvelope(envelope)
	if err != nil {
		return "", "", err
	}
	defer clear(plain)
	var credentials struct {
		User     string `json:"user"`
		Password string `json:"password"`
	}
	if err = json.Unmarshal(plain, &credentials); err != nil || strings.TrimSpace(credentials.User) == "" {
		return "", "", errors.New("invalid credential payload")
	}
	return credentials.User, credentials.Password, nil
}

func (s *Server) decryptEnvelope(envelope credentialEnvelope) ([]byte, error) {
	key, err := s.transportPrivateKey()
	if err != nil {
		return nil, errors.New("credential encryption is unavailable")
	}
	wrapped, err := base64.StdEncoding.DecodeString(envelope.Key)
	if err != nil || len(wrapped) > 512 {
		return nil, errors.New("invalid encrypted credential key")
	}
	aesKey, err := rsa.DecryptOAEP(sha256.New(), rand.Reader, key, wrapped, nil)
	if err != nil || len(aesKey) != 32 {
		return nil, errors.New("unable to decrypt credentials")
	}
	defer clear(aesKey)
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		return nil, errors.New("unable to decrypt credentials")
	}
	var aead cipher.AEAD
	if aead, err = cipher.NewGCM(block); err != nil {
		return nil, errors.New("unable to decrypt credentials")
	}
	nonce, nonceErr := base64.StdEncoding.DecodeString(envelope.Nonce)
	ciphertext, cipherErr := base64.StdEncoding.DecodeString(envelope.Ciphertext)
	if nonceErr != nil || cipherErr != nil || len(nonce) != aead.NonceSize() || len(ciphertext) > 8192 {
		return nil, errors.New("invalid encrypted credentials")
	}
	plain, err := aead.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, errors.New("unable to decrypt credentials")
	}
	return plain, nil
}

func clusterJSON(cluster Cluster) map[string]any {
	return map[string]any{"id": cluster.ID, "alias": cluster.Alias, "url": publicClusterURL(cluster.URL), "database": cluster.Database, "source": cluster.Source, "credentials_configured": true}
}

func publicClusterJSON(cluster clusterconfig.Public) map[string]any {
	return map[string]any{"id": cluster.ID, "alias": cluster.Alias, "url": cluster.URL, "database": cluster.Database, "source": "platform", "credentials_configured": cluster.CredentialsConfigured, "created_at": cluster.CreatedAt, "updated_at": cluster.UpdatedAt}
}

func publicClusterURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "invalid endpoint"
	}
	parsed.User = nil
	query := parsed.Query()
	for _, key := range []string{"password", "user", "key"} {
		query.Del(key)
	}
	parsed.RawQuery = query.Encode()
	return parsed.String()
}
func (s *Server) users(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, s.db.Users()) }
func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	ss, _ := getSession(r)
	var in struct{ Username, Password, Role string }
	if !decode(w, r, &in) {
		return
	}
	u, err := s.db.CreateUser(in.Username, in.Password, in.Role)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	s.db.AddAudit(store.Audit{User: ss.User.Username, Cluster: ss.ActiveCluster, Action: "user.create", Statement: u.Username + " (" + u.Role + ")", Status: "ok", RemoteAddr: remote(r)})
	writeJSON(w, 201, u)
}
func (s *Server) updateUser(w http.ResponseWriter, r *http.Request) {
	ss, _ := getSession(r)
	var in struct {
		Role, Password string
		Disabled       *bool
	}
	if !decode(w, r, &in) {
		return
	}
	if r.PathValue("id") == ss.User.ID && ((in.Disabled != nil && *in.Disabled) || (in.Role != "" && in.Role != "admin")) {
		writeErr(w, 400, "you cannot disable or demote your current account")
		return
	}
	u, err := s.db.UpdateUser(r.PathValue("id"), in.Role, in.Password, in.Disabled)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	s.db.AddAudit(store.Audit{User: ss.User.Username, Cluster: ss.ActiveCluster, Action: "user.update", Statement: u.Username + " (" + u.Role + ")", Status: "ok", RemoteAddr: remote(r)})
	writeJSON(w, 200, u)
}
func (s *Server) audit(w http.ResponseWriter, r *http.Request) {
	n, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	writeJSON(w, 200, s.db.Audits(n))
}
func (s *Server) sessionResponse(ss session) map[string]any {
	aliases := s.clusterAliases()
	clusters := make([]map[string]string, 0, len(aliases))
	for _, alias := range aliases {
		clusters = append(clusters, map[string]string{"alias": alias})
	}
	return map[string]any{"user": ss.User, "csrf": ss.CSRF, "clusters": clusters, "active_cluster": ss.ActiveCluster}
}

func (s *Server) clusterClient(alias string) (*ch.Client, bool) {
	s.mu.RLock()
	cluster, ok := s.clusters[alias]
	s.mu.RUnlock()
	return cluster.Client, ok
}

func (s *Server) clusterAliases() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]string(nil), s.aliases...)
}
func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("ch_session")
		if err != nil {
			writeErr(w, 401, "authentication required")
			return
		}
		s.mu.RLock()
		ss, ok := s.sessions[c.Value]
		s.mu.RUnlock()
		if !ok || time.Now().After(ss.Expires) {
			writeErr(w, 401, "session expired")
			return
		}
		current, ok := s.db.User(ss.User.ID)
		if !ok || current.Disabled {
			s.mu.Lock()
			delete(s.sessions, c.Value)
			s.mu.Unlock()
			writeErr(w, 401, "account is disabled")
			return
		}
		ss.User = current
		if r.Method != "GET" && r.Header.Get("X-CSRF-Token") != ss.CSRF {
			writeErr(w, 403, "invalid CSRF token")
			return
		}
		next(w, r.WithContext(withSession(r.Context(), ss)))
	}
}
func (s *Server) admin(next http.HandlerFunc) http.HandlerFunc {
	return s.auth(func(w http.ResponseWriter, r *http.Request) {
		ss, _ := getSession(r)
		if ss.User.Role != "admin" {
			writeErr(w, 403, "admin role required")
			return
		}
		next(w, r)
	})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		writeErr(w, 400, "invalid JSON body")
		return false
	}
	return true
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'")
		next.ServeHTTP(w, r)
	})
}
func token() string { b := make([]byte, 32); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func remote(r *http.Request) string {
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return h
	}
	return r.RemoteAddr
}
func truncate(v string, n int) string {
	if len(v) > n {
		return v[:n]
	}
	return v
}
