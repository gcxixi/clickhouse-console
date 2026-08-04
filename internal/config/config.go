package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Cluster struct {
	Alias    string `json:"alias"`
	URL      string `json:"url"`
	User     string `json:"user"`
	Password string `json:"password"`
	Database string `json:"database"`
}

type Config struct {
	Listen, DataDir, BasePath string
	Clusters                  []Cluster
	AdminUser, AdminPassword  string
	EncryptionKey             string
	QueryTimeout              time.Duration
	MaxRows                   int
}

var clusterAliasPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func Load() (Config, error) {
	c := Config{
		Listen: env("CH_CONSOLE_LISTEN", ":8080"), DataDir: env("CH_CONSOLE_DATA_DIR", "./data"),
		BasePath:  os.Getenv("CH_CONSOLE_BASE_PATH"),
		AdminUser: env("CH_CONSOLE_ADMIN_USER", "admin"), AdminPassword: os.Getenv("CH_CONSOLE_ADMIN_PASSWORD"),
		EncryptionKey: os.Getenv("CH_CONSOLE_ENCRYPTION_KEY"),
	}
	var err error
	c.BasePath, err = normalizeBasePath(c.BasePath)
	if err != nil {
		return c, err
	}
	c.QueryTimeout, err = time.ParseDuration(env("CH_CONSOLE_QUERY_TIMEOUT", "60s"))
	if err != nil || c.QueryTimeout <= 0 {
		return c, fmt.Errorf("invalid CH_CONSOLE_QUERY_TIMEOUT")
	}
	c.MaxRows, err = strconv.Atoi(env("CH_CONSOLE_MAX_ROWS", "1000"))
	if err != nil || c.MaxRows < 1 || c.MaxRows > 100000 {
		return c, fmt.Errorf("CH_CONSOLE_MAX_ROWS must be between 1 and 100000")
	}
	c.Clusters, err = loadClusters()
	if err != nil {
		return c, err
	}
	return c, nil
}

func loadClusters() ([]Cluster, error) {
	raw := strings.TrimSpace(os.Getenv("CH_CONSOLE_CLUSTERS"))
	clusters := []Cluster(nil)
	if raw == "" {
		clusters = []Cluster{{
			Alias: env("CLICKHOUSE_ALIAS", "default"), URL: env("CLICKHOUSE_URL", "http://127.0.0.1:8123"),
			User: env("CLICKHOUSE_USER", "default"), Password: os.Getenv("CLICKHOUSE_PASSWORD"), Database: env("CLICKHOUSE_DATABASE", "default"),
		}}
	} else if err := json.Unmarshal([]byte(raw), &clusters); err != nil {
		return nil, fmt.Errorf("CH_CONSOLE_CLUSTERS must be a JSON array: %w", err)
	}
	if len(clusters) == 0 {
		return nil, fmt.Errorf("at least one ClickHouse cluster is required")
	}
	seen := make(map[string]struct{}, len(clusters))
	for i := range clusters {
		cluster := &clusters[i]
		cluster.Alias = strings.TrimSpace(cluster.Alias)
		cluster.URL = strings.TrimSpace(cluster.URL)
		cluster.User = strings.TrimSpace(cluster.User)
		cluster.Database = strings.TrimSpace(cluster.Database)
		if cluster.User == "" {
			cluster.User = "default"
		}
		if cluster.Database == "" {
			cluster.Database = "default"
		}
		if !clusterAliasPattern.MatchString(cluster.Alias) {
			return nil, fmt.Errorf("cluster %d alias must match %s", i+1, clusterAliasPattern.String())
		}
		aliasKey := strings.ToLower(cluster.Alias)
		if _, ok := seen[aliasKey]; ok {
			return nil, fmt.Errorf("duplicate ClickHouse cluster alias %q", cluster.Alias)
		}
		seen[aliasKey] = struct{}{}
		u, err := url.Parse(cluster.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, fmt.Errorf("ClickHouse cluster %q URL must be a valid http(s) URL", cluster.Alias)
		}
	}
	return clusters, nil
}

func normalizeBasePath(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || value == "/" {
		return "", nil
	}
	if !strings.HasPrefix(value, "/") || strings.ContainsAny(value, "?#%\\") {
		return "", fmt.Errorf("CH_CONSOLE_BASE_PATH must be an absolute URL path such as /clickhouse")
	}
	clean := path.Clean(value)
	if clean == "." || clean == "/" || strings.Contains(value, "//") || strings.Contains(value, "/../") || strings.HasSuffix(value, "/..") {
		return "", fmt.Errorf("invalid CH_CONSOLE_BASE_PATH")
	}
	return clean, nil
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
