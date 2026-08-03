.PHONY: build test check run
build:
	go build -trimpath -o clickhouse-console ./cmd/console
test:
	go test ./...
check:
	gofmt -w cmd internal
	go vet ./...
	go test -race ./...
run:
	go run ./cmd/console
