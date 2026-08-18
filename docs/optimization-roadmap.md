# ClickHouse Console 优化与演进路线图

本文档基于对当前代码库架构、安全性、数据流、前后端性能及运维实践的深入分析，梳理出 ClickHouse Console 后续的优化方向与演进路线。

---

## 目录

1. [现状评估与架构优势](#1-现状评估与架构优势)
2. [核心优化方向分析](#2-核心优化方向分析)
   - [一、 后端核心与运行时架构](#一-后端核心与运行时架构)
   - [二、 SQL 工作台与数据交互体验](#二-sql-工作台与数据交互体验)
   - [三、 运行监控与集群运维能力](#三-运行监控与集群运维能力)
   - [四、 报警中心能力增强](#四-报警中心能力增强)
   - [五、 安全加固与企业级权限](#五-安全加固与企业级权限)
   - [六、 前端交互与视觉系统](#六-前端交互与视觉系统)
   - [七、 工程化、交付与可观测性](#七-工程化交付与可观测性)
3. [优先级矩阵与分阶段路线图](#3-优先级矩阵与分阶段路线图)

---

## 1. 现状评估与架构优势

当前项目在轻量级 ClickHouse 管理控制台领域具备优秀的架构底座与工程实现：

- **单二进制自包含交付**：前后端资源通过 Go `embed` 打包为单一静态二进制，支持 Distroless 容器镜像，开箱即用。
- **高安全基线**：
  - 密码采用 `bcrypt` 哈希；
  - 凭据在浏览器端采用 RSA-OAEP + AES-GCM 端到端加密封装，服务端持久化采用 AES-256-GCM 主密钥加密，API 彻底脱敏；
  - 严格的 CSP、SameSite/HttpOnly Cookie、CSRF Token 校验与只读/DDL/DML 分级权限控制；
  - Dry Run 采用 ClickHouse 24+ 原生 `EXPLAIN QUERY TREE` 做只读语句语义分析，避免传统正则误判。
- **多集群与多存储报警调度**：内置基于状态机的报警调度引擎，支持 PromQL 风格 `for` 窗口判定，兼容 SQLite / PostgreSQL / MySQL 三种存储后端。

在此稳固基础上，针对生产环境规模化使用、大数据量交互、多租户运维以及易用性，可进一步深入优化。

---

## 2. 核心优化方向分析

### 一、 后端核心与运行时架构

#### 1.1 优雅停机与服务生命周期管理 (Graceful Shutdown)
- **现状**：`cmd/console/main.go` 中直接调用 `srv.ListenAndServe()`，在容器停止或收到系统信号（`SIGTERM` / `SIGINT`）时会立即被操作系统终止。
- **优化点**：
  - 引入 `signal.NotifyContext` 监听系统终止信号；
  - 触发退出时，优先调用 `srv.Shutdown(ctx)` 停止接收新 HTTP 请求并等待进行中的查询完成（设置如 15s 优雅停机超时）；
  - 级联调用 `alerts.Close()` 确保报警调度器平稳退出正在执行的评估任务并保存当前状态，避免事务截断。

#### 1.2 HTTP Client 连接池与传输层调优 (Connection Pooling)
- **现状**：`clickhouse.New` 创建了 `&http.Client{Timeout: ...}`，未定制 `http.Transport`，默认继承 `http.DefaultTransport`（其 `MaxIdleConnsPerHost` 仅为 2）。
- **优化点**：
  - 为 ClickHouse HTTP 客户端定制独立 `Transport`：
    ```go
    transport := &http.Transport{
        MaxIdleConns:        100,
        MaxIdleConnsPerHost: 20,
        IdleConnTimeout:     90 * time.Second,
        DisableCompression:  false, // 启用 gzip 减少大结果集传输开销
    }
    ```
  - 支持 ClickHouse HTTP 响应压缩（设置 `Accept-Encoding: gzip` 并配置 ClickHouse `enable_http_compression=1`），大幅减少宽表与复杂分析查询的网络吞吐负载。

#### 1.3 会话生命周期与过期垃圾回收 (Session Expiration GC)
- **现状**：`Server.sessions` 维护在内存 `map[string]session` 中，并在用户主动注销或登录时操作，但缺乏后台周期性清理逻辑，长时间运行可能存在过期会话残留。
- **优化点**：
  - 增加轻量后台清理协程（如每 10 分钟或 1 小时触发一次），自动剔除已过期的 Session 项；
  - 抽象 `SessionStore` 接口，支持可选的文件持久化或外部存储，避免控制台升级重启时导致所有已登录用户掉线。

#### 1.4 审计日志与元数据存储 I/O 优化 (Audit I/O Amplification)
- **现状**：`store.Store` 将全部用户与最近 5,000 条审计记录保存在单个 `console.json` 中。每次记录审计均会全量序列化并原子覆写整个文件，在并发高频查询下存在 I/O 放大。
- **优化点**：
  - **方案 A（轻量方案）**：将 `console.json` 拆分为 `users.json`（只读/低频写）与 `audit.log`（按行写入 JSONL，配合循环轮转），避免全量重写；
  - **方案 B（演进方案）**：将审计与配置统一支持存入 SQLite 数据库（自带 WAL 模式与索引支持，支持高效的条件筛选与分页查询）。

#### 1.5 ClickHouse 查询取消与 Query ID 联动 (Query Cancellation)
- **现状**：当客户端浏览器断开连接或超时中断时，ClickHouse 端若未开启自动取消，仍可能在后台继续跑完消耗资源的查询。
- **优化点**：
  - 为每次发起的查询生成唯一 `query_id`（如 `ch_console_{session_id}_{timestamp}`）；
  - 发送请求时携带 ClickHouse URL 参数 `query_id=<id>&cancel_http_readonly_queries_on_client_close=1`；
  - 提供主动取消查询接口：前端可向 `/api/query/cancel` 发送 `query_id`，服务端向 ClickHouse 发送 `KILL QUERY WHERE query_id = '...'`。

---

### 二、 SQL 工作台与数据交互体验

#### 2.1 查询结果大数据量渐进式/虚拟滚动渲染 (Virtual Table)
- **现状**：前端收到查询结果后一次性将所有行生成为 DOM `<table>`。当单次查询返回上万行或上百列宽表时，浏览器主线程会出现卡顿与内存占用高问题。
- **优化点**：
  - **分批加载**：首屏优先渲染前 100~200 行，随滚动到底部平滑追加分片 DOM；
  - **虚拟化渲染（Virtual Grid）**：仅渲染可视视口内的行与列，使 50,000+ 行数据的滚动依然保持 60fps 丝滑体验；
  - 增加“渲染行数 / 返回行数 / 服务端上限”的精确分段指示。

#### 2.2 服务端流式导出大文件 (Streaming Export)
- **现状**：目前导出由前端在浏览器内存中对已返回的 JSON 数据进行格式化转换（CSV / TSV / JSONL）。如果数据量超过前端接收上限，无法导出全量。
- **优化点**：
  - 新增 `/api/query/export` 端点，支持直通 ClickHouse 流式响应（格式如 `FORMAT CSVWithNames` / `FORMAT Parquet` / `FORMAT TabSeparatedWithNames`）；
  - 采用 HTTP Chunked 流式传输，不经过服务端内存缓冲，直接以文件附件形式流式下载，支持百万级数据高速导出。

#### 2.3 查询历史、收藏夹与多标签页 (Query History & Multi-Tabs)
- **现状**：SQL 工作台只有一个编辑器输入框，刷新或切换内容容易覆盖草稿。
- **优化点**：
  - **查询历史记录（Query History）**：本地 `localStorage` 自动记录最近执行成功的 50 条 SQL，支持搜索、耗时回放与一键载入；
  - **SQL 收藏夹 / 片段库（Snippets）**：允许用户将常用排查 SQL（如查锁、查耗时 TOP10、查部件分布）命名保存；
  - **多编辑器标签页（Tabs）**：支持打开多个 SQL 编辑 Tab，便于同时对比多段查询。

#### 2.4 SQL 智能补全与语法增强 (IntelliSense & Formatter)
- **现状**：当前编辑器为原生 `textarea` + 自定义语法高亮层，格式化依赖简单正则替换。
- **优化点**：
  - 集成轻量现代化代码编辑器（如 CodeMirror 6 或 Monaco Editor），内置 ClickHouse SQL 关键字、内置函数（如 `toYYYYMM`、`arrayJoin`、`quantile`）及库表列名的智能感知补全；
  - 增强 SQL 格式化能力，支持子查询、JOIN、CTE (`WITH`) 的优雅对齐与美化。

#### 2.5 运行中查询监控与一键终止 (Processlist & Query Killer)
- **现状**：无法在工作台直观看到当前集群上有哪些查询正在运行。
- **优化点**：
  - 增加“正在运行的查询”抽屉面板（读取 `system.processes`），展示 `query_id`、`user`、`elapsed`、`read_rows`、`memory_usage`；
  - Admin/Editor 角色支持直接在界面上一键终止卡死或耗尽内存的慢查询（`KILL QUERY`）。

#### 2.6 执行计划 (EXPLAIN) 可视化呈现
- **现状**：Dry Run 当前返回的是文本分析或语法校验。
- **优化点**：
  - 针对 `EXPLAIN PLAN`、`EXPLAIN PIPELINE`、`EXPLAIN ESTIMATE` 提供可视化树状图/折叠面板，帮助开发人员分析索引命中、Parts 扫描量与执行阶段。

---

### 三、 运行监控与集群运维能力

#### 3.1 历史趋势图表与时序可视化 (Historical Metric Charts)
- **现状**：监控页当前展示的是单个时间点的快照表格。
- **优化点**：
  - 结合 `system.metric_log` / `system.asynchronous_metric_log`，引入轻量 Canvas/SVG 图表展示过去 1 小时 / 6 小时 / 24 小时的关键时序趋势：
    - **QPS & 查询延迟趋势**（P50 / P95 / P99）；
    - **CPU / 内存利用率曲线**；
    - **磁盘 I/O 读写吞吐**；
    - **后台合并（Merge）活跃数与数据写入速率**。

#### 3.2 节点拓扑与副本同步监控 (Replication & Cluster Health)
- **现状**：多集群按实例分别查看，缺少集群级拓扑概览。
- **优化点**：
  - 读取 `system.clusters` 展示集群 Shard / Replica 分布拓扑；
  - 读取 `system.replicas` 监控副本延迟、只读表（`is_readonly`）、ZooKeeper/Keeper 连接状态与队列堆积（`queue_size`、`inserts_in_queue`）；
  - 发现异常副本时在控制台仪表盘给出醒目标识。

#### 3.3 数据变异与后台任务追踪 (Mutations & Merges Tracker)
- **现状**：无法监控大批量 `ALTER ... UPDATE/DELETE` 的执行进度。
- **优化点**：
  - 增加后台任务视图，轮询 `system.mutations`，清晰展示正在进行的 Mutation 任务 ID、影响表、未完成 Parts 数量与执行进度；
  - 监控 `system.merges`，查看正在执行的大表后台合并与优化任务。

#### 3.4 错误日志探查器 (Error Log Inspector)
- **优化点**：
  - 增加“系统错误日志”查看视图，直接读取 `system.errors`（累计错误计数）及 `system.text_log`（最近 ERROR 级别系统日志），免去 SSH 登机翻看 `clickhouse-server.err.log` 的繁琐过程。

---

### 四、 报警中心能力增强

#### 4.1 多通知渠道模板与原生适配 (Notification Channels)
- **现状**：目前仅支持通用 HTTP Webhook，各即时通讯平台需要用户自行架设转换服务。
- **优化点**：
  - 增加主流办公即时通讯工具的原生 Webhook 格式转换器：
    - **企业微信 (WeCom)**：支持 Markdown / Text 格式卡片；
    - **飞书 (Feishu / Lark)**：支持富文本 / 交互式消息卡片；
    - **钉钉 (DingTalk)**：支持 ActionCard / Markdown；
    - **Slack / Telegram / Bark / 邮件 (SMTP)**。

#### 4.2 Webhook 快速连通性测试 (Test Notification)
- **现状**：创建或修改 Webhook 后，需要等待真实报警触发才能验证配置正确性。
- **优化点**：
  - 在 Webhook 管理列表中增加“发送测试消息”按钮，服务端即时发送一条标准模拟事件并返回 HTTP 状态码与响应体，便于排查网络与鉴权问题。

#### 4.3 告警静默期、维护窗口与重复通知 (Silences & Repeat Interval)
- **现状**：目前规则仅在状态切换（`firing` / `resolved`）时各发送一次通知。
- **优化点**：
  - 支持配置 **重复提醒间隔 (Repeat Interval)**（如持续处于 firing 状态超过 2 小时重新提醒一次）；
  - 支持 **告警静默期 (Silence Windows)**：在数据库维护或升级期间，临时静默特定规则或特定集群的告警发送。

#### 4.4 报警内容富模板插值 (Template Interpolation)
- **优化点**：
  - 允许在告警摘要与描述中使用占位符提取查询结果中的多字段，例如 `{{ $labels.cluster }} 慢查询数量达 {{ $value }} 条，最长耗时 {{ $row.max_duration }}s`。

---

### 五、 安全加固与企业级权限

#### 5.1 细粒度库表级权限控制 (Granular RBAC)
- **现状**：角色仅分为 `viewer`、`editor`、`admin` 三档全局权限。
- **优化点**：
  - 支持按用户配置 **允许访问的集群别名白名单**；
  - 支持按用户或用户组配置 **数据库级权限**（例如用户 A 仅能访问 `staging_*` 数据库，禁止查询 `finance_*` 数据库）。

#### 5.2 企业 SSO / OAuth2 / OIDC / LDAP 接入
- **现状**：仅支持本地控制台用户认证。
- **优化点**：
  - 支持标准 OpenID Connect (OIDC) / OAuth2（如 Keycloak、Authing、GitHub、GitLab、Google Workspace）；
  - 支持 LDAP / Active Directory 用户目录对接，实现企业统一员工账号登录与角色自动映射。

#### 5.3 敏感接口限流与防爆破 (Rate Limiting)
- **现状**：登录接口尚未设置基于 IP 的速率限制。
- **优化点**：
  - 在 `/api/login` 引入内存令牌桶或计数器限流（如单 IP 连续失败 5 次后锁定 15 分钟），防止暴力破解密码；
  - 对 `/api/query` 增加每会话并发查询数限制，防止单个前端页面循环发请求压垮后端。

#### 5.4 双因素认证 (2FA / TOTP)
- **优化点**：
  - 为管理员账号提供基于 TOTP（Google Authenticator / 1Password / 微软身份验证器）的双因素认证开关。

---

### 六、 前端交互与视觉系统

#### 6.1 明暗主题自由切换 (Theme System)
- **现状**：目前采用固定深色专业风格。
- **优化点**：
  - 抽象 CSS 自定义属性（CSS Variables），提供 **深色模式 (Dark)**、**浅色模式 (Light)** 以及 **跟随系统 (System Default)** 切换开关，满足不同光照环境下的使用需求。

#### 6.2 移动端与平板响应式适配优化 (Mobile Responsiveness)
- **现状**：侧边栏与宽表格主要针对桌面大屏优化。
- **优化点**：
  - 针对小屏幕增加侧边栏抽屉式收起/展开手势；
  - SQL 编辑器在移动端增加快捷工具条（快速输入常用符号与关键字）；
  - 数据表格在小屏幕下支持卡片式折叠视图。

#### 6.3 全局快捷键与命令面板 (Command Palette `Cmd+K`)
- **优化点**：
  - 增加全局快捷键面板（`Cmd+K` 或 `Ctrl+K`），支持快速切换集群、跳转数据库表、切换工作台视图或触发常用操作。

#### 6.4 数据表格交互增强 (Table Ergonomics)
- **优化点**：
  - 支持列宽自由拖拽调整；
  - 支持点击表头按列升序/降序即时排序；
  - 单元格右键菜单：支持“以此值过滤 (WHERE col = '...')”、“复制单元格内容”、“复制整行 JSON”。

---

### 七、 工程化、交付与可观测性

#### 7.1 分离 Liveness / Readiness 探针
- **现状**：`/api/health` 依赖当前会话与 ClickHouse Ping。
- **优化点**：
  - 提供无鉴权的轻量 `/livez`（用于 Kubernetes 探活，只要 Go 进程存活即返回 200）；
  - 提供 `/readyz`（检查本地数据目录可写性及必要初始化是否完成）。

#### 7.2 控制台自身 Prometheus `/metrics` 暴露
- **优化点**：
  - 控制台自身暴露 `/metrics` 端点，输出：
    - `ch_console_http_requests_total`
    - `ch_console_query_duration_seconds`
    - `ch_console_active_sessions`
    - `ch_console_alert_evaluations_total`
    - `ch_console_alert_evaluation_errors_total`

#### 7.3 Kubernetes 部署与 Helm Chart
- **优化点**：
  - 在仓库中补充 `deploy/helm` 或标准 Kubernetes Deployment/ConfigMap/Secret 清单，简化企业上云部署流程。

---

## 3. 优先级矩阵与分阶段路线图

| 阶段 | 核心任务 | 预估效益 | 难度评估 |
|---|---|---|---|
| **Phase 1: 稳定性与核心体验 (P0)** | 1. 服务优雅停机 (`SIGTERM` 处理)<br>2. HTTP Client 连接池优化 (`MaxIdleConnsPerHost`)<br>3. 内存 Session 过期清理定时任务<br>4. Webhook 连通性测试按钮<br>5. 查询结果分批渲染 / 防止大结果集 DOM 阻塞 | 消除生产中断风险，大幅提升大查询稳定性与响应速度 | 低 ~ 中 |
| **Phase 2: 工作台与运维深化 (P1)** | 1. 运行中查询列表 (`system.processes`) 与一键终止<br>2. 服务端流式大文件下载接口<br>3. SQL 查询历史与收藏夹<br>4. 企业微信/飞书/钉钉/Slack 告警渠道预设<br>5. 告警静默期与重复通知机制<br>6. 明暗主题切换与表格列宽拖拽 | 显著提升日常排查与集群监控运维效率 | 中 |
| **Phase 3: 企业级治理与可观测 (P2)** | 1. 细粒度库表权限 (RBAC)<br>2. 企业 SSO (OIDC / OAuth2 / LDAP) 对接<br>3. 登录防爆破限流与 2FA<br>4. 历史监控趋势图表 (时序折线图)<br>5. 控制台自身 Prometheus `/metrics` 暴露<br>6. Kubernetes Helm Chart 交付包 | 满足中大型团队多租户合规与生产级高可用管理需求 | 中 ~ 高 |
