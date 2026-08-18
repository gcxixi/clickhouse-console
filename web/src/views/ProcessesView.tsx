import React, { useState, useEffect, useRef } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Switch,
  Tag,
  Popconfirm,
  Tooltip,
  Typography,
  message,
  theme as antTheme
} from 'antd';
import { ReloadOutlined, ThunderboltOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { api } from '../api';
import { Process, User } from '../types';

const { Text } = Typography;

interface ProcessesViewProps {
  activeCluster: string;
  currentUser: User;
}

export const ProcessesView: React.FC<ProcessesViewProps> = ({ activeCluster, currentUser }) => {
  const { token } = antTheme.useToken();
  const [processes, setProcesses] = useState<Process[]>([]);
  const [loading, setLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [killingId, setKillingId] = useState<string | null>(null);
  const timerRef = useRef<any>(null);

  const fetchProcesses = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const res = await api('/api/processes');
      setProcesses(res.processes || []);
    } catch (err: any) {
      message.error(err.message);
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    fetchProcesses();
  }, [activeCluster]);

  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(() => {
        fetchProcesses(false);
      }, 3000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [autoRefresh, activeCluster]);

  const handleKill = async (queryId: string) => {
    setKillingId(queryId);
    try {
      await api('/api/processes/kill', {
        method: 'POST',
        body: JSON.stringify({ query_id: queryId })
      });
      message.success(`查询 ${queryId} 已终止`);
      setTimeout(() => fetchProcesses(false), 300);
    } catch (err: any) {
      message.error(err.message);
    } finally {
      setKillingId(null);
    }
  };

  const formatBytes = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  };

  const columns = [
    {
      title: 'Query ID',
      dataIndex: 'query_id',
      key: 'query_id',
      width: 220,
      render: (id: string) => (
        <Tooltip title="点击复制 Query ID">
          <Text
            copyable={{ text: id }}
            style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}
          >
            {id}
          </Text>
        </Tooltip>
      )
    },
    {
      title: '用户',
      dataIndex: 'user',
      key: 'user',
      width: 100,
      render: (u: string) => <Tag color="blue">{u}</Tag>
    },
    {
      title: '耗时',
      dataIndex: 'elapsed',
      key: 'elapsed',
      width: 90,
      sorter: (a: Process, b: Process) => a.elapsed - b.elapsed,
      render: (sec: number) => (
        <span style={{ fontWeight: 600, color: sec > 10 ? '#ef4444' : 'inherit' }}>
          {Number(sec).toFixed(1)}s
        </span>
      )
    },
    {
      title: '读取行数',
      dataIndex: 'read_rows',
      key: 'read_rows',
      width: 110,
      sorter: (a: Process, b: Process) => a.read_rows - b.read_rows,
      render: (rows: number) => Number(rows || 0).toLocaleString()
    },
    {
      title: '读取字节',
      dataIndex: 'read_bytes',
      key: 'read_bytes',
      width: 110,
      sorter: (a: Process, b: Process) => a.read_bytes - b.read_bytes,
      render: (bytes: number) => formatBytes(bytes)
    },
    {
      title: '内存占用',
      dataIndex: 'memory_usage',
      key: 'memory_usage',
      width: 110,
      sorter: (a: Process, b: Process) => a.memory_usage - b.memory_usage,
      render: (mem: number) => formatBytes(mem)
    },
    {
      title: 'SQL 语句',
      dataIndex: 'query',
      key: 'query',
      render: (q: string) => (
        <Tooltip title={q}>
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
            {q}
          </div>
        </Tooltip>
      )
    },
    ...(currentUser.Role !== 'viewer'
      ? [
          {
            title: '操作',
            key: 'action',
            width: 90,
            render: (_: any, record: Process) => (
              <Popconfirm
                title="确认终止该查询？"
                description={`Query ID: ${record.query_id}`}
                onConfirm={() => handleKill(record.query_id)}
                okText="终止 (Kill)"
                okType="danger"
                cancelText="取消"
              >
                <Button
                  size="small"
                  danger
                  icon={<CloseCircleOutlined />}
                  loading={killingId === record.query_id}
                >
                  Kill
                </Button>
              </Popconfirm>
            )
          }
        ]
      : [])
  ];

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100vh', gap: 10, boxSizing: 'border-box' }}>
      <Card
        size="small"
        title={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Space size={8}>
              <ThunderboltOutlined style={{ color: token.colorPrimary }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>运行中查询 ({processes.length})</span>
            </Space>

            <Space size={12}>
              <Space size={6}>
                <span style={{ fontSize: 12, color: token.colorTextSecondary }}>自动刷新 (3s)</span>
                <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
              </Space>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={loading}
                onClick={() => fetchProcesses(true)}
              >
                刷新
              </Button>
            </Space>
          </div>
        }
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        bodyStyle={{ padding: 0, flex: 1, overflow: 'auto' }}
      >
        <Table
          size="small"
          loading={loading}
          columns={columns}
          dataSource={processes}
          rowKey="query_id"
          pagination={false}
          locale={{ emptyText: '当前没有正在运行的查询' }}
          scroll={{ x: 'max-content', y: 'calc(100vh - 120px)' }}
        />
      </Card>
    </div>
  );
};
