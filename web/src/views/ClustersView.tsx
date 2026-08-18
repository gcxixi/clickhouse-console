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
  Switch,
  Popconfirm,
  Typography,
  message,
  theme as antTheme
} from 'antd';
import { PlusOutlined, CloudServerOutlined, EditOutlined, DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import { api, encryptPayload } from '../api';
import { Cluster } from '../types';

const { Text } = Typography;

interface ClustersViewProps {
  onClustersUpdated: (clusters: Cluster[]) => void;
}

export const ClustersView: React.FC<ClustersViewProps> = ({ onClustersUpdated }) => {
  const { token } = antTheme.useToken();
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCluster, setEditingCluster] = useState<Cluster | null>(null);
  const [form] = Form.useForm();

  const fetchClusters = async () => {
    setLoading(true);
    try {
      const data = await api<Cluster[]>('/api/clusters');
      setClusters(data || []);
      onClustersUpdated(data || []);
    } catch (err: any) {
      message.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchClusters();
  }, []);

  const handleSaveCluster = async (values: any) => {
    try {
      const userVal = (values.clusterUser || '').trim();
      const passVal = values.clusterPassword || '';
      const hasCredentials = Boolean(userVal || passVal);
      const updateCredentials = !editingCluster ? hasCredentials : Boolean(values.updateCredentials);

      let credPayload = { key: '', nonce: '', ciphertext: '' };
      if (updateCredentials && hasCredentials) {
        credPayload = await encryptPayload({ user: userVal, password: passVal });
      }

      const payload = {
        alias: values.alias,
        url: values.url,
        database: values.database || 'default',
        update_credentials: updateCredentials,
        credentials: credPayload
      };

      const res = await api(editingCluster ? `/api/clusters/${editingCluster.id}` : '/api/clusters', {
        method: editingCluster ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      });

      message.success(editingCluster ? '集群已更新' : '集群已添加');
      setModalOpen(false);
      setEditingCluster(null);
      form.resetFields();
      if (res.clusters) onClustersUpdated(res.clusters);
      fetchClusters();
    } catch (err: any) {
      message.error(err.message);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await api(`/api/clusters/${id}`, { method: 'DELETE' });
      message.success('集群已删除');
      if (res.clusters) onClustersUpdated(res.clusters);
      fetchClusters();
    } catch (err: any) {
      message.error(err.message);
    }
  };

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100vh', gap: 10, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Space size={10}>
          <CloudServerOutlined style={{ color: token.colorPrimary, fontSize: 16 }} />
          <span style={{ fontSize: 14, fontWeight: 700 }}>集群配置管理</span>
        </Space>

        <Space size={6}>
          <Button
            type="primary"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditingCluster(null);
              form.resetFields();
              form.setFieldsValue({ database: 'default', updateCredentials: true });
              setModalOpen(true);
            }}
          >
            添加集群
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={fetchClusters} loading={loading} />
        </Space>
      </div>

      <Card size="small" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }} bodyStyle={{ padding: 0, flex: 1, overflow: 'auto' }}>
        <Table
          size="small"
          loading={loading}
          dataSource={clusters}
          rowKey="alias"
          columns={[
            {
              title: '集群别名',
              dataIndex: 'alias',
              render: (a) => <Text strong>{a}</Text>
            },
            {
              title: '来源',
              dataIndex: 'source',
              render: (s) => <Tag color={s === 'platform' ? 'blue' : 'default'}>{s === 'platform' ? '平台管理' : '环境变量'}</Tag>
            },
            { title: 'HTTP 地址', dataIndex: 'url', render: (u) => <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{u}</span> },
            { title: '默认数据库', dataIndex: 'database', render: (db) => db || 'default' },
            {
              title: '凭据状态',
              dataIndex: 'credentials_present',
              render: (cp) => <Tag color={cp ? 'green' : 'default'}>{cp ? '已配置' : '免密/无认证'}</Tag>
            },
            {
              title: '操作',
              key: 'action',
              render: (_, c) =>
                c.source === 'platform' ? (
                  <Space size={4}>
                    <Button
                      size="small"
                      icon={<EditOutlined />}
                      onClick={() => {
                        setEditingCluster(c);
                        form.resetFields();
                        form.setFieldsValue({
                          alias: c.alias,
                          url: c.url,
                          database: c.database || 'default',
                          updateCredentials: false
                        });
                        setModalOpen(true);
                      }}
                    >
                      编辑
                    </Button>
                    <Popconfirm title="确认删除该集群？" onConfirm={() => handleDelete(c.id)}>
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                ) : (
                  <Text type="secondary" style={{ fontSize: 12 }}>只读配置</Text>
                )
            }
          ]}
        />
      </Card>

      {/* Cluster Modal */}
      <Modal
        title={editingCluster ? `编辑集群 ${editingCluster.alias}` : '添加集群'}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
      >
        <Form form={form} layout="vertical" onFinish={handleSaveCluster} size="small" style={{ marginTop: 12 }}>
          <Form.Item
            name="alias"
            label="集群别名"
            rules={[
              { required: true, message: '请输入集群唯一别名' },
              { pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, message: '仅支持字母、数字、点、下划线与中划线' }
            ]}
          >
            <Input placeholder="例如: prod-cluster-1" disabled={Boolean(editingCluster)} />
          </Form.Item>

          <Form.Item name="url" label="ClickHouse HTTP 地址" rules={[{ required: true, message: '请输入 ClickHouse HTTP 地址' }]}>
            <Input placeholder="http://127.0.0.1:8123" />
          </Form.Item>

          <Form.Item name="database" label="默认数据库">
            <Input placeholder="default" />
          </Form.Item>

          {editingCluster && (
            <Form.Item name="updateCredentials" valuePropName="checked">
              <Switch checkedChildren="更新连接凭据" unCheckedChildren="保持原凭据" />
            </Form.Item>
          )}

          <Form.Item name="clusterUser" label="用户名 (免密可留空)">
            <Input placeholder="default" />
          </Form.Item>

          <Form.Item name="clusterPassword" label="密码 (免密可留空)">
            <Input.Password placeholder="密码 (浏览器端公钥加密传输)" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
