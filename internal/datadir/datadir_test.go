package datadir

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestPrepare(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permissions are required")
	}
	dir := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(dir, 0777); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "console.json")
	if err := os.WriteFile(file, []byte("{}"), 0666); err != nil {
		t.Fatal(err)
	}
	if err := Prepare(dir, os.Getuid(), os.Getgid()); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]os.FileMode{dir: 0700, file: 0600} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Fatalf("%s mode = %o; want %o", path, got, want)
		}
	}
}

func TestPrepareRejectsUnsafePaths(t *testing.T) {
	for _, path := range []string{"", "/", "/tmp/..", ".", "relative/data"} {
		if err := Prepare(path, os.Getuid(), os.Getgid()); err == nil {
			t.Fatalf("Prepare(%q) should fail", path)
		}
	}
}
