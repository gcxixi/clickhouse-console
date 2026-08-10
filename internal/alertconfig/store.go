package alertconfig

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gcxixi/clickhouse-console/internal/clusterconfig"
)

type Config struct {
	Enabled, Configured bool
	Driver, DSN, Source string
	HistoryLimit        int
	UpdatedAt           time.Time
}

type Public struct {
	Enabled               bool      `json:"enabled"`
	Configured            bool      `json:"configured"`
	Driver                string    `json:"driver"`
	Source                string    `json:"source"`
	HistoryLimit          int       `json:"history_limit"`
	CredentialsConfigured bool      `json:"credentials_configured"`
	UpdatedAt             time.Time `json:"updated_at,omitempty"`
	Running               bool      `json:"running"`
	Error                 string    `json:"error,omitempty"`
}

type diskData struct {
	Enabled      bool      `json:"enabled"`
	Driver       string    `json:"driver"`
	DSNEncrypted string    `json:"dsn_encrypted"`
	HistoryLimit int       `json:"history_limit"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type Store struct {
	mu   sync.RWMutex
	path string
	aead cipher.AEAD
	data diskData
}

func Open(dir, configuredKey string) (*Store, error) {
	key, err := clusterconfig.LoadEncryptionKey(dir, configuredKey)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "platform-alerting.json"), aead: aead}
	data, err := os.ReadFile(s.path)
	if err == nil {
		if err = json.Unmarshal(data, &s.data); err != nil {
			return nil, fmt.Errorf("decode platform alerting store: %w", err)
		}
		if s.data.DSNEncrypted != "" {
			if _, err = s.decrypt(s.data.DSNEncrypted); err != nil {
				return nil, fmt.Errorf("decrypt platform alerting configuration: %w", err)
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return s, nil
}

func (s *Store) Config() (Config, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.data.DSNEncrypted == "" {
		return Config{HistoryLimit: normalizedLimit(s.data.HistoryLimit), Source: "platform"}, nil
	}
	dsn, err := s.decrypt(s.data.DSNEncrypted)
	if err != nil {
		return Config{}, err
	}
	return Config{Enabled: s.data.Enabled, Configured: true, Driver: s.data.Driver, DSN: dsn, Source: "platform", HistoryLimit: normalizedLimit(s.data.HistoryLimit), UpdatedAt: s.data.UpdatedAt}, nil
}
func (s *Store) Public() Public {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return Public{Enabled: s.data.Enabled, Configured: s.data.DSNEncrypted != "", Driver: s.data.Driver, Source: "platform", HistoryLimit: normalizedLimit(s.data.HistoryLimit), CredentialsConfigured: s.data.DSNEncrypted != "", UpdatedAt: s.data.UpdatedAt}
}

func (s *Store) Save(enabled bool, driver, dsn string, historyLimit int, updateDSN bool) (Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	driver = strings.ToLower(strings.TrimSpace(driver))
	if driver != "sqlite" && driver != "postgres" && driver != "mysql" {
		return Config{}, errors.New("driver must be sqlite, postgres, or mysql")
	}
	if historyLimit < 10 || historyLimit > 10000 {
		return Config{}, errors.New("history limit must be between 10 and 10000")
	}
	original := s.data
	if updateDSN {
		dsn = strings.TrimSpace(dsn)
		if dsn == "" {
			return Config{}, errors.New("database connection string is required")
		}
		encrypted, err := s.encrypt(dsn)
		if err != nil {
			return Config{}, err
		}
		s.data.DSNEncrypted = encrypted
	} else if s.data.DSNEncrypted == "" {
		return Config{}, errors.New("database connection string is required")
	}
	s.data.Enabled, s.data.Driver, s.data.HistoryLimit, s.data.UpdatedAt = enabled, driver, historyLimit, time.Now().UTC()
	if err := s.saveLocked(); err != nil {
		s.data = original
		return Config{}, err
	}
	plain, err := s.decrypt(s.data.DSNEncrypted)
	if err != nil {
		return Config{}, err
	}
	return Config{Enabled: enabled, Configured: true, Driver: driver, DSN: plain, Source: "platform", HistoryLimit: historyLimit, UpdatedAt: s.data.UpdatedAt}, nil
}

func (s *Store) encrypt(value string) (string, error) {
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.RawStdEncoding.EncodeToString(s.aead.Seal(nonce, nonce, []byte(value), nil)), nil
}
func (s *Store) decrypt(value string) (string, error) {
	sealed, err := base64.RawStdEncoding.DecodeString(value)
	if err != nil || len(sealed) < s.aead.NonceSize() {
		return "", errors.New("invalid encrypted alerting configuration")
	}
	plain, err := s.aead.Open(nil, sealed[:s.aead.NonceSize()], sealed[s.aead.NonceSize():], nil)
	if err != nil {
		return "", errors.New("invalid encryption key or alerting configuration")
	}
	return string(plain), nil
}
func (s *Store) saveLocked() error {
	data, err := json.MarshalIndent(s.data, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err = os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
func normalizedLimit(value int) int {
	if value < 10 || value > 10000 {
		return 300
	}
	return value
}
