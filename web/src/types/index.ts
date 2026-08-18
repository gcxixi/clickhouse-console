export interface User {
  ID: string;
  Username: string;
  Role: 'viewer' | 'editor' | 'admin';
  Disabled: boolean;
  CreatedAt: string;
}

export interface Cluster {
  id: string;
  alias: string;
  url: string;
  database?: string;
  source: 'config' | 'platform';
  credentials_present?: boolean;
}

export interface QueryMetaColumn {
  name: string;
  type: string;
}

export interface QueryResult {
  kind: 'query' | 'batch' | 'statement' | 'mutation' | 'ddl';
  meta?: QueryMetaColumn[];
  data?: Record<string, any>[];
  rows?: number;
  elapsed_ms?: number;
  statement_count?: number;
  statements?: {
    statement: string;
    kind: string;
    validation: string;
  }[];
}

export interface Process {
  query_id: string;
  user: string;
  address: string;
  elapsed: number;
  read_rows: number;
  read_bytes: number;
  total_rows_approx: number;
  memory_usage: number;
  query: string;
}

export interface MonitorPart {
  database: string;
  table: string;
  disk_name: string;
  bytes: number;
  parts: number;
  rows: number;
}

export interface MonitorMetric {
  metric: string;
  value: number;
}

export interface MonitorDisk {
  name: string;
  path: string;
  free_space_in_bytes: number;
  total_space_in_bytes: number;
}

export interface MonitorSnapshot {
  generated_at: string;
  metrics: MonitorMetric[];
  asynchronous_metrics: MonitorMetric[];
  events: { event: string; value: number }[];
  parts: MonitorPart[];
  disks: MonitorDisk[];
}

export interface AlertConfig {
  enabled: boolean;
  configured: boolean;
  driver: 'sqlite' | 'postgres' | 'mysql';
  history_limit: number;
}

export interface AlertRule {
  id: number;
  name: string;
  cluster: string;
  sql: string;
  interval_seconds: number;
  for_seconds: number;
  repeat_interval_seconds: number;
  webhook_id?: number | null;
  enabled: boolean;
  state: 'ok' | 'pending' | 'firing';
  last_value?: string;
  last_error?: string;
  last_evaluated_at?: string;
}

export interface AlertWebhook {
  id: number;
  name: string;
  channel_type: 'generic' | 'wecom' | 'feishu' | 'dingtalk' | 'slack';
  url_hint: string;
  auth_configured: boolean;
  updated_at: string;
}

export interface AlertEvent {
  id: number;
  rule_id: number;
  rule_name: string;
  cluster: string;
  status: 'firing' | 'resolved';
  value: string;
  started_at: string;
  ended_at?: string;
  created_at: string;
}

export interface AlertDelivery {
  id: number;
  rule_id: number;
  rule_name: string;
  webhook_id: number;
  webhook_name: string;
  status: 'sent' | 'failed';
  http_status: number;
  response_body: string;
  error: string;
  created_at: string;
}

export interface AuditEntry {
  At: string;
  User: string;
  Cluster: string;
  Action: string;
  Statement: string;
  Status: string;
  DurationMS: number;
  Error?: string;
}

export interface QueryHistoryItem {
  sql: string;
  cluster: string;
  elapsed_ms: number;
  rows: number;
  at: number;
}

export interface CustomSnippet {
  id?: string;
  title: string;
  desc?: string;
  sql: string;
}
