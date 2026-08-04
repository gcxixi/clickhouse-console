package clusterconfig

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStoreEncryptsCredentialsAndPersists(t *testing.T) {
	dir := t.TempDir()
	key := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef"))
	store, err := Open(dir, key)
	if err != nil {
		t.Fatal(err)
	}
	created, err := store.Create(Input{Alias: "analytics", URL: "https://clickhouse.example:8443", Database: "warehouse", User: "encrypted-user", Password: "encrypted-password"})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "platform-clusters.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "encrypted-user") || strings.Contains(string(raw), "encrypted-password") {
		t.Fatalf("credential plaintext leaked to disk: %s", raw)
	}
	reopened, err := Open(dir, key)
	if err != nil {
		t.Fatal(err)
	}
	configs, err := reopened.Configs()
	if err != nil || len(configs) != 1 || configs[0].User != "encrypted-user" || configs[0].Password != "encrypted-password" {
		t.Fatalf("reopened configs = %#v, %v", configs, err)
	}
	_, updated, err := reopened.Update(created.ID, Input{Alias: "analytics", URL: "https://new.example:8443", Database: "default"}, false)
	if err != nil || updated.User != "encrypted-user" || updated.Password != "encrypted-password" {
		t.Fatalf("credentials were not preserved: %#v, %v", updated, err)
	}
	if err = reopened.Delete(created.ID); err != nil || len(reopened.List()) != 0 {
		t.Fatalf("delete failed: %v", err)
	}
}

func TestGeneratedKeyPermissionsAndWrongKey(t *testing.T) {
	dir := t.TempDir()
	store, err := Open(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.Create(Input{Alias: "primary", URL: "http://clickhouse:8123", User: "default", Password: "password"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, "cluster-encryption.key"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("key permissions = %v", info.Mode().Perm())
	}
	wrongKey := base64.StdEncoding.EncodeToString([]byte("abcdef0123456789abcdef0123456789"))
	if _, err = Open(dir, wrongKey); err == nil {
		t.Fatal("opening encrypted credentials with the wrong key should fail")
	}
}
