package clusterconfig

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const keySize = 32

var aliasPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

type Config struct {
	ID, Alias, URL, User, Password, Database string
	CreatedAt, UpdatedAt                     time.Time
}

type Public struct {
	ID, Alias, URL, Database string
	CredentialsConfigured    bool
	CreatedAt, UpdatedAt     time.Time
}

type Input struct {
	Alias, URL, User, Password, Database string
}

type record struct {
	ID, Alias, URL, Database, Credentials string
	CreatedAt, UpdatedAt                  time.Time
}

type diskData struct {
	Clusters []record `json:"clusters"`
}

type Store struct {
	mu   sync.RWMutex
	path string
	aead cipher.AEAD
	data diskData
}

func Open(dir, configuredKey string) (*Store, error) {
	key, err := loadKey(dir, configuredKey)
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
	s := &Store{path: filepath.Join(dir, "platform-clusters.json"), aead: aead}
	data, err := os.ReadFile(s.path)
	if err == nil {
		if err = json.Unmarshal(data, &s.data); err != nil {
			return nil, fmt.Errorf("decode platform cluster store: %w", err)
		}
		for _, item := range s.data.Clusters {
			if _, _, err = s.decrypt(item.Credentials); err != nil {
				return nil, fmt.Errorf("decrypt platform cluster %q: %w", item.Alias, err)
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return s, nil
}

func (s *Store) List() []Public {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Public, 0, len(s.data.Clusters))
	for _, item := range s.data.Clusters {
		out = append(out, public(item))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Alias < out[j].Alias })
	return out
}

func (s *Store) Configs() ([]Config, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Config, 0, len(s.data.Clusters))
	for _, item := range s.data.Clusters {
		user, password, err := s.decrypt(item.Credentials)
		if err != nil {
			return nil, err
		}
		out = append(out, Config{ID: item.ID, Alias: item.Alias, URL: item.URL, User: user, Password: password, Database: item.Database, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt})
	}
	return out, nil
}

func (s *Store) Create(input Input) (Public, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := validate(input, true); err != nil {
		return Public{}, err
	}
	for _, item := range s.data.Clusters {
		if strings.EqualFold(item.Alias, input.Alias) {
			return Public{}, errors.New("cluster alias already exists")
		}
	}
	credentials, err := s.encrypt(input.User, input.Password)
	if err != nil {
		return Public{}, err
	}
	id, err := randomID()
	if err != nil {
		return Public{}, err
	}
	now := time.Now().UTC()
	item := record{ID: id, Alias: strings.TrimSpace(input.Alias), URL: strings.TrimSpace(input.URL), Database: normalizedDatabase(input.Database), Credentials: credentials, CreatedAt: now, UpdatedAt: now}
	s.data.Clusters = append(s.data.Clusters, item)
	if err = s.saveLocked(); err != nil {
		s.data.Clusters = s.data.Clusters[:len(s.data.Clusters)-1]
		return Public{}, err
	}
	return public(item), nil
}

func (s *Store) Update(id string, input Input, updateCredentials bool) (Public, Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := validate(input, updateCredentials); err != nil {
		return Public{}, Config{}, err
	}
	for i := range s.data.Clusters {
		item := &s.data.Clusters[i]
		if item.ID != id {
			continue
		}
		original := *item
		if input.Alias != "" && input.Alias != item.Alias {
			return Public{}, Config{}, errors.New("cluster alias cannot be changed")
		}
		item.URL = strings.TrimSpace(input.URL)
		item.Database = normalizedDatabase(input.Database)
		if updateCredentials {
			credentials, err := s.encrypt(input.User, input.Password)
			if err != nil {
				return Public{}, Config{}, err
			}
			item.Credentials = credentials
		}
		item.UpdatedAt = time.Now().UTC()
		user, password, err := s.decrypt(item.Credentials)
		if err != nil {
			return Public{}, Config{}, err
		}
		config := Config{ID: item.ID, Alias: item.Alias, URL: item.URL, User: user, Password: password, Database: item.Database, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
		if saveErr := s.saveLocked(); saveErr != nil {
			*item = original
			return Public{}, Config{}, saveErr
		}
		return public(*item), config, nil
	}
	return Public{}, Config{}, errors.New("cluster not found")
}

func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, item := range s.data.Clusters {
		if item.ID == id {
			s.data.Clusters = append(s.data.Clusters[:i], s.data.Clusters[i+1:]...)
			if err := s.saveLocked(); err != nil {
				s.data.Clusters = append(s.data.Clusters, record{})
				copy(s.data.Clusters[i+1:], s.data.Clusters[i:])
				s.data.Clusters[i] = item
				return err
			}
			return nil
		}
	}
	return errors.New("cluster not found")
}

