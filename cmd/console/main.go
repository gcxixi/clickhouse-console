package main

import (
	"log/slog"
	"net/http"
	"os"
	"time"

	ch "github.com/gcxixi/clickhouse-console/internal/clickhouse"
	"github.com/gcxixi/clickhouse-console/internal/config"
	"github.com/gcxixi/clickhouse-console/internal/server"
	"github.com/gcxixi/clickhouse-console/internal/store"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	cfg, err := config.Load()
	if err != nil {
		log.Error("configuration error", "error", err)
		os.Exit(1)
	}
	db, generated, err := store.Open(cfg.DataDir, cfg.AdminUser, cfg.AdminPassword)
	if err != nil {
		log.Error("data store error", "error", err)
		os.Exit(1)
	}
	if generated != "" {
		log.Warn("bootstrap administrator created; save this password now", "username", cfg.AdminUser, "password", generated)
	}
	client := ch.New(cfg.ClickHouseURL, cfg.ClickHouseUser, cfg.ClickHousePassword, cfg.Database, cfg.MaxRows, cfg.QueryTimeout)
	srv := &http.Server{Addr: cfg.Listen, Handler: server.New(db, client, log), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: cfg.QueryTimeout + 10*time.Second, IdleTimeout: 90 * time.Second}
	log.Info("clickhouse console listening", "address", cfg.Listen)
	if err = srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
