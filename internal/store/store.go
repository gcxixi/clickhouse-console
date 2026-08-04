package store

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

type User struct {
	ID, Username, Role, PasswordHash string
	Disabled                         bool
	CreatedAt, UpdatedAt             time.Time
}
type PublicUser struct {
	ID, Username, Role   string
	Disabled             bool
	CreatedAt, UpdatedAt time.Time
}
type Audit struct {
	ID, User, Cluster, Action, Statement, Status, Error, RemoteAddr string
	DurationMS                                                      int64
	Rows                                                            int
	At                                                              time.Time
}
type diskData struct {
	Users  []User  `json:"users"`
	Audits []Audit `json:"audits"`
}
type Store struct {
	mu   sync.RWMutex
	path string
	data diskData
}

func Open(dir, adminUser, adminPassword string) (*Store, string, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, "", err
	}
	s := &Store{path: filepath.Join(dir, "console.json")}
	b, err := os.ReadFile(s.path)
	if err == nil {
		if err = json.Unmarshal(b, &s.data); err != nil {
			return nil, "", fmt.Errorf("decode data store: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, "", err
	}
	generated := ""
	if len(s.data.Users) == 0 {
		if adminPassword == "" {
			generated, err = randomToken(18)
			if err != nil {
				return nil, "", err
			}
			adminPassword = generated
		}
		if err = validatePassword(adminPassword); err != nil {
			return nil, "", err
		}
		h, _ := bcrypt.GenerateFromPassword([]byte(adminPassword), bcrypt.DefaultCost)
		id, _ := randomToken(12)
		now := time.Now().UTC()
		s.data.Users = append(s.data.Users, User{ID: id, Username: adminUser, Role: "admin", PasswordHash: string(h), CreatedAt: now, UpdatedAt: now})
		if err = s.saveLocked(); err != nil {
			return nil, "", err
		}
	}
	return s, generated, nil
}

func (s *Store) Authenticate(username, password string) (PublicUser, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, u := range s.data.Users {
		if strings.EqualFold(u.Username, strings.TrimSpace(username)) && !u.Disabled && bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(password)) == nil {
			return public(u), true
		}
	}
	return PublicUser{}, false
}
func (s *Store) Users() []PublicUser {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]PublicUser, 0, len(s.data.Users))
	for _, u := range s.data.Users {
		out = append(out, public(u))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Username < out[j].Username })
	return out
}
func (s *Store) User(id string) (PublicUser, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, u := range s.data.Users {
		if u.ID == id {
			return public(u), true
		}
	}
	return PublicUser{}, false
}
func (s *Store) CreateUser(username, password, role string) (PublicUser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	username = strings.TrimSpace(username)
	if username == "" || len(username) > 64 {
		return PublicUser{}, errors.New("username must be 1-64 characters")
	}
	if !validRole(role) {
		return PublicUser{}, errors.New("invalid role")
	}
	if err := validatePassword(password); err != nil {
		return PublicUser{}, err
	}
	for _, u := range s.data.Users {
		if strings.EqualFold(u.Username, username) {
			return PublicUser{}, errors.New("username already exists")
		}
	}
	h, _ := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	id, _ := randomToken(12)
	now := time.Now().UTC()
	u := User{ID: id, Username: username, Role: role, PasswordHash: string(h), CreatedAt: now, UpdatedAt: now}
	s.data.Users = append(s.data.Users, u)
	return public(u), s.saveLocked()
}
func (s *Store) UpdateUser(id, role, password string, disabled *bool) (PublicUser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.data.Users {
		u := &s.data.Users[i]
		if u.ID != id {
			continue
		}
		if (role != "" && role != "admin" || disabled != nil && *disabled) && u.Role == "admin" && !u.Disabled && s.activeAdminsLocked() == 1 {
			return PublicUser{}, errors.New("at least one active administrator is required")
		}
		if role != "" {
			if !validRole(role) {
				return PublicUser{}, errors.New("invalid role")
			}
			u.Role = role
		}
		if password != "" {
			if err := validatePassword(password); err != nil {
				return PublicUser{}, err
			}
			h, _ := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
			u.PasswordHash = string(h)
		}
		if disabled != nil {
			u.Disabled = *disabled
		}
		u.UpdatedAt = time.Now().UTC()
		return public(*u), s.saveLocked()
	}
	return PublicUser{}, errors.New("user not found")
}
func (s *Store) activeAdminsLocked() int {
	n := 0
	for _, u := range s.data.Users {
		if u.Role == "admin" && !u.Disabled {
			n++
		}
	}
	return n
}
func (s *Store) AddAudit(a Audit) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a.ID, _ = randomToken(12)
	a.At = time.Now().UTC()
	s.data.Audits = append(s.data.Audits, a)
	if len(s.data.Audits) > 5000 {
		s.data.Audits = s.data.Audits[len(s.data.Audits)-5000:]
	}
	_ = s.saveLocked()
}
func (s *Store) Audits(limit int) []Audit {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if limit < 1 || limit > 500 {
		limit = 100
	}
	start := len(s.data.Audits) - limit
	if start < 0 {
		start = 0
	}
	out := append([]Audit(nil), s.data.Audits[start:]...)
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}
func (s *Store) saveLocked() error {
	b, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err = os.WriteFile(tmp, b, 0600); err != nil {
		return fmt.Errorf("write data store %q: %w (check CH_CONSOLE_DATA_DIR permissions)", tmp, err)
	}
	if err = os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("replace data store %q: %w", s.path, err)
	}
	return nil
}
func public(u User) PublicUser {
	return PublicUser{ID: u.ID, Username: u.Username, Role: u.Role, Disabled: u.Disabled, CreatedAt: u.CreatedAt, UpdatedAt: u.UpdatedAt}
}
func validRole(r string) bool { return r == "viewer" || r == "editor" || r == "admin" }
func validatePassword(p string) error {
	if len(p) < 12 {
		return errors.New("password must contain at least 12 characters")
	}
	if len(p) > 256 {
		return errors.New("password is too long")
	}
	return nil
}
func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