func validate(input Input, credentials bool) error {
	alias := strings.TrimSpace(input.Alias)
	if !aliasPattern.MatchString(alias) {
		return errors.New("cluster alias must contain only letters, numbers, dots, underscores, or hyphens")
	}
	parsed, err := url.Parse(strings.TrimSpace(input.URL))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return errors.New("cluster URL must be a valid http(s) URL")
	}
	if parsed.User != nil {
		return errors.New("cluster URL must not contain credentials")
	}
	if len(input.Database) > 256 {
		return errors.New("database name is too long")
	}
	if credentials && (strings.TrimSpace(input.User) == "" || len(input.User) > 256 || len(input.Password) > 1024) {
		return errors.New("ClickHouse credentials are invalid")
	}
	return nil
}

func (s *Store) encrypt(user, password string) (string, error) {
	plain, err := json.Marshal(map[string]string{"user": strings.TrimSpace(user), "password": password})
	if err != nil {
		return "", err
	}
	nonce := make([]byte, s.aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := s.aead.Seal(nonce, nonce, plain, nil)
	return base64.RawStdEncoding.EncodeToString(sealed), nil
}

func (s *Store) decrypt(encoded string) (string, string, error) {
	sealed, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil || len(sealed) < s.aead.NonceSize() {
		return "", "", errors.New("invalid encrypted credentials")
	}
	nonce, ciphertext := sealed[:s.aead.NonceSize()], sealed[s.aead.NonceSize():]
	plain, err := s.aead.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", "", errors.New("invalid encryption key or credentials")
	}
	var credentials map[string]string
	if err = json.Unmarshal(plain, &credentials); err != nil {
		return "", "", errors.New("invalid credential payload")
	}
	return credentials["user"], credentials["password"], nil
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

func public(item record) Public {
	return Public{ID: item.ID, Alias: item.Alias, URL: item.URL, Database: item.Database, CredentialsConfigured: item.Credentials != "", CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
}

func normalizedDatabase(database string) string {
	if value := strings.TrimSpace(database); value != "" {
		return value
	}
	return "default"
}

func loadKey(dir, configured string) ([]byte, error) {
	if strings.TrimSpace(configured) != "" {
		key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(configured))
		if err != nil || len(key) != keySize {
			return nil, errors.New("CH_CONSOLE_ENCRYPTION_KEY must be base64-encoded 32 bytes")
		}
		return key, nil
	}
	path := filepath.Join(dir, "cluster-encryption.key")
	encoded, err := os.ReadFile(path)
	if err == nil {
		key, decodeErr := base64.StdEncoding.DecodeString(strings.TrimSpace(string(encoded)))
		if decodeErr != nil || len(key) != keySize {
			return nil, errors.New("invalid cluster encryption key file")
		}
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key := make([]byte, keySize)
	if _, err = rand.Read(key); err != nil {
		return nil, err
	}
	if err = os.WriteFile(path, []byte(base64.StdEncoding.EncodeToString(key)), 0600); err != nil {
		return nil, fmt.Errorf("write cluster encryption key: %w", err)
	}
	return key, nil
}

func randomID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}
