import React, { useState, useEffect } from 'react';
import {
  Layout,
  Menu,
  Select,
  Badge,
  Avatar,
  Typography,
  Tag,
  Button,
  Modal,
  Space,
  Tooltip,
  theme as antTheme
} from 'antd';
import {
  ConsoleSqlOutlined,
  DatabaseOutlined,
  LineChartOutlined,
  BellOutlined,
  CloudServerOutlined,
  TeamOutlined,
  FileTextOutlined,
  LogoutOutlined,
  BulbOutlined,
  BulbFilled,
  ThunderboltOutlined
} from '@ant-design/icons';
import { BrandLogo } from './BrandLogo';
import { User, Cluster } from '../types';
import { api } from '../api';

const { Sider, Content } = Layout;
const { Text } = Typography;

interface AppLayoutProps {
  user: User;
  clusters: Cluster[];
  activeCluster: string;
  activeView: string;
  themeMode: 'light' | 'dark';
  onToggleTheme: () => void;
  onSelectView: (view: string) => void;
  onSwitchCluster: (alias: string) => Promise<void>;
  onLogout: () => void;
  children: React.ReactNode;
}

export const AppLayout: React.FC<AppLayoutProps> = ({
  user,
  clusters,
  activeCluster,
  activeView,
  themeMode,
  onToggleTheme,
  onSelectView,
  onSwitchCluster,
  onLogout,
  children
}) => {
  const { token } = antTheme.useToken();
  const [healthStatus, setHealthStatus] = useState<'ok' | 'bad' | 'checking'>('checking');
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let cancel = false;
    const check = async () => {
      try {
        await api('/api/health');
        if (!cancel) setHealthStatus('ok');
      } catch {
        if (!cancel) setHealthStatus('bad');
      }
    };
    check();
    return () => {
      cancel = true;
    };
  }, [activeCluster]);

  const handleClusterSelect = (targetAlias: string) => {
    if (targetAlias === activeCluster) return;
    Modal.confirm({
      title: '确认切换集群',
      content: (
        <div style={{ padding: '8px 0' }}>
          <p>切换后，工作台查询、对象浏览器、运行监控都将指向新集群：</p>
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 6,
              background: token.colorFillAlter,
              border: `1px solid ${token.colorBorderSecondary}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              fontWeight: 600
            }}
          >
            <span>{activeCluster}</span>
            <span style={{ color: token.colorTextTertiary }}>➔</span>
            <span style={{ color: token.colorPrimary }}>{targetAlias}</span>
          </div>
        </div>
      ),
      okText: '确认切换',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setSwitching(true);
        try {
          await onSwitchCluster(targetAlias);
        } finally {
          setSwitching(false);
        }
      }
    });
  };

  const navItems = [
    { key: 'query', icon: <ConsoleSqlOutlined />, label: 'SQL 工作台' },
    { key: 'schema', icon: <DatabaseOutlined />, label: '对象浏览器' },
    { key: 'processes', icon: <ThunderboltOutlined />, label: '运行查询' },
    { key: 'monitor', icon: <LineChartOutlined />, label: '运行监控' },
    ...(user.Role === 'admin'
      ? [
          { key: 'alerting', icon: <BellOutlined />, label: '报警中心' },
          { key: 'clusters', icon: <CloudServerOutlined />, label: '集群管理' },
          { key: 'users', icon: <TeamOutlined />, label: '用户管理' },
          { key: 'audit', icon: <FileTextOutlined />, label: '审计日志' }
        ]
      : [])
  ];

  return (
    <Layout style={{ minHeight: '100vh', background: token.colorBgContainer }}>
      <Sider
        width={210}
        theme={themeMode}
        style={{
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          display: 'flex',
          flexDirection: 'column',
          height: '100vh',
          position: 'sticky',
          top: 0,
          left: 0,
          zIndex: 100,
          background: themeMode === 'dark' ? '#0d1117' : '#ffffff'
        }}
      >
        {/* Sider Top: Brand & Workspace */}
        <div style={{ padding: '14px 12px 10px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
          <div style={{ marginBottom: 12, paddingLeft: 4 }}>
            <BrandLogo size={22} />
          </div>

          {/* Top Cluster Switcher */}
          <Select
            value={activeCluster}
            onChange={handleClusterSelect}
            loading={switching}
            disabled={clusters.length < 2}
            style={{ width: '100%' }}
            size="small"
            dropdownMatchSelectWidth={false}
            options={clusters.map((c) => ({
              value: c.alias,
              label: (
                <Space size={6}>
                  <Badge
                    status={
                      c.alias === activeCluster
                        ? healthStatus === 'ok'
                          ? 'success'
                          : healthStatus === 'bad'
                          ? 'error'
                          : 'processing'
                        : 'default'
                    }
                  />
                  <span style={{ fontWeight: 600, fontSize: 12 }}>{c.alias}</span>
                </Space>
              )
            }))}
          />
        </div>

        {/* Sider Navigation Menu */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
          <Menu
            mode="inline"
            selectedKeys={[activeView]}
            items={navItems}
            onClick={({ key }) => onSelectView(key)}
            style={{
              borderRight: 0,
              background: 'transparent',
              fontSize: 13,
              fontWeight: 500
            }}
          />
        </div>

        {/* Sider Bottom: User Profile & Actions */}
        <div
          style={{
            padding: '10px 12px',
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            display: 'flex',
            alignItems: 'center',
            gap: 8
          }}
        >
          <Avatar
            size={28}
            style={{
              background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
              fontWeight: 700,
              fontSize: 12,
              flexShrink: 0
            }}
          >
            {user.Username ? user.Username[0].toUpperCase() : 'U'}
          </Avatar>
          <div style={{ flex: 1, minWidth: 0, lineHeight: 1.2 }}>
            <Text ellipsis style={{ fontWeight: 600, fontSize: 12, display: 'block' }}>
              {user.Username}
            </Text>
            <Tag
              color={user.Role === 'admin' ? 'gold' : user.Role === 'editor' ? 'blue' : 'default'}
              style={{ fontSize: 9, padding: '0 4px', lineHeight: '14px', margin: 0, height: 14, border: 0 }}
            >
              {user.Role.toUpperCase()}
            </Tag>
          </div>

          <Tooltip title={`切换为${themeMode === 'dark' ? '浅色' : '深色'}主题`}>
            <Button
              type="text"
              size="small"
              icon={themeMode === 'dark' ? <BulbFilled style={{ color: '#fbbf24' }} /> : <BulbOutlined />}
              onClick={onToggleTheme}
            />
          </Tooltip>
          <Tooltip title="退出登录">
            <Button type="text" size="small" icon={<LogoutOutlined />} onClick={onLogout} danger />
          </Tooltip>
        </div>
      </Sider>

      {/* Main Content Area */}
      <Content style={{ minHeight: '100vh', overflow: 'auto', background: token.colorBgLayout }}>
        {children}
      </Content>
    </Layout>
  );
};
