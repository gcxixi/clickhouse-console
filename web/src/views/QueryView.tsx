import React, { useState, useEffect } from 'react';
import {
  Card,
  Space,
  Select,
  Button,
  Table,
  Tag,
  Drawer,
  Tabs,
  Typography,
  Tooltip,
  Dropdown,
  Checkbox,
  message,
  Input,
  Modal,
  theme as antTheme
} from 'antd';
import {
  PlayCircleOutlined,
  SafetyCertificateOutlined,
  BookOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  PlusOutlined
} from '@ant-design/icons';
import CodeMirror from '@uiw/react-codemirror';
import { sql as sqlLang } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';
import { api, streamExport } from '../api';
import { QueryResult, QueryHistoryItem, CustomSnippet, QueryMetaColumn } from '../types';

const { Text, Paragraph } = Typography;

const builtInSnippets: CustomSnippet[] = [
  {
    title: '慢查询 Top 10（近 1 小时）',
    desc: '从 system.query_log 获取执行时间最长的查询',
    sql: `SELECT\n    query_id,\n    user,\n    query_duration_ms / 1000 AS duration_s,\n    read_rows,\n    formatReadableSize(read_bytes) AS read_size,\n    formatReadableSize(memory_usage) AS memory,\n    query\nFROM system.query_log\nWHERE type = 'QueryFinish' AND event_time >= now() - INTERVAL 1 HOUR\nORDER BY query_duration_ms DESC\nLIMIT 10;`
  },
  {
    title: '表磁盘大小与行数概览',
    desc: '统计每个表的数据行数、分区 Part 数量和磁盘空间占用',
    sql: `SELECT\n    database,\n    table,\n    formatReadableSize(sum(bytes_on_disk)) AS size_on_disk,\n    sum(rows) AS total_rows,\n    count() AS parts_count\nFROM system.parts\nWHERE active\nGROUP BY database, table\nORDER BY sum(bytes_on_disk) DESC\nLIMIT 20;`
  },
  {
    title: '后台合并状态 (Merges)',
    desc: '查看当前正在执行的后台 Part 合并任务进度与速度',
    sql: `SELECT\n    database,\n    table,\n    elapsed,\n    round(progress, 2) AS progress,\n    num_parts,\n    formatReadableSize(total_size_bytes_compressed) AS total_size,\n    formatReadableSize(bytes_read_uncompressed) AS read_bytes,\n    formatReadableSize(bytes_written_uncompressed) AS written_bytes\nFROM system.merges;`
  },
  {
    title: '副本同步队列与延迟 (Replicas)',
    desc: '监控副本表的同步队列大小与只读状态',
    sql: `SELECT\n    database,\n    table,\n    is_leader,\n    is_readonly,\n    queue_size,\n    inserts_in_queue,\n    merges_in_queue,\n    log_pointer,\n    total_replicas,\n    active_replicas\nFROM system.replicas;`
  },
  {
    title: '系统错误日志统计 (System Errors)',
    desc: '近 24 小时内发生的 ClickHouse 错误类型与发生次数',
    sql: `SELECT\n    name,\n    value AS error_count,\n    last_error_time,\n    last_error_message\nFROM system.errors\nWHERE value > 0\nORDER BY last_error_time DESC\nLIMIT 20;`
  }
];

interface QueryViewProps {
  activeCluster: string;
  themeMode: 'light' | 'dark';
  initialSQL?: string;
  onClearOverrideSQL?: () => void;
}

