.PHONY: build test check run web-install web-build

web-install:
	cd web && npm install

web-build:
	cd web && npm run build

build: web-build
	go build -trimpath -o clickhouse-console ./cmd/console

test:
	go test ./...

check:
	gofmt -w cmd internal
	go vet ./...
	go test -race ./...

run: build
	./clickhouse-console
