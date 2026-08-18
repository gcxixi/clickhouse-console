import React, { useState, useEffect } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  Select,
  Typography,
  message,
  theme as antTheme
} from 'antd';
import { PlusOutlined, TeamOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from '../api';
import { User } from '../types';

const { Text } = Typography;

interface UsersViewProps {
  currentUser: User;
}

export const UsersView: React.FC<UsersViewProps> = ({ currentUser }) => {
  const { token } = antTheme.useToken();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm();

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const data = await api<User[]>('/api/users');
      setUsers(data || []);
    } catch (err: any) {
      message.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleToggleDisabled = async (user: User) => {
    try {
      await api(`/api/users/${user.ID}`, {
        method: 'PATCH',
        body: JSON.stringify({ Disabled: !user.Disabled })
      });
      message.success(`用户 ${user.Username} 已${user.Disabled ? '启用' : '停用'}`);
      fetchUsers();
    } catch (err: any) {
      message.error(err.message);
    }
  };

  const handleCreateUser = async (values: any) => {
    try {
      await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          username: values.username,
          password: values.password,
          role: values.role
        })
      });
      message.success('用户已创建');
      setModalOpen(false);
      form.resetFields();
      fetchUsers();
    } catch (err: any) {
      message.error(err.message);
    }
  };

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100vh', gap: 10, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Space size={10}>
          <TeamOutlined style={{ color: token.colorPrimary, fontSize: 16 }} />
          <span style={{ fontSize: 14, fontWeight: 700 }}>用户权限管理</span>
        </Space>

        <Space size={6}>
          <Button
            type="primary"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => {
              form.resetFields();
              form.setFieldsValue({ role: 'viewer' });
              setModalOpen(true);
            }}
          >
            新建用户
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={fetchUsers} loading={loading} />
        </Space>
      </div>

      <Card size="small" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }} bodyStyle={{ padding: 0, flex: 1, overflow: 'auto' }}>
        <Table
          size="small"
          loading={loading}
          dataSource={users}
          rowKey="ID"
          columns={[
            {
              title: '用户名',
              dataIndex: 'Username',
              render: (u, r) => (
                <Space size={6}>
                  <Text strong>{u}</Text>
                  {r.ID === currentUser.ID && <Tag color="gold">当前账号</Tag>}
                </Space>
              )
            },
            {
              title: '角色',
              dataIndex: 'Role',
              render: (r) => (
                <Tag color={r === 'admin' ? 'gold' : r === 'editor' ? 'blue' : 'default'}>
                  {r.toUpperCase()}
                </Tag>
              )
            },
            {
              title: '状态',
              dataIndex: 'Disabled',
              render: (d) => <Tag color={d ? 'error' : 'green'}>{d ? '已停用' : '正常'}</Tag>
            },
            {
              title: '创建时间',
              dataIndex: 'CreatedAt',
              render: (t) => new Date(t).toLocaleString()
            },
            {
              title: '操作',
              key: 'action',
              render: (_, u) =>
                u.ID !== currentUser.ID ? (
                  <Button
                    size="small"
                    danger={!u.Disabled}
                    onClick={() => handleToggleDisabled(u)}
                  >
                    {u.Disabled ? '启用账号' : '停用账号'}
                  </Button>
                ) : (
                  <Text type="secondary" style={{ fontSize: 12 }}>本人账号</Text>
                )
            }
          ]}
        />
      </Card>

      <Modal
        title="新建控制台用户"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
      >
        <Form form={form} layout="vertical" onFinish={handleCreateUser} size="small" style={{ marginTop: 12 }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="例如: analyst_01" />
          </Form.Item>

          <Form.Item
            name="password"
            label="密码 (至少 12 个字符)"
            rules={[
              { required: true, message: '请输入密码' },
              { min: 12, message: '密码长度至少为 12 位' }
            ]}
          >
            <Input.Password placeholder="密码" />
          </Form.Item>

          <Form.Item name="role" label="权限角色" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'viewer', label: 'Viewer — 只读查询' },
                { value: 'editor', label: 'Editor — 查询与 DML' },
                { value: 'admin', label: 'Admin — 全功能管理' }
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
