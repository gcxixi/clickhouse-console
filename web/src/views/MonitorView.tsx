import React, { useState, useEffect } from 'react';
import {
  Card,
  Row,
  Col,
  Statistic,
  Table,
  Button,
  Space,
  Tag,
  Tooltip,
  message,
  theme as antTheme
} from 'antd';
import {
  LineChartOutlined,
  ReloadOutlined
} from '@ant-design/icons';
import { api } from '../api';
import { MonitorSnapshot } from '../types';

interface MonitorViewProps {
  activeCluster: string;
}

export const MonitorView: React.FC<MonitorViewProps> = ({ activeCluster }) => {
  const { token } = antTheme.useToken();
  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  const fetchMonitor = async () => {
    setLoading(true);
    try {
      const res = await api('/api/monitor');
      setSnapshot(res.snapshot);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err: any) {
      message.error(`加载监控数据失败: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMonitor();
  }, [activeCluster]);

  const formatBytes = (bytes: any) => {
    const num = Number(bytes);
    if (!Number.isFinite(num) || num <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(num) / Math.log(1024));
    return `${(num / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  };

  const formatDuration = (seconds: any) => {
    const s = Math.max(0, Number(seconds) || 0);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}天 ${h}小时`;
    if (h > 0) return `${h}小时 ${m}分`;
    return `${m}分`;
  };

  const metrics = [...(snapshot?.metrics || []), ...(snapshot?.asynchronous_metrics || [])];
  const metricMap = new Map(metrics.map((m) => [m.metric, m.value]));

  const disks = snapshot?.disks || [];
  const diskTotal = disks.reduce((sum, d) => sum + Number(d.total_space_in_bytes || 0), 0);
  const diskFree = disks.reduce((sum, d) => sum + Number(d.free_space_in_bytes || 0), 0);
  const diskUsed = Math.max(0, diskTotal - diskFree);

  const parts = snapshot?.parts || [];
  const partCount = parts.reduce((sum, p) => sum + Number(p.parts || 0), 0);

  const events = [...(snapshot?.events || [])].sort((a, b) => Number(b.value) - Number(a.value));

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100vh', gap: 10, boxSizing: 'border-box' }}>
      {/* Top Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Space size={8}>
          <LineChartOutlined style={{ color: token.colorPrimary, fontSize: 16 }} />
          <span style={{ fontSize: 14, fontWeight: 700 }}>运行监控中心</span>
          {lastUpdated && <Tag color="green">更新于 {lastUpdated}</Tag>}
        </Space>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => fetchMonitor()}>
          刷新监控
        </Button>
      </div>

      {/* Metric Cards */}
      <Row gutter={[8, 8]}>
        <Col xs={12} sm={8} md={4}>
          <Card size="small" bodyStyle={{ padding: '10px 14px' }}>
            <Statistic
              title={<span style={{ fontSize: 11, color: token.colorTextTertiary }}>磁盘占用</span>}
              value={`${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`}
              valueStyle={{ fontSize: 15, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small" bodyStyle={{ padding: '10px 14px' }}>
            <Statistic
              title={<span style={{ fontSize: 11, color: token.colorTextTertiary }}>运行查询</span>}
              value={metricMap.get('Query') ?? 0}
              valueStyle={{ fontSize: 16, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small" bodyStyle={{ padding: '10px 14px' }}>
            <Statistic
              title={<span style={{ fontSize: 11, color: token.colorTextTertiary }}>后台合并 (Merge)</span>}
              value={metricMap.get('Merge') ?? 0}
              valueStyle={{ fontSize: 16, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small" bodyStyle={{ padding: '10px 14px' }}>
            <Statistic
              title={<span style={{ fontSize: 11, color: token.colorTextTertiary }}>内存占用</span>}
              value={formatBytes(metricMap.get('MemoryTracking') ?? 0)}
              valueStyle={{ fontSize: 16, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small" bodyStyle={{ padding: '10px 14px' }}>
            <Statistic
              title={<span style={{ fontSize: 11, color: token.colorTextTertiary }}>运行时间 (Uptime)</span>}
              value={formatDuration(metricMap.get('Uptime'))}
              valueStyle={{ fontSize: 15, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small" bodyStyle={{ padding: '10px 14px' }}>
            <Statistic
              title={<span style={{ fontSize: 11, color: token.colorTextTertiary }}>活动数据分区</span>}
              value={Number(partCount || 0).toLocaleString()}
              valueStyle={{ fontSize: 16, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}
            />
          </Card>
        </Col>
      </Row>

      {/* Grid: Parts (Left) & Events / Metrics (Right) */}
      <Row gutter={[10, 10]} style={{ flex: 1, minHeight: 0 }}>
        {/* Parts Table */}
        <Col xs={24} md={10} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <Card
            size="small"
            title={<span style={{ fontSize: 12, fontWeight: 600 }}>最大数据表 / Parts 分布</span>}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            bodyStyle={{ padding: 0, flex: 1, overflow: 'auto' }}
          >
            <Table
              size="small"
              pagination={false}
              dataSource={parts.map((p, i) => ({ ...p, _id: i }))}
              rowKey="_id"
              columns={[
                { title: '库/表', key: 'table', render: (_, r: any) => `${r.database}.${r.table}` },
                { title: '空间', dataIndex: 'bytes', key: 'bytes', render: (b: any) => formatBytes(b) },
                { title: 'Parts', dataIndex: 'parts', key: 'parts', render: (p: any) => Number(p).toLocaleString() },
                { title: '行数', dataIndex: 'rows', key: 'rows', render: (r: any) => Number(r).toLocaleString() }
              ]}
              scroll={{ y: 260 }}
            />
          </Card>
        </Col>

        {/* Events Table */}
        <Col xs={24} md={7} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <Card
            size="small"
            title={<span style={{ fontSize: 12, fontWeight: 600 }}>累计事件 ({events.length})</span>}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            bodyStyle={{ padding: 0, flex: 1, overflow: 'auto' }}
          >
            <Table
              size="small"
              pagination={false}
              dataSource={events.map((e, i) => ({ ...e, _id: i }))}
              rowKey="_id"
              columns={[
                {
                  title: '事件名称',
                  dataIndex: 'event',
                  key: 'event',
                  ellipsis: true,
                  render: (e: string) => (
                    <Tooltip title={e}>
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{e}</span>
                    </Tooltip>
                  )
                },
                {
                  title: '累计值',
                  dataIndex: 'value',
                  key: 'value',
                  width: 90,
                  align: 'right',
                  render: (v: any) => (
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                      {Number(v).toLocaleString()}
                    </span>
                  )
                }
              ]}
              scroll={{ y: 260 }}
            />
          </Card>
        </Col>

        {/* Metrics Table */}
        <Col xs={24} md={7} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <Card
            size="small"
            title={<span style={{ fontSize: 12, fontWeight: 600 }}>实时指标 ({metrics.length})</span>}
            style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            bodyStyle={{ padding: 0, flex: 1, overflow: 'auto' }}
          >
            <Table
              size="small"
              pagination={false}
              dataSource={metrics.map((m, i) => ({ ...m, _id: i }))}
              rowKey="_id"
              columns={[
                {
                  title: '指标名称',
                  dataIndex: 'metric',
                  key: 'metric',
                  ellipsis: true,
                  render: (m: string) => (
                    <Tooltip title={m}>
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{m}</span>
                    </Tooltip>
                  )
                },
                {
                  title: '当前值',
                  dataIndex: 'value',
                  key: 'value',
                  width: 90,
                  align: 'right',
                  render: (v: any) => (
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                      {Number(v).toLocaleString()}
                    </span>
                  )
                }
              ]}
              scroll={{ y: 260 }}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
};