export const QueryView: React.FC<QueryViewProps> = ({
  activeCluster,
  themeMode,
  initialSQL,
  onClearOverrideSQL
}) => {
  const { token } = antTheme.useToken();
  const [sql, setSql] = useState('SELECT version() AS version, now() AS server_time');

  useEffect(() => {
    if (initialSQL) {
      setSql(initialSQL);
      if (onClearOverrideSQL) onClearOverrideSQL();
    }
  }, [initialSQL]);
  const [databases, setDatabases] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [selectedDb, setSelectedDb] = useState<string>('');
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [dryRunning, setDryRunning] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [visibleColumns, setVisibleColumns] = useState<string[]>([]);
  const [exportFormat, setExportFormat] = useState('CSVWithNames');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [historyList, setHistoryList] = useState<QueryHistoryItem[]>([]);
  const [customSnippets, setCustomSnippets] = useState<CustomSnippet[]>([]);

  // Load History & Custom Snippets
  useEffect(() => {
    try {
      const h = JSON.parse(localStorage.getItem('clickhouse_console_history') || '[]');
      setHistoryList(h);
      const s = JSON.parse(localStorage.getItem('clickhouse_console_custom_snippets') || '[]');
      setCustomSnippets(s);
    } catch {}
  }, []);

  // Fetch Databases on cluster change
  useEffect(() => {
    let cancel = false;
    const fetchDbs = async () => {
      try {
        const res = await api('/api/query', {
          method: 'POST',
          body: JSON.stringify({ sql: 'SELECT name FROM system.databases ORDER BY name' })
        });
        if (!cancel) {
          const list = (res.data || []).map((row: any) => String(row.name));
          setDatabases(list);
          setSelectedDb('');
          setTables([]);
          setSelectedTable('');
        }
      } catch {}
    };
    fetchDbs();
    return () => {
      cancel = true;
    };
  }, [activeCluster]);

  const handleDbChange = async (db: string) => {
    setSelectedDb(db);
    setSelectedTable('');
    setTables([]);
    if (!db) return;
    try {
      const res = await api('/api/query', {
        method: 'POST',
        body: JSON.stringify({ sql: `SELECT name FROM system.tables WHERE database='${db}' ORDER BY name` })
      });
      setTables((res.data || []).map((r: any) => String(r.name)));
    } catch (err: any) {
      message.error(err.message);
    }
  };

  const handleTableChange = async (tbl: string) => {
    setSelectedTable(tbl);
    if (!tbl || !selectedDb) return;
    try {
      const res = await api('/api/query', {
        method: 'POST',
        body: JSON.stringify({
          sql: `SELECT name FROM system.columns WHERE database='${selectedDb}' AND table='${tbl}' ORDER BY position`
        })
      });
      const cols = (res.data || []).map((r: any) => `\`${r.name}\``).join(',\n    ');
      const suggested = `SELECT\n    ${cols}\nFROM \`${selectedDb}\`.\`${tbl}\`\nLIMIT 100;`;
      setSql(suggested);
    } catch (err: any) {
      message.error(err.message);
    }
  };

  const handleRunQuery = async () => {
    const trimmed = sql.trim();
    if (!trimmed) return;
    setLoading(true);
    try {
      const res = await api('/api/query', {
        method: 'POST',
        body: JSON.stringify({ sql: trimmed })
      });
      setQueryResult(res);
      if (res.meta) {
        setVisibleColumns(res.meta.map((c: QueryMetaColumn) => c.name));
      }

      // Record to history
      const newHistory: QueryHistoryItem = {
        sql: trimmed,
        cluster: activeCluster,
        elapsed_ms: res.elapsed_ms || 0,
        rows: res.rows || 0,
        at: Date.now()
      };
      const updated = [newHistory, ...historyList].slice(0, 50);
      setHistoryList(updated);
      localStorage.setItem('clickhouse_console_history', JSON.stringify(updated));
      message.success(`执行成功 (${res.elapsed_ms || 0} ms)`);
    } catch (err: any) {
      message.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDryRun = async () => {
    const trimmed = sql.trim();
    if (!trimmed) return;
    setDryRunning(true);
    try {
      const res = await api('/api/query/dry-run', {
        method: 'POST',
        body: JSON.stringify({ sql: trimmed })
      });
      message.success(`Dry Run 校验通过: ${res.statement_count} 条语句 (${res.elapsed_ms} ms)`);
    } catch (err: any) {
      message.error(`Dry Run 校验失败: ${err.message}`);
    } finally {
      setDryRunning(false);
    }
  };

  const handleStreamExport = async () => {
    const trimmed = sql.trim();
    if (!trimmed) {
      message.warning('请先在编辑器输入 SQL 查询');
      return;
    }
    setStreaming(true);
    try {
      await streamExport(trimmed, exportFormat, `${activeCluster}-export`);
      message.success('流式导出完成');
    } catch (err: any) {
      message.error(`导出失败: ${err.message}`);
    } finally {
      setStreaming(false);
    }
  };

  const handleSaveCustomSnippet = () => {
    const trimmed = sql.trim();
    if (!trimmed) {
      message.warning('编辑器中没有 SQL 内容');
      return;
    }
    let title = '';
    Modal.confirm({
      title: '保存为自定义片段',
      content: (
        <div style={{ marginTop: 12 }}>
          <Input placeholder="片段名称 (例如: 每日慢查询汇总)" onChange={(e) => (title = e.target.value)} />
        </div>
      ),
      onOk: () => {
        if (!title.trim()) {
          message.warning('片段名称不能为空');
          return;
        }
        const updated = [{ title: title.trim(), sql: trimmed }, ...customSnippets];
        setCustomSnippets(updated);
        localStorage.setItem('clickhouse_console_custom_snippets', JSON.stringify(updated));
        message.success('已保存自定义片段');
      }
    });
  };

  // Table Columns Definition
  const tableColumns = (queryResult?.meta || [])
    .filter((col) => visibleColumns.includes(col.name))
    .map((col) => ({
      title: (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{col.name}</span>
          <span style={{ fontSize: 10, color: token.colorTextTertiary, fontWeight: 400 }}>{col.type}</span>
        </div>
      ),
      dataIndex: col.name,
      key: col.name,
      sorter: (a: any, b: any) => {
        const va = a[col.name],
          vb = b[col.name];
        if (typeof va === 'number' && typeof vb === 'number') return va - vb;
        return String(va ?? '').localeCompare(String(vb ?? ''));
      },
      render: (val: any) => {
        const text = typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val ?? 'NULL');
        return (
          <Tooltip title="点击复制内容">
            <span
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 12,
                cursor: 'pointer',
                display: 'block',
                maxWidth: 400,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
              onClick={() => {
                navigator.clipboard.writeText(text);
                message.success('单元格内容已复制');
              }}
            >
              {text}
            </span>
          </Tooltip>
        );
      }
    }));

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100vh', gap: 10, boxSizing: 'border-box' }}>
      {/* Top Toolbar Card */}
      <Card size="small" bodyStyle={{ padding: '8px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <Space size={8}>
            <Select
              placeholder="选择数据库"
              size="small"
              style={{ width: 160 }}
              showSearch
              value={selectedDb || undefined}
              onChange={handleDbChange}
              options={databases.map((db) => ({ value: db, label: db }))}
            />
            <Select
              placeholder="选择数据表"
              size="small"
              style={{ width: 180 }}
              showSearch
              disabled={!selectedDb}
              value={selectedTable || undefined}
              onChange={handleTableChange}
              options={tables.map((tbl) => ({ value: tbl, label: tbl }))}
            />
          </Space>

          <Space size={6}>
            <Button size="small" icon={<BookOutlined />} onClick={() => setDrawerOpen(true)}>
              历史 / 片段
            </Button>
            <Button
              size="small"
              icon={<SafetyCertificateOutlined />}
              loading={dryRunning}
              onClick={handleDryRun}
            >
              Dry Run
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<PlayCircleOutlined />}
              loading={loading}
              onClick={handleRunQuery}
              style={{ fontWeight: 600 }}
            >
              运行 <Text keyboard style={{ fontSize: 10, color: 'inherit' }}>⌘↵</Text>
            </Button>
          </Space>
        </div>
      </Card>

      {/* SQL Editor Area */}
      <Card
        size="small"
        bodyStyle={{ padding: 0, height: '36vh', minHeight: 180 }}
        style={{ overflow: 'hidden' }}
      >
        <CodeMirror
          value={sql}
          height="100%"
          theme={themeMode === 'dark' ? oneDark : 'light'}
          extensions={[sqlLang()]}
          onChange={(val) => setSql(val)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              handleRunQuery();
            }
          }}
          style={{ height: '100%', fontSize: 13 }}
        />
      </Card>

      {/* Query Result Area */}
      <Card
        size="small"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        bodyStyle={{ padding: 0, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
        title={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 0' }}>
            <Space size={8}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>查询结果</span>
              {queryResult && (
                <Tag color="cyan">
                  {queryResult.rows || 0} 行 · {queryResult.elapsed_ms || 0} ms
                </Tag>
              )}
            </Space>

            <Space size={6}>
              {queryResult?.meta && (
                <Dropdown
                  trigger={['click']}
                  dropdownRender={() => (
                    <div
                      style={{
                        padding: 10,
                        background: token.colorBgElevated,
                        borderRadius: 8,
                        boxShadow: token.boxShadowSecondary,
                        maxHeight: 240,
                        overflowY: 'auto'
                      }}
                    >
                      <Checkbox.Group
                        value={visibleColumns}
                        onChange={(vals) => setVisibleColumns(vals as string[])}
                        style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                        options={queryResult.meta?.map((m) => ({ label: m.name, value: m.name }))}
                      />
                    </div>
                  )}
                >
                  <Button size="small">显示列 ({visibleColumns.length}/{queryResult.meta.length})</Button>
                </Dropdown>
              )}

              <Select
                size="small"
                value={exportFormat}
                onChange={setExportFormat}
                style={{ width: 140 }}
                options={[
                  { value: 'CSVWithNames', label: 'CSV (.csv)' },
                  { value: 'TabSeparatedWithNames', label: 'TSV (.tsv)' },
                  { value: 'JSONEachRow', label: 'JSONL (.jsonl)' },
                  { value: 'JSON', label: 'JSON (.json)' },
                  { value: 'Parquet', label: 'Parquet (.parquet)' }
                ]}
              />

              <Button
                size="small"
                icon={<CloudDownloadOutlined />}
                loading={streaming}
                onClick={handleStreamExport}
              >
                流式导出
              </Button>
            </Space>
          </div>
        }
      >
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {queryResult?.data ? (
            <Table
              size="small"
              columns={tableColumns}
              dataSource={queryResult.data.map((row, idx) => ({ ...row, _key: idx }))}
              rowKey="_key"
              pagination={{ defaultPageSize: 50, showSizeChanger: true, pageSizeOptions: ['20', '50', '100', '200'] }}
              scroll={{ x: 'max-content', y: 300 }}
              style={{ fontSize: 12 }}
            />
          ) : (
            <div style={{ display: 'grid', placeItems: 'center', height: '100%', minHeight: 180, color: token.colorTextTertiary }}>
              输入 SQL 查询并点击「运行」查看结果
            </div>
          )}
        </div>
      </Card>

      {/* Snippets & History Drawer */}
      <Drawer
        title="SQL 常用片段与执行历史"
        placement="right"
        width={480}
        onClose={() => setDrawerOpen(false)}
        open={drawerOpen}
        extra={
          <Button size="small" icon={<PlusOutlined />} onClick={handleSaveCustomSnippet}>
            保存当前 SQL 为片段
          </Button>
        }
      >
        <Tabs
          defaultActiveKey="snippets"
          items={[
            {
              key: 'snippets',
              label: '常用诊断片段',
              children: (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {[...customSnippets, ...builtInSnippets].map((s, idx) => (
                    <Card
                      key={idx}
                      size="small"
                      title={<span style={{ fontWeight: 600, fontSize: 13 }}>{s.title}</span>}
                      extra={
                        <Space size={4}>
                          <Button
                            size="small"
                            type="link"
                            onClick={() => {
                              setSql(s.sql);
                              setDrawerOpen(false);
                              message.success('已载入 SQL 到编辑器');
                            }}
                          >
                            载入
                          </Button>
                          <Button
                            size="small"
                            type="link"
                            onClick={() => {
                              navigator.clipboard.writeText(s.sql);
                              message.success('SQL 已复制');
                            }}
                          >
                            复制
                          </Button>
                        </Space>
                      }
                    >
                      {s.desc && <Paragraph type="secondary" style={{ fontSize: 11, margin: '0 0 6px' }}>{s.desc}</Paragraph>}
                      <pre
                        style={{
                          margin: 0,
                          padding: 8,
                          borderRadius: 6,
                          background: token.colorFillAlter,
                          fontSize: 11,
                          fontFamily: 'JetBrains Mono, monospace',
                          maxHeight: 140,
                          overflow: 'auto'
                        }}
                      >
                        {s.sql}
                      </pre>
                    </Card>
                  ))}
                </div>
              )
            },
            {
              key: 'history',
              label: '执行历史记录',
              children: (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={() => {
                        setHistoryList([]);
                        localStorage.removeItem('clickhouse_console_history');
                        message.success('历史记录已清空');
                      }}
                    >
                      清空历史
                    </Button>
                  </div>
                  {historyList.length ? (
                    historyList.map((h, idx) => (
                      <Card
                        key={idx}
                        size="small"
                        title={
                          <Space size={8}>
                            <Tag color="blue">{h.cluster}</Tag>
                            <span style={{ fontSize: 11, color: token.colorTextTertiary }}>
                              {new Date(h.at).toLocaleTimeString()}
                            </span>
                          </Space>
                        }
                        extra={
                          <Space size={4}>
                            <span style={{ fontSize: 11, color: token.colorTextTertiary, marginRight: 6 }}>
                              {h.elapsed_ms}ms · {h.rows}行
                            </span>
                            <Button
                              size="small"
                              type="link"
                              onClick={() => {
                                setSql(h.sql);
                                setDrawerOpen(false);
                                message.success('已载入历史 SQL 到编辑器');
                              }}
                            >
                              载入
                            </Button>
                          </Space>
                        }
                      >
                        <pre
                          style={{
                            margin: 0,
                            padding: 6,
                            borderRadius: 4,
                            background: token.colorFillAlter,
                            fontSize: 11,
                            fontFamily: 'JetBrains Mono, monospace',
                            maxHeight: 100,
                            overflow: 'auto'
                          }}
                        >
                          {h.sql}
                        </pre>
                      </Card>
                    ))
                  ) : (
                    <div style={{ textAlign: 'center', padding: 24, color: token.colorTextTertiary }}>
                      暂无执行历史
                    </div>
                  )}
                </div>
              )
            }
          ]}
        />
      </Drawer>
    </div>
  );
};
