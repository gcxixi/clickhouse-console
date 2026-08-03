# ClickHouse Console

一个用 Go 实现的轻量 ClickHouse Web 管理控制台。后端、静态前端打包为单个二进制，适合内网部署。

## 功能

- SQL 工作台：查询结果表格、执行耗时、错误反馈、快捷键执行
- DDL / DML：按角色控制执行权限
- 对象浏览器：查看数据库、表、引擎和行数
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

Compose 默认只监听宿主机 `127.0.0.1:8080`。对外提供服务时，请在前面配置带 TLS 的反向代理，不要直接暴露到公网。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CH_CONSOLE_LISTEN` | `:8080` | HTTP 监听地址 |
| `CH_CONSOLE_DATA_DIR` | `./data` | 用户和审计数据目录 |
| `CLICKHOUSE_URL` | `http://127.0.0.1:8123` | ClickHouse HTTP 地址 |
| `CLICKHOUSE_USER` | `default` | ClickHouse 用户 |
| `CLICKHOUSE_PASSWORD` | 空 | ClickHouse 密码，仅从环境读取 |
| `CLICKHOUSE_DATABASE` | `default` | 默认数据库 |
| `CH_CONSOLE_QUERY_TIMEOUT` | `60s` | 单次查询超时 |
| `CH_CONSOLE_MAX_ROWS` | `1000` | 最大返回行数，范围 1–100000 |
| `CH_CONSOLE_ADMIN_USER` | `admin` | 首次启动管理员用户名 |
| `CH_CONSOLE_ADMIN_PASSWORD` | 随机生成 | 首次启动管理员密码 |

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
