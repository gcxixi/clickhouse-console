import React, { useState, useEffect } from 'react';
import {
  Card,
  Tabs,
  Table,
  Button,
  Space,
  Tag,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Popconfirm,
  Tooltip,
  Typography,
  message,
  theme as antTheme
} from 'antd';
import {
  PlusOutlined,
  SettingOutlined,
  SendOutlined,
  EditOutlined,
  DeleteOutlined,
  ReloadOutlined,
  BellOutlined
} from '@ant-design/icons';
import { api, encryptPayload } from '../api';
import { AlertConfig, AlertRule, AlertWebhook, AlertEvent, AlertDelivery, Cluster } from '../types';

const { Text } = Typography;

interface AlertingViewProps {
  clusters: Cluster[];
}

export const AlertingView: React.FC<AlertingViewProps> = ({ clusters }) => {
  const { token } = antTheme.useToken();
  const [config, setConfig] = useState<AlertConfig | null>(null);
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [webhooks, setWebhooks] = useState<AlertWebhook[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [deliveries, setDeliveries] = useState<AlertDelivery[]>([]);
  const [loading, setLoading] = useState(false);

  // Modals
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [webhookModalOpen, setWebhookModalOpen] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<AlertWebhook | null>(null);
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AlertRule | null>(null);

  const [configForm] = Form.useForm();
  const [webhookForm] = Form.useForm();
  const [ruleForm] = Form.useForm();

  const fetchAlertData = async () => {
    setLoading(true);
    try {
      const [cfg, r, w, ev, del] = await Promise.all([
        api('/api/alerting/config'),
        api('/api/alerting/rules').catch(() => []),
        api('/api/alerting/webhooks').catch(() => []),
        api('/api/alerting/events?limit=100').catch(() => []),
        api('/api/alerting/deliveries?limit=100').catch(() => [])
      ]);
      setConfig(cfg);
      setRules(r || []);
      setWebhooks(w || []);
      setEvents(ev || []);
      setDeliveries(del || []);
    } catch (err: any) {
      message.error(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAlertData();
  }, []);

  const handleTestWebhook = async (id: number) => {
    try {
      const res = await api(`/api/alerting/webhooks/${id}/test`, { method: 'POST' });
      if (res.error) {
        message.warning(`测试响应异常: ${res.error}`);
      } else {
        message.success(`测试消息发送成功 (HTTP ${res.http_status})`);
      }
      fetchAlertData();
    } catch (err: any) {
      message.error(`测试失败: ${err.message}`);
    }
  };

  const handleSaveConfig = async (values: any) => {
    try {
      const updateDb = Boolean(values.updateDatabase || !config?.configured);
      let dbPayload = { key: '', nonce: '', ciphertext: '' };
      if (updateDb && values.databaseDSN) {
        dbPayload = await encryptPayload({ secret: values.databaseDSN });
      }
      await api('/api/alerting/config', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: values.enabled,
          driver: values.driver,
          history_limit: values.historyLimit,
          update_database: updateDb,
          database: dbPayload
        })
      });
      message.success('报警存储配置已更新');
      setConfigModalOpen(false);
      fetchAlertData();
    } catch (err: any) {
      message.error(err.message);
    }
  };

  const handleSaveWebhook = async (values: any) => {
    try {
      const updateTarget = Boolean(!editingWebhook || values.updateTarget);
      let targetPayload = { key: '', nonce: '', ciphertext: '' };
      if (updateTarget && values.url) {
        targetPayload = await encryptPayload({
          url: values.url,
          authorization: values.authorization || ''
        });
      }
      const payload = {
        name: values.name,
        channel_type: values.channelType,
        update_target: updateTarget,
        target: targetPayload
      };
      await api(editingWebhook ? `/api/alerting/webhooks/${editingWebhook.id}` : '/api/alerting/webhooks', {
        method: editingWebhook ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      });
      message.success(editingWebhook ? 'Webhook 已更新' : 'Webhook 已创建');
      setWebhookModalOpen(false);
      setEditingWebhook(null);
      fetchAlertData();
    } catch (err: any) {
      message.error(err.message);
    }
  };

  const handleSaveRule = async (values: any) => {
    try {
      const payload = {
        name: values.name,
        cluster: values.cluster,
        sql: values.sql,
        interval_seconds: values.intervalSeconds,
        for_seconds: values.forSeconds,
        repeat_interval_seconds: values.repeatIntervalSeconds || 0,
        webhook_id: values.webhookId ? Number(values.webhookId) : null,
        enabled: values.enabled
      };
      await api(editingRule ? `/api/alerting/rules/${editingRule.id}` : '/api/alerting/rules', {
        method: editingRule ? 'PUT' : 'POST',
        body: JSON.stringify(payload)
      });
      message.success(editingRule ? '报警规则已更新' : '报警规则已创建');
      setRuleModalOpen(false);
      setEditingRule(null);
      fetchAlertData();
    } catch (err: any) {
      message.error(err.message);
    }
  };

  const channelMap: Record<string, { label: string; color: string }> = {
    generic: { label: '通用', color: 'default' },
    wecom: { label: '企业微信', color: 'green' },
    feishu: { label: '飞书', color: 'cyan' },
    dingtalk: { label: '钉钉', color: 'blue' },
    slack: { label: 'Slack', color: 'purple' }
  };

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100vh', gap: 10, boxSizing: 'border-box' }}>
      {/* Top Action Bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Space size={10}>
          <BellOutlined style={{ color: token.colorPrimary, fontSize: 16 }} />
          <span style={{ fontSize: 14, fontWeight: 700 }}>报警中心</span>
          <Tag color={config?.enabled ? 'green' : config?.configured ? 'warning' : 'default'}>
            {config?.enabled ? '调度运行中' : config?.configured ? '已暂停' : '未配置存储'}
          </Tag>
        </Space>

        <Space size={6}>
          <Button
            size="small"
            icon={<SettingOutlined />}
            onClick={() => {
              configForm.setFieldsValue({
                enabled: config?.enabled,
                driver: config?.driver || 'sqlite',
                historyLimit: config?.history_limit || 300,
                updateDatabase: false
              });
              setConfigModalOpen(true);
            }}
          >
            存储配置
          </Button>
          <Button
            size="small"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditingWebhook(null);
              webhookForm.resetFields();
              webhookForm.setFieldsValue({ channelType: 'generic', updateTarget: true });
              setWebhookModalOpen(true);
            }}
          >
            新建 Webhook
          </Button>
          <Button
            type="primary"
            size="small"
            icon={<PlusOutlined />}
            onClick={() => {
              setEditingRule(null);
              ruleForm.resetFields();
              ruleForm.setFieldsValue({
                intervalSeconds: 60,
                forSeconds: 0,
                repeatIntervalSeconds: 0,
                enabled: true,
                cluster: clusters[0]?.alias
              });
              setRuleModalOpen(true);
            }}
          >
            新建规则
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={fetchAlertData} loading={loading} />
        </Space>
      </div>

      {/* Tabs Layout */}
      <Card size="small" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }} bodyStyle={{ padding: 0, flex: 1, overflow: 'auto' }}>
        <Tabs
          defaultActiveKey="rules"
          style={{ padding: '0 12px' }}
          items={[
            {
              key: 'rules',
              label: `报警规则 (${rules.length})`,
              children: (
                <Table
                  size="small"
                  dataSource={rules}
                  rowKey="id"
                  columns={[
                    { title: '#', dataIndex: 'id', width: 60 },
                    {
                      title: '规则名称 / SQL',
                      key: 'name',
                      render: (_, r) => (
                        <div>
                          <Text strong style={{ fontSize: 13 }}>{r.name}</Text>
                          <div style={{ fontSize: 11, color: token.colorTextTertiary, fontFamily: 'monospace', maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {r.sql}
                          </div>
                        </div>
                      )
                    },
                    { title: '集群', dataIndex: 'cluster', render: (c) => <Tag>{c}</Tag> },
                    {
                      title: '周期 / 重复',
                      key: 'interval',
                      render: (_, r) => `${r.interval_seconds}s / ${r.repeat_interval_seconds ? `${r.repeat_interval_seconds}s重复` : '单次'}`
                    },
                    {
                      title: '状态',
                      dataIndex: 'state',
                      render: (st, r) => (
                        <Tag color={!r.enabled ? 'default' : st === 'firing' ? 'error' : st === 'pending' ? 'warning' : 'success'}>
                          {r.enabled ? st : 'disabled'}
                        </Tag>
                      )
                    },
                    {
                      title: '最近评估',
                      key: 'last',
                      render: (_, r) => (
                        <div>
                          <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{r.last_value || '—'}</span>
                          {r.last_evaluated_at && <div style={{ fontSize: 10, color: token.colorTextTertiary }}>{new Date(r.last_evaluated_at).toLocaleTimeString()}</div>}
                        </div>
                      )
                    },
                    {
                      title: '操作',
                      key: 'action',
                      render: (_, r) => (
                        <Space size={4}>
                          <Button
                            size="small"
                            type="text"
                            icon={<EditOutlined />}
                            onClick={() => {
                              setEditingRule(r);
                              ruleForm.setFieldsValue({
                                name: r.name,
                                cluster: r.cluster,
                                intervalSeconds: r.interval_seconds,
                                forSeconds: r.for_seconds,
                                repeatIntervalSeconds: r.repeat_interval_seconds,
                                webhookId: r.webhook_id ? String(r.webhook_id) : '',
                                enabled: r.enabled,
                                sql: r.sql
                              });
                              setRuleModalOpen(true);
                            }}
                          />
                          <Popconfirm
                            title="确认删除该规则？"
                            onConfirm={async () => {
                              await api(`/api/alerting/rules/${r.id}`, { method: 'DELETE' });
                              message.success('规则已删除');
                              fetchAlertData();
                            }}
                          >
                            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                          </Popconfirm>
                        </Space>
                      )
                    }
                  ]}
                />
              )
            },
            {
              key: 'webhooks',
              label: `Webhooks (${webhooks.length})`,
              children: (
                <Table
                  size="small"
                  dataSource={webhooks}
                  rowKey="id"
                  columns={[
                    { title: '#', dataIndex: 'id', width: 60 },
                    { title: '名称', dataIndex: 'name', render: (n) => <Text strong>{n}</Text> },
                    {
                      title: '渠道类型',
                      dataIndex: 'channel_type',
                      render: (t) => <Tag color={channelMap[t]?.color || 'default'}>{channelMap[t]?.label || t}</Tag>
                    },
                    { title: '目标 URL', dataIndex: 'url_hint', render: (u) => <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{u}</span> },
                    { title: '认证', dataIndex: 'auth_configured', render: (a) => <Tag color={a ? 'green' : 'default'}>{a ? '已配置' : '无'}</Tag> },
                    {
                      title: '操作',
                      key: 'action',
                      render: (_, w) => (
                        <Space size={4}>
                          <Tooltip title="发送测试告警消息">
                            <Button size="small" icon={<SendOutlined />} onClick={() => handleTestWebhook(w.id)}>
                              测试
                            </Button>
                          </Tooltip>
                          <Button
                            size="small"
                            icon={<EditOutlined />}
                            onClick={() => {
                              setEditingWebhook(w);
                              webhookForm.setFieldsValue({
                                name: w.name,
                                channelType: w.channel_type || 'generic',
                                updateTarget: false
                              });
                              setWebhookModalOpen(true);
                            }}
                          />
                          <Popconfirm
                            title="确认删除该 Webhook？"
                            onConfirm={async () => {
                              await api(`/api/alerting/webhooks/${w.id}`, { method: 'DELETE' });
                              message.success('Webhook 已删除');
                              fetchAlertData();
                            }}
                          >
                            <Button size="small" danger icon={<DeleteOutlined />} />
                          </Popconfirm>
                        </Space>
                      )
                    }
                  ]}
                />
              )
            },
            {
              key: 'events',
              label: `触发记录 (${events.length})`,
              children: (
                <Table
                  size="small"
                  dataSource={events}
                  rowKey="id"
                  columns={[
                    { title: '时间', dataIndex: 'created_at', render: (t) => new Date(t).toLocaleString() },
                    { title: '规则', key: 'rule', render: (_, e) => `#${e.rule_id} ${e.rule_name}` },
                    { title: '集群', dataIndex: 'cluster', render: (c) => <Tag>{c}</Tag> },
                    { title: '状态', dataIndex: 'status', render: (s) => <Tag color={s === 'firing' ? 'error' : 'green'}>{s}</Tag> },
                    { title: '数值', dataIndex: 'value', render: (v) => <span style={{ fontFamily: 'monospace' }}>{v || '—'}</span> }
                  ]}
                />
              )
            },
            {
              key: 'deliveries',
              label: `发送记录 (${deliveries.length})`,
              children: (
                <Table
                  size="small"
                  dataSource={deliveries}
                  rowKey="id"
                  columns={[
                    { title: '时间', dataIndex: 'created_at', render: (t) => new Date(t).toLocaleString() },
                    { title: '规则', dataIndex: 'rule_name' },
                    { title: 'Webhook', dataIndex: 'webhook_name' },
                    { title: '状态', dataIndex: 'status', render: (s) => <Tag color={s === 'sent' ? 'green' : 'error'}>{s}</Tag> },
                    { title: 'HTTP', dataIndex: 'http_status', render: (h) => h || '—' },
                    { title: '响应/错误', key: 'err', render: (_, d) => <span style={{ fontFamily: 'monospace', fontSize: 11 }}>{d.error || d.response_body || '—'}</span> }
                  ]}
                />
              )
            }
          ]}
        />
      </Card>

      {/* Rule Modal */}
      <Modal
        title={editingRule ? `编辑规则 #${editingRule.id}` : '新建报警规则'}
        open={ruleModalOpen}
        onCancel={() => setRuleModalOpen(false)}
        onOk={() => ruleForm.submit()}
        width={600}
      >
        <Form form={ruleForm} layout="vertical" onFinish={handleSaveRule} size="small" style={{ marginTop: 12 }}>
          <Form.Item name="name" label="规则名称" rules={[{ required: true, message: '请输入规则名称' }]}>
            <Input placeholder="例如: 慢查询突增告警" />
          </Form.Item>
          <Form.Item name="cluster" label="执行集群" rules={[{ required: true }]}>
            <Select options={clusters.map((c) => ({ value: c.alias, label: c.alias }))} />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="intervalSeconds" label="执行周期(秒)" rules={[{ required: true }]}>
              <InputNumber min={5} max={86400} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="forSeconds" label="持续时间 For(秒)" rules={[{ required: true }]}>
              <InputNumber min={0} max={2592000} style={{ width: 140 }} />
            </Form.Item>
            <Form.Item name="repeatIntervalSeconds" label="重复间隔(秒, 0单次)">
              <InputNumber min={0} max={2592000} style={{ width: 160 }} />
            </Form.Item>
          </Space>
          <Form.Item name="webhookId" label="关联 Webhook">
            <Select
              allowClear
              placeholder="不发送，仅记录"
              options={webhooks.map((w) => ({ value: String(w.id), label: `#${w.id} ${w.name} (${w.channel_type})` }))}
            />
          </Form.Item>
          <Form.Item name="enabled" label="启用状态" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="sql" label="只读 SQL 查询 (首行首列为布尔值或数字)" rules={[{ required: true }]}>
            <Input.TextArea rows={5} style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* Webhook Modal */}
      <Modal
        title={editingWebhook ? `编辑 Webhook #${editingWebhook.id}` : '新建 Webhook'}
        open={webhookModalOpen}
        onCancel={() => setWebhookModalOpen(false)}
        onOk={() => webhookForm.submit()}
      >
        <Form form={webhookForm} layout="vertical" onFinish={handleSaveWebhook} size="small" style={{ marginTop: 12 }}>
          <Form.Item name="name" label="Webhook 名称" rules={[{ required: true }]}>
            <Input placeholder="例如: 运维群飞书机器人" />
          </Form.Item>
          <Form.Item name="channelType" label="渠道类型" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'generic', label: '通用 Webhook (Alertmanager 标准)' },
                { value: 'wecom', label: '企业微信群机器人 (WeCom)' },
                { value: 'feishu', label: '飞书自定义机器人 (Feishu)' },
                { value: 'dingtalk', label: '钉钉自定义机器人 (DingTalk)' },
                { value: 'slack', label: 'Slack 传入 Webhook (Slack)' }
              ]}
            />
          </Form.Item>
          {editingWebhook && (
            <Form.Item name="updateTarget" valuePropName="checked">
              <Switch checkedChildren="更新目标地址" unCheckedChildren="保持原目标" />
            </Form.Item>
          )}
          <Form.Item name="url" label="Webhook URL" rules={[{ required: !editingWebhook }]}>
            <Input placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." />
          </Form.Item>
          <Form.Item name="authorization" label="Authorization 头 (可选)">
            <Input.Password placeholder="Bearer ..." />
          </Form.Item>
        </Form>
      </Modal>

      {/* Storage Config Modal */}
      <Modal
        title="报警中心存储配置"
        open={configModalOpen}
        onCancel={() => setConfigModalOpen(false)}
        onOk={() => configForm.submit()}
      >
        <Form form={configForm} layout="vertical" onFinish={handleSaveConfig} size="small" style={{ marginTop: 12 }}>
          <Form.Item name="enabled" label="启用报警调度器" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="driver" label="数据库驱动" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'sqlite', label: 'SQLite (轻量内嵌)' },
                { value: 'postgres', label: 'PostgreSQL' },
                { value: 'mysql', label: 'MySQL' }
              ]}
            />
          </Form.Item>
          <Form.Item name="historyLimit" label="历史记录保留上限" rules={[{ required: true }]}>
            <InputNumber min={10} max={10000} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="updateDatabase" valuePropName="checked" label="更新数据库连接 DSN">
            <Switch />
          </Form.Item>
          <Form.Item name="databaseDSN" label="数据库连接串 (DSN)">
            <Input.Password placeholder="file:/data/alerts.db?_pragma=busy_timeout(5000)" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};
