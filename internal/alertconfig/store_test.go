package alertconfig

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gcxixi/clickhouse-console/internal/clusterconfig"
)

func TestStoreEncryptsDatabaseConnection(t *testing.T) {
	dir := t.TempDir()
	if _, err := clusterconfig.Open(dir, ""); err != nil {
		t.Fatal(err)
	}
	store, err := Open(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	secret := "postgres://alert-user:test-password@db.example:5432/alerts?sslmode=require"
	config, err := store.Save(true, "postgres", secret, 450, true)
	if err != nil {
		t.Fatal(err)
	}
	if !config.Enabled || config.DSN != secret || config.HistoryLimit != 450 {
		t.Fatalf("config = %#v", config)
	}
	data, err := os.ReadFile(filepath.Join(dir, "platform-alerting.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "test-password") || strings.Contains(string(data), "alert-user") {
		t.Fatal("connection credentials were stored in plaintext")
	}
	public := store.Public()
	if !public.Configured || !public.CredentialsConfigured || public.Driver != "postgres" {
		t.Fatalf("public = %#v", public)
	}
}
