FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/clickhouse-console ./cmd/console \
    && mkdir -p /out/data \
    && chown 65532:65532 /out/data \
    && chmod 0700 /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/clickhouse-console /clickhouse-console
COPY --from=build --chown=65532:65532 /out/data /data
VOLUME ["/data"]
EXPOSE 8080
ENV CH_CONSOLE_LISTEN=:8080 CH_CONSOLE_DATA_DIR=/data
ENTRYPOINT ["/clickhouse-console"]
