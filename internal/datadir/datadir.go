package datadir

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Prepare sets secure ownership and permissions on a dedicated application
// data directory. It must be run with permission to change file ownership.
func Prepare(dir string, uid, gid int) error {
	cleanDir := filepath.Clean(dir)
	if dir == "" || !filepath.IsAbs(cleanDir) || cleanDir == string(filepath.Separator) {
		return fmt.Errorf("refusing unsafe data directory %q", dir)
	}
	if err := os.MkdirAll(cleanDir, 0700); err != nil {
		return fmt.Errorf("create %q: %w", cleanDir, err)
	}
	return filepath.WalkDir(cleanDir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing symbolic link in data directory: %q", path)
		}
		if err := os.Chown(path, uid, gid); err != nil {
			return fmt.Errorf("change owner of %q: %w", path, err)
		}
		mode := fs.FileMode(0600)
		if entry.IsDir() {
			mode = 0700
		}
		if err := os.Chmod(path, mode); err != nil {
			return fmt.Errorf("change mode of %q: %w", path, err)
		}
		return nil
	})
}
