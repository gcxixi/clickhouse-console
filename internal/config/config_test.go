package config

import (
	"strings"
	"testing"
)

func TestNormalizeBasePath(t *testing.T) {
	cases := map[string]string{"": "", "/": "", "/clickhouse": "/clickhouse", "/clickhouse/": "/clickhouse", " /tools/ch ": "/tools/ch"}
	for input, want := range cases {
		got, err := normalizeBasePath(input)
		if err != nil || got != want {
			t.Fatalf("normalizeBasePath(%q) = %q, %v; want %q", input, got, err, want)
		}
	}
	for _, input := range []string{"clickhouse", "//clickhouse", "/a/../..", "/clickhouse?x=1", "/clickhouse#x", "/a%2f..", `/a\b`} {
		if _, err := normalizeBasePath(input); err == nil {
			t.Fatalf("normalizeBasePath(%q) should fail", input)
		}
	}
}

func TestLoadClustersJSONAndLegacyFallback(t *testing.T) {
	t.Run("json", func(t *testing.T) {
		t.Setenv("CH_CONSOLE_CLUSTERS", `[{"alias":"prod","url":"https://prod.example:8443","user":"reader","password":"test-placeholder","database":"analytics"},{"alias":"staging","url":"http://staging.example:8123"}]`)
		clusters, err := loadClusters()
		if err != nil {
			t.Fatal(err)
		}
		if len(clusters) != 2 || clusters[0].Alias != "prod" || clusters[1].User != "default" || clusters[1].Database != "default" {
			t.Fatalf("unexpected clusters: %#v", clusters)
		}
	})
	t.Run("legacy", func(t *testing.T) {
		t.Setenv("CH_CONSOLE_CLUSTERS", "")
		t.Setenv("CLICKHOUSE_ALIAS", "legacy")
		t.Setenv("CLICKHOUSE_URL", "http://clickhouse:8123")
		clusters, err := loadClusters()
		if err != nil || len(clusters) != 1 || clusters[0].Alias != "legacy" {
			t.Fatalf("legacy clusters = %#v, %v", clusters, err)
		}
	})
}

func TestLoadClustersRejectsInvalidConfiguration(t *testing.T) {
	for name, value := range map[string]string{
		"empty":           `[]`,
		"duplicate alias": `[{"alias":"prod","url":"http://one:8123"},{"alias":"prod","url":"http://two:8123"}]`,
		"invalid alias":   `[{"alias":"prod env","url":"http://one:8123"}]`,
		"invalid URL":     `[{"alias":"prod","url":"tcp://one:9000"}]`,
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("CH_CONSOLE_CLUSTERS", value)
			if _, err := loadClusters(); err == nil || strings.TrimSpace(err.Error()) == "" {
				t.Fatalf("loadClusters(%s) should fail", value)
			}
		})
	}
}
