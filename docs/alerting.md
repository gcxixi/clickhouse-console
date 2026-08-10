# 报警模块设计与使用

## 模块边界

报警代码位于 `internal/alerting`，不依赖 HTTP Session、SQL 工作台状态或控制台用户 Store：

- `Repository`：规则、Webhook、触发记录和发送记录的持久化接口。
- `Executor`：执行只读 SQL 并返回一个布尔判断及展示值。
- `Sender`：发送标准 Webhook。
- `Service`：独立调度和 `inactive → pending → firing → resolved` 状态机。

Server 层只提供 ClickHouse 客户端解析器、管理员 API 和审计适配。切换用户当前集群不会改变规则的目标集群；每条规则保存自己的集群别名。

## 判断与时间窗口

SQL 必须是只读查询。第一行第一列按以下规则解释：

- Boolean：直接使用。
- Number：非零为真。
- String：`true`、`yes`、`firing`、`1` 为真；`false`、`no`、`inactive`、`0` 和空字符串为假；数值字符串按 Number 处理。
- 无返回行或 `NULL`：假。

推荐把两个时间概念明确分开：

1. **观察窗口由 SQL 定义。** 例如 `event_time >= now() - INTERVAL 5 MINUTE` 表示每次都观察最近五分钟。
2. **连续成立窗口由 For 定义。** For 为 10 分钟表示每次调度结果必须连续为真满十分钟才进入 firing。任何 pending 阶段的查询错误会重置连续计时；已经 firing 时的临时查询错误不会错误发送 resolved，下一次成功且为假才恢复。

示例：每分钟检查最近五分钟是否有查询异常，并要求连续十分钟成立：

```sql
SELECT count() > 0
FROM system.query_log
WHERE type = 'ExceptionWhileProcessing'
  AND event_time >= now() - INTERVAL 5 MINUTE
```

配置：执行周期 `60` 秒，For `600` 秒。pending/firing、开始时间和最近执行时间都保存在报警数据库。短暂重启后可继续 For 进度；若 pending 的两次成功调度间隔超过两个执行周期，连续性视为中断并重新计时。已经 firing 的规则在调度中断时保持 firing，直到一次成功查询明确返回假，避免因基础设施故障误报 resolved。

内部时间统一保存为 UTC。SQL 窗口建议使用 ClickHouse 的 `now()`，让数据时间判断与数据节点时钟一致；应用节点与 ClickHouse 节点都应启用 NTP。对于可能延迟到达的数据，SQL 应显式加入 watermark/延迟容忍，例如检查 `[now()-10m, now()-2m)`，而不是让调度器猜测事件时间。

当前只在状态转换时发送一次 firing 和一次 resolved，不做固定周期重复通知，避免无意制造 Webhook 风暴。需要重复提醒时，建议由接收端聚合、静默和升级；后续也可以在规则模型中加入 repeat interval。

## 数据库存储

数据库首次连接时自动创建 `alert_rules`、`alert_webhooks`、`alert_events` 和 `alert_deliveries`。规则编号使用数据库自增 ID，表现形式为 `#123`。触发记录和发送记录默认各保留最近 300 条。

连接示例：

```text
SQLite:    file:/data/alerts.db?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)
Postgres:  postgres://user:password@db:5432/alerts?sslmode=require
MySQL:     user:password@tcp(db:3306)/alerts?tls=true&timeout=5s
```

环境变量配置为只读并优先于平台配置。若留空 `CH_CONSOLE_ALERTING_DRIVER` 和 `CH_CONSOLE_ALERTING_DSN`，管理员可在“报警中心 → 存储配置”中启用。生产环境的 PostgreSQL/MySQL 必须开启 TLS；前端应用层加密不能替代 HTTPS。

## Webhook 结构

结构接近 Alertmanager Webhook，固定 `Content-Type: application/json`：

```json
{
  "version": "1",
  "groupKey": "rule:42",
  "status": "firing",
  "receiver": "on-call",
  "groupLabels": {"alertname":"QueryErrors","rule_id":"42","cluster":"production"},
  "commonLabels": {"alertname":"QueryErrors","rule_id":"42","cluster":"production"},
  "alerts": [{
    "status": "firing",
    "labels": {"alertname":"QueryErrors","rule_id":"42","cluster":"production"},
    "annotations": {"summary":"QueryErrors","sql":"SELECT ...","value":"1"},
    "startsAt": "2026-08-10T02:00:00Z",
    "generatorURL": ""
  }]
}
```

resolved 消息带 `endsAt`。Webhook 完整 URL（包括查询参数）和可选 Authorization 请求头会加密传输、加密存储；列表 API 只显示 `scheme://host`。HTTP 3xx 不自动跟随，避免把 Authorization 转发到另一个地址。发送记录只保存成功/失败、HTTP 状态和脱敏错误分类，不保存响应正文或可能包含完整 URL 的底层网络错误。

## 查询结果大数据量展示方案

当前后端默认把交互查询限制为 1,000 行和 32 MiB 响应；前端会一次性创建全部表格 DOM。1,000 行、少量字段通常可接受，但宽表、长 JSON 和把上限调到数万时会造成明显的主线程阻塞和内存放大。

建议选择以下方案 A：

- 交互查询仍保留明确的最大行数。
- 浏览器收到完整响应后先渲染 200 行，滚动到底或点击“加载更多”再追加 200 行；字段勾选不重新请求。
- 大结果集提供独立的流式 CSV/JSONL 下载接口，不进入 DOM，也不在服务端完整缓冲。
- 显示“已渲染 200 / 已返回 1,000 / 服务端可能已截断”，避免把“返回行数”和“展示行数”混淆。

它比虚拟列表更适合当前原生 table：实现复杂度低，兼容 sticky header、横向滚动、动态列和溢出 Tooltip，也不会改变任意 SQL 的语义。若确实需要在页面内交互浏览 10 万行，再选择方案 B（固定行高的虚拟化 grid）；方案 C（自动改写 SQL 做服务端分页）只适用于控制台生成的简单 SELECT，不应改写用户任意 SQL。
