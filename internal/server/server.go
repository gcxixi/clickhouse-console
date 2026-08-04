package server

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"

	ch "github.com/gcxixi/clickhouse-console/internal/clickhouse"
	"github.com/gcxixi/clickhouse-console/internal/store"
)

//go:embed web/*
var webFS embed.FS

type session struct {
	User    store.PublicUser
	CSRF    string
	Expires time.Time
}
type Server struct {
	db         *store.Store
	ch         *ch.Client
	log        *slog.Logger
	mu         sync.RWMutex
	sessions   map[string]session
	basePath   string
	cookiePath string
}

func New(db *store.Store, chc *ch.Client, log *slog.Logger, basePath string) http.Handler {
	cookiePath := "/"
	if basePath != "" {
		cookiePath = basePath + "/"
	}
	s := &Server{db: db, ch: chc, log: log, sessions: map[string]session{}, basePath: basePath, cookiePath: cookiePath}
	m := http.NewServeMux()
	m.HandleFunc("POST /api/login", s.login)
	m.HandleFunc("POST /api/logout", s.auth(s.logout))
	m.HandleFunc("GET /api/session", s.auth(s.getSession))
	m.HandleFunc("GET /api/health", s.auth(s.health))
	m.HandleFunc("POST /api/query", s.auth(s.query))
	m.HandleFunc("GET /api/users", s.admin(s.users))
	m.HandleFunc("POST /api/users", s.admin(s.createUser))
	m.HandleFunc("PATCH /api/users/{id}", s.admin(s.updateUser))
	m.HandleFunc("GET /api/audit", s.admin(s.audit))
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
	s.mu.Lock()
	s.sessions[sid] = session{User: u, CSRF: csrf, Expires: time.Now().Add(12 * time.Hour)}
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "ch_session", Value: sid, Path: s.cookiePath, HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https", MaxAge: 43200})
	s.db.AddAudit(store.Audit{User: u.Username, Action: "login", Status: "ok", RemoteAddr: remote(r)})
	writeJSON(w, 200, map[string]any{"user": u, "csrf": csrf})
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
	writeJSON(w, 200, map[string]any{"user": ss.User, "csrf": ss.CSRF})
}
func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	err := s.ch.Ping(r.Context())
	if err != nil {
		writeJSON(w, 503, map[string]any{"status": "down", "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]string{"status": "ok"})
}
func (s *Server) query(w http.ResponseWriter, r *http.Request) {
	ss, _ := getSession(r)
	var in struct {
		SQL string `json:"sql"`
	}
	if !decode(w, r, &in) {
		return
	}
	kind, err := ch.Classify(in.SQL)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if ss.User.Role == "viewer" && kind != "query" {
		writeErr(w, 403, "viewer role can only run read queries")
		return
	}
	if ss.User.Role == "editor" && kind == "ddl" {
		writeErr(w, 403, "admin role is required for DDL")
		return
	}
	start := time.Now()
	res, err := s.ch.Execute(r.Context(), in.SQL)
	a := store.Audit{User: ss.User.Username, Action: kind, Statement: truncate(in.SQL, 2000), DurationMS: time.Since(start).Milliseconds(), RemoteAddr: remote(r), Status: "ok"}
	if err != nil {
		a.Status = "error"
		a.Error = truncate(err.Error(), 1000)
		s.db.AddAudit(a)
		writeErr(w, 400, err.Error())
		return
	}
	a.Rows = res.Rows
	s.db.AddAudit(a)
	writeJSON(w, 200, res)
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
	s.db.AddAudit(store.Audit{User: ss.User.Username, Action: "user.create", Statement: u.Username + " (" + u.Role + ")", Status: "ok", RemoteAddr: remote(r)})
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
	s.db.AddAudit(store.Audit{User: ss.User.Username, Action: "user.update", Statement: u.Username + " (" + u.Role + ")", Status: "ok", RemoteAddr: remote(r)})
	writeJSON(w, 200, u)
}
func (s *Server) audit(w http.ResponseWriter, r *http.Request) {
	n, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	writeJSON(w, 200, s.db.Audits(n))
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
