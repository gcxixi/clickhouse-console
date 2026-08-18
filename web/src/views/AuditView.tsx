import React, { useState, useEffect } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Tag,
  Tooltip,
  Typography,
  Drawer,
  message,
  theme as antTheme
} from 'antd';
import { FileTextOutlined, ReloadOutlined, CopyOutlined, EyeOutlined } from '@ant-design/icons';
import { api } from '../api';
import { AuditEntry } from '../types';

const { Text } = Typography;

export const AuditView: React.FC = () => {
  const { token } = antTheme.useToken();
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedLog, setSelectedLog] = useState<AuditEntry | null>(null);

  const fetchAudit = async () => {
    setLoading(true);
    try {
      const data = await api<AuditEntry[]>('/api/audit?limit=500');
      setLogs(data || []);
    } catch (err: any) {
      message.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAudit();
  }, []);

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100vh', gap: 10, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Space size={10}>
          <FileTextOutlined style={{ color: token.colorPrimary, fontSize: 16 }} />
          <span style={{ fontSize: 14, fontWeight: 700 }}>系统审计日志 (最近 500 条)</span>
        </Space>

        <Button size="small" icon={<ReloadOutlined />} onClick={fetchAudit} loading={loading} />
      </div>

      <Card size="small" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }} bodyStyle={{ padding: 0, flex: 1, overflow: 'auto' }}>
        <Table
          size="small"
          loading={loading}
          dataSource={logs.map((item, idx) => ({ ...item, _key: idx }))}
          rowKey="_key"
          columns={[
            {
              title: '时间',
              dataIndex: 'At',
              width: 170,
              render: (t) => <span style={{ fontSize: 12 }}>{new Date(t).toLocaleString()}</span>
            },
            {
              title: '用户',
              dataIndex: 'User',
              width: 110,
              render: (u) => <Text strong>{u || '—'}</Text>
            },
            {
              title: '集群',
              dataIndex: 'Cluster',
              width: 110,
              render: (c) => <Tag>{c || '—'}</Tag>
            },
            {
              title: '操作动作',
              dataIndex: 'Action',
              width: 120,
              render: (a) => <Tag color="blue">{a}</Tag>
            },
            {
              title: '状态',
              dataIndex: 'Status',
              width: 80,
              render: (s) => <Tag color={s === 'ok' ? 'green' : 'error'}>{s}</Tag>
            },
            {
              title: '耗时',
              dataIndex: 'DurationMS',
              width: 90,
              render: (d) => `${d || 0} ms`
            },
            {
              title: '语句 / 错误详情',
              key: 'detail',
              render: (_, r) => {
                const detail = r.Error || r.Statement || '—';
                return (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div
                      style={{
                        fontFamily: 'JetBrains Mono, monospace',
                        fontSize: 11,
                        maxWidth: 450,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {detail}
                    </div>
                    <Space size={2}>
                      <Tooltip title="查看完整详情">
                        <Button size="small" type="text" icon={<EyeOutlined />} onClick={() => setSelectedLog(r)} />
                      </Tooltip>
                      <Tooltip title="复制内容">
                        <Button
                          size="small"
                          type="text"
                          icon={<CopyOutlined />}
                          onClick={() => {
                            navigator.clipboard.writeText(detail);
                            message.success('已复制到剪贴板');
                          }}
                        />
                      </Tooltip>
                    </Space>
                  </div>
                );
              }
            }
          ]}
          scroll={{ y: 'calc(100vh - 130px)' }}
        />
      </Card>

      <Drawer
        title="审计日志详情"
        open={Boolean(selectedLog)}
        onClose={() => setSelectedLog(null)}
        width={540}
        extra={
          <Button
            size="small"
            icon={<CopyOutlined />}
            onClick={() => {
              const text = selectedLog?.Error || selectedLog?.Statement || '';
              navigator.clipboard.writeText(text);
              message.success('已复制');
            }}
          >
            复制语句
          </Button>
        }
      >
        {selectedLog && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>操作用户</Text>
              <div><Text strong>{selectedLog.User || '—'}</Text></div>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>操作动作 / 集群</Text>
              <div><Tag color="blue">{selectedLog.Action}</Tag> <Tag>{selectedLog.Cluster || '—'}</Tag></div>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>时间 / 执行耗时</Text>
              <div>{new Date(selectedLog.At).toLocaleString()} ({selectedLog.DurationMS || 0} ms)</div>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>完整 SQL / 响应详情</Text>
              <pre
                style={{
                  marginTop: 6,
                  padding: 12,
                  borderRadius: 6,
                  background: token.colorFillAlter,
                  fontSize: 12,
                  fontFamily: 'JetBrains Mono, monospace',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  maxHeight: 380,
                  overflowY: 'auto'
                }}
              >
                {selectedLog.Error || selectedLog.Statement || '—'}
              </pre>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
};
