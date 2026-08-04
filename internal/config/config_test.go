package config

import "testing"

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
