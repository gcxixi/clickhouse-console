package main

import (
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	ch "github.com/gcxixi/clickhouse-console/internal/clickhouse"
	"github.com/gcxixi/clickhouse-console/internal/clusterconfig"
	"github.com/gcxixi/clickhouse-console/internal/config"
	"github.com/gcxixi/clickhouse-console/internal/datadir"
	"github.com/gcxixi/clickhouse-console/internal/server"
	"github.com/gcxixi/clickhouse-console/internal/store"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if len(os.Args) == 2 && os.Args[1] == "init-data-dir" {
		dir := os.Getenv("CH_CONSOLE_DATA_DIR")
		if dir == "" {
			dir = "/data"
		}
		if err := datadir.Prepare(dir, 65532, 65532); err != nil {
			log.Error("initialize data directory", "error", err)
			os.Exit(1)
		}
		log.Info("data directory initialized", "directory", dir)
		return
	}
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
	platformClusters, err := clusterconfig.Open(cfg.DataDir, cfg.EncryptionKey)
	if err != nil {
		log.Error("platform cluster store error", "error", err)
		os.Exit(1)
	}
	storedClusters, err := platformClusters.Configs()
	if err != nil {
		log.Error("platform cluster configuration error", "error", err)
		os.Exit(1)
	}
	clusters := make([]server.Cluster, 0, len(cfg.Clusters)+len(storedClusters))
	aliases := make(map[string]struct{}, cap(clusters))
	for _, cluster := range cfg.Clusters {
		aliases[strings.ToLower(cluster.Alias)] = struct{}{}
		clusters = append(clusters, server.Cluster{Alias: cluster.Alias, URL: cluster.URL, Database: cluster.Database, Source: "environment", Client: ch.New(cluster.URL, cluster.User, cluster.Password, cluster.Database, cfg.MaxRows, cfg.QueryTimeout)})
	}
	for _, cluster := range storedClusters {
		if _, exists := aliases[strings.ToLower(cluster.Alias)]; exists {
			log.Error("duplicate platform and environment cluster alias", "alias", cluster.Alias)
			os.Exit(1)
		}
		aliases[strings.ToLower(cluster.Alias)] = struct{}{}
		clusters = append(clusters, server.Cluster{ID: cluster.ID, Alias: cluster.Alias, URL: cluster.URL, Database: cluster.Database, Source: "platform", Client: ch.New(cluster.URL, cluster.User, cluster.Password, cluster.Database, cfg.MaxRows, cfg.QueryTimeout)})
	}
	srv := &http.Server{Addr: cfg.Listen, Handler: server.New(db, platformClusters, clusters, cfg.MaxRows, cfg.QueryTimeout, log, cfg.BasePath), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: cfg.QueryTimeout + 10*time.Second, IdleTimeout: 90 * time.Second}
	log.Info("clickhouse console listening", "address", cfg.Listen, "base_path", cfg.BasePath, "clusters", len(clusters))
	if err = srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
