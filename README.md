# ClickHouse Console

一个用 Go 实现的轻量 ClickHouse Web 管理控制台。后端、静态前端打包为单个二进制，适合内网部署。

## 功能

- SQL 工作台：查询结果表格、执行耗时、错误反馈、快捷键执行
- DDL / DML：按角色控制执行权限
- 对象浏览器：查看数据库、表、引擎、行数和磁盘空间占用
- 多集群：为多个 ClickHouse 地址配置唯一别名，在侧边栏二次确认后按会话切换
- 运行监控：查看实时指标、异步指标、累计事件、活动 Parts 和磁盘容量，并提供一小时浏览器缓存与强制刷新
- 控制台用户：创建、启用和停用用户，支持 `viewer`、`editor`、`admin`
- 审计日志：记录登录、查询、DDL/DML 和用户管理操作
- 安全默认值：bcrypt 密码哈希、HttpOnly/SameSite Cookie、CSRF 校验、CSP、安全响应头、单语句限制、结果行数和查询超时限制

角色权限：

| 角色 | 只读查询 | DML | DDL | 用户与审计管理 |
|---|---:|---:|---:|---:|
| viewer | ✓ |  |  |  |
| editor | ✓ | ✓ |  |  |
| admin | ✓ | ✓ | ✓ | ✓ |

## 快速开始

需要 Go 1.24+ 和可访问的 ClickHouse HTTP 端口（通常是 `8123`）。

```bash
cp .env.example .env
# 编辑 .env；不要提交该文件
set -a && source .env && set +a
go run ./cmd/console
```

打开 <http://127.0.0.1:8080>。首次启动未设置 `CH_CONSOLE_ADMIN_PASSWORD` 时，程序会生成随机管理员密码并且只在启动日志中显示一次。生产环境建议在首次启动时通过环境变量传入至少 12 位的随机密码，登录后再从运行环境删除该变量。

## Docker

```bash
docker compose up --build -d
docker compose logs console
```

Compose 会先运行一次短生命周期的 `init-data` 服务，将数据卷设置为应用的非 root 用户可读写，然后启动控制台。这也会自动修复旧版本创建的 root 属主数据卷。默认只监听宿主机 `127.0.0.1:8080`。对外提供服务时，请在前面配置带 TLS 的反向代理，不要直接暴露到公网。

如果未使用 Compose，并遇到 `open /data/console.json.tmp: permission denied`，可使用镜像内置命令修复专用数据卷：

```bash
docker run --rm --user 0:0 \
  -v clickhouse-console_console-data:/data \
  ghcr.io/your-org/clickhouse-console:latest init-data-dir
```

将镜像名和卷名替换为实际值。修复命令只接受绝对路径并拒绝根目录，同时会把 `/data` 内目录设为 `0700`、文件设为 `0600`、属主设为 UID/GID `65532`。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CH_CONSOLE_LISTEN` | `:8080` | HTTP 监听地址 |
| `CH_CONSOLE_DATA_DIR` | `./data` | 用户和审计数据目录 |
| `CH_CONSOLE_BASE_PATH` | 空 | 反向代理路径前缀，例如 `/clickhouse` |
| `CH_CONSOLE_CLUSTERS` | 空 | 多集群 JSON 数组；设置后替代下方单集群 `CLICKHOUSE_*` 配置 |
| `CLICKHOUSE_ALIAS` | `default` | 单集群模式的唯一别名 |
| `CLICKHOUSE_URL` | `http://127.0.0.1:8123` | ClickHouse HTTP 地址 |
| `CLICKHOUSE_USER` | `default` | ClickHouse 用户 |
| `CLICKHOUSE_PASSWORD` | 空 | ClickHouse 密码，仅从环境读取 |
| `CLICKHOUSE_DATABASE` | `default` | 默认数据库 |
| `CH_CONSOLE_QUERY_TIMEOUT` | `60s` | 单次查询超时 |
| `CH_CONSOLE_MAX_ROWS` | `1000` | 最大返回行数，范围 1–100000 |
| `CH_CONSOLE_ADMIN_USER` | `admin` | 首次启动管理员用户名 |
| `CH_CONSOLE_ADMIN_PASSWORD` | 随机生成 | 首次启动管理员密码 |

### 多集群配置

每个 ClickHouse HTTP 地址必须配置一个唯一别名。数组第一项是新登录会话的默认集群；集群切换只影响当前登录会话，且页面会要求二次确认。示例：

```bash
CH_CONSOLE_CLUSTERS='[
  {"alias":"primary","url":"http://clickhouse-1:8123","user":"default","password":"","database":"default"},
  {"alias":"analytics","url":"http://clickhouse-2:8123","user":"default","password":"","database":"default"}
]'
```

别名只能包含字母、数字、点、下划线和连字符，最长 64 个字符。请把真实密码放在部署环境或密钥管理系统中，不要提交 `.env`。未设置 `CH_CONSOLE_CLUSTERS` 时，原有 `CLICKHOUSE_URL`、`CLICKHOUSE_USER`、`CLICKHOUSE_PASSWORD` 和 `CLICKHOUSE_DATABASE` 配置继续有效。

监控页参考 [clickhouse_exporter 的采集方式](https://github.com/ClickHouse/clickhouse_exporter/blob/master/exporter/exporter.go)，读取 `system.metrics`、`system.asynchronous_metrics`、`system.events`、`system.parts` 和 `system.disks`。监控快照按集群别名保存在浏览器 `localStorage`：一小时内优先使用缓存；超过一小时会先展示带时间标识的旧数据，再在后台刷新。页面的刷新按钮始终会强制获取最新数据。

### Nginx 路径前缀

如果控制台部署在 `https://example.com/clickhouse/`，设置：

```bash
CH_CONSOLE_BASE_PATH=/clickhouse
```

并让 Nginx 保留该前缀转发（`proxy_pass` 后不要带 URI 尾部 `/`）：

```nginx
location /clickhouse/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

访问 `/clickhouse` 会自动重定向到 `/clickhouse/`。静态资源、API 和 Session Cookie 都会使用该前缀；如果 Nginx 已经剥离前缀，则保持 `CH_CONSOLE_BASE_PATH` 为空即可。

数据保存在权限为 `0600` 的 `console.json` 中，密码只保存 bcrypt 哈希。最多保留 5,000 条审计记录。生产部署应备份数据目录并限制文件系统访问。

## 开发与验证

```bash
make check
go build -trimpath ./cmd/console
```

项目 CI 会执行 `go vet`、race test、构建和 Gitleaks 扫描。提交前也建议执行：

```bash
gitleaks git --redact --no-banner
```

## 安全边界

- 本程序的用户是“控制台用户”，不等于 ClickHouse 原生用户；服务端使用一组受限 ClickHouse 凭据连接数据库。
- 请为控制台配置最小权限的 ClickHouse 账号。应用层角色是额外防线，不能替代 ClickHouse 自身授权。
- 查询审计会保留 SQL 文本（最多 2,000 字符），不要在 SQL 中直接写密码、token 或其他秘密。
- 当前版本只允许单条 SQL，避免借助多语句绕过权限分类。

## License

MIT
