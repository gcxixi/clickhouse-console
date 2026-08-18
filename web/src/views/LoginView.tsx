import React, { useState } from 'react';
import { Card, Form, Input, Button, Typography, Alert, Space } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { BrandLogo } from '../components/BrandLogo';
import { api, setCSRFToken } from '../api';
import { User, Cluster } from '../types';

const { Text } = Typography;

interface LoginViewProps {
  onLoginSuccess: (data: { user: User; clusters: Cluster[]; active_cluster: string; csrf: string }) => void;
}

export const LoginView: React.FC<LoginViewProps> = ({ onLoginSuccess }) => {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleSubmit = async (values: any) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          username: values.username,
          password: values.password
        })
      });
      setCSRFToken(data.csrf);
      onLoginSuccess(data);
    } catch (err: any) {
      setErrorMsg(err.message || '登录失败，请检查用户名与密码');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'radial-gradient(ellipse at 50% 15%, rgba(245, 158, 11, 0.12) 0%, transparent 60%)',
        padding: 16
      }}
    >
      <Card
        style={{
          width: '100%',
          maxWidth: 380,
          borderRadius: 14,
          boxShadow: '0 20px 40px -15px rgba(0, 0, 0, 0.08)'
        }}
        bodyStyle={{ padding: '32px 28px' }}
      >
        <Space direction="vertical" size={20} style={{ width: '100%' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
            <BrandLogo size={32} />
            <Text type="secondary" style={{ fontSize: 13, marginTop: 4 }}>
              安全、极致轻量的现代数据库工作台
            </Text>
          </div>

          {errorMsg && <Alert type="error" message={errorMsg} showIcon closable onClose={() => setErrorMsg(null)} />}

          <Form layout="vertical" onFinish={handleSubmit} requiredMark={false} size="large">
            <Form.Item
              name="username"
              label={<span style={{ fontSize: 12, fontWeight: 600 }}>用户名</span>}
              rules={[{ required: true, message: '请输入用户名' }]}
            >
              <Input prefix={<UserOutlined style={{ color: '#9ca3af' }} />} placeholder="用户名" />
            </Form.Item>

            <Form.Item
              name="password"
              label={<span style={{ fontSize: 12, fontWeight: 600 }}>密码</span>}
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password prefix={<LockOutlined style={{ color: '#9ca3af' }} />} placeholder="密码" />
            </Form.Item>

            <Form.Item style={{ marginBottom: 0, marginTop: 24 }}>
              <Button type="primary" htmlType="submit" block loading={loading} style={{ fontWeight: 600 }}>
                登录控制台
              </Button>
            </Form.Item>
          </Form>
        </Space>
      </Card>
    </div>
  );
};
