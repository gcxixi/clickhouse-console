package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Listen, DataDir, ClickHouseURL, ClickHouseUser, ClickHousePassword, Database string
	AdminUser, AdminPassword                                                     string
	QueryTimeout                                                                 time.Duration
	MaxRows                                                                      int
}

func Load() (Config, error) {
	c := Config{
		Listen: env("CH_CONSOLE_LISTEN", ":8080"), DataDir: env("CH_CONSOLE_DATA_DIR", "./data"),
		ClickHouseURL: env("CLICKHOUSE_URL", "http://127.0.0.1:8123"), ClickHouseUser: env("CLICKHOUSE_USER", "default"),
		ClickHousePassword: os.Getenv("CLICKHOUSE_PASSWORD"), Database: env("CLICKHOUSE_DATABASE", "default"),
		AdminUser: env("CH_CONSOLE_ADMIN_USER", "admin"), AdminPassword: os.Getenv("CH_CONSOLE_ADMIN_PASSWORD"),
	}
	var err error
	c.QueryTimeout, err = time.ParseDuration(env("CH_CONSOLE_QUERY_TIMEOUT", "60s"))
	if err != nil || c.QueryTimeout <= 0 {
		return c, fmt.Errorf("invalid CH_CONSOLE_QUERY_TIMEOUT")
	}
	c.MaxRows, err = strconv.Atoi(env("CH_CONSOLE_MAX_ROWS", "1000"))
	if err != nil || c.MaxRows < 1 || c.MaxRows > 100000 {
		return c, fmt.Errorf("CH_CONSOLE_MAX_ROWS must be between 1 and 100000")
	}
	u, err := url.Parse(c.ClickHouseURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return c, fmt.Errorf("CLICKHOUSE_URL must be a valid http(s) URL")
	}
	return c, nil
}

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
