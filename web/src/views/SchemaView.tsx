import React, { useState, useEffect } from 'react';
import {
  Card,
  List,
  Button,
  Space,
  Input,
  Typography,
  Tag,
  Drawer,
  message,
  Tooltip,
  theme as antTheme
} from 'antd';
import {
  DatabaseOutlined,
  TableOutlined,
  DownloadOutlined,
  CodeOutlined,
  ReloadOutlined,
  PlayCircleOutlined,
  CopyOutlined
} from '@ant-design/icons';
import CodeMirror from '@uiw/react-codemirror';
import { sql as sqlLang } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';
import { api } from '../api';

const { Text } = Typography;

interface SchemaViewProps {
  activeCluster: string;
  themeMode?: 'light' | 'dark';
  onJumpToQuery: (sql: string) => void;
}

export const SchemaView: React.FC<SchemaViewProps> = ({ activeCluster, themeMode = 'dark', onJumpToQuery }) => {
  const { token } = antTheme.useToken();
  const [databases, setDatabases] = useState<string[]>([]);
  const [selectedDb, setSelectedDb] = useState<string>('');
  const [tables, setTables] = useState<any[]>([]);
  const [dbSearch, setDbSearch] = useState('');
  const [tableSearch, setTableSearch] = useState('');
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);
  const [ddlDrawer, setDdlDrawer] = useState<{ open: boolean; title: string; ddl: string }>({
    open: false,
    title: '',
    ddl: ''
  });

  const fetchDatabases = async () => {
    setLoadingDbs(true);
    try {
      const res = await api('/api/query', {
        method: 'POST',
        body: JSON.stringify({ sql: 'SELECT name FROM system.databases ORDER BY name' })
      });
      const dbs = (res.data || []).map((r: any) => String(r.name));
      setDatabases(dbs);
      if (dbs.length && !selectedDb) {
        setSelectedDb(dbs[0]);
      }
    } catch (err: any) {
      message.error(err.message);
    } finally {
      setLoadingDbs(false);
    }
  };

  useEffect(() => {
    fetchDatabases();
  }, [activeCluster]);

  useEffect(() => {
    if (!selectedDb) {
      setTables([]);
      return;
    }
    const fetchTables = async () => {
      setLoadingTables(true);
      try {
        const res = await api('/api/query', {
          method: 'POST',
          body: JSON.stringify({
            sql: `SELECT name, engine, total_rows, total_bytes FROM system.tables WHERE database='${selectedDb}' ORDER BY name`
          })
        });
        setTables(res.data || []);
      } catch (err: any) {
        message.error(err.message);
      } finally {
        setLoadingTables(false);
      }
    };
    fetchTables();
  }, [selectedDb, activeCluster]);

  const handleExportDatabaseSchema = async (db: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const endpoint = new URL('schema/export', new URL('api/', document.baseURI));
      endpoint.searchParams.set('database', db);
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error('导出建表 SQL 失败');
      const ddl = await res.text();
      const blob = new Blob([ddl], { type: 'text/sql;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${db}-schema.sql`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      message.success(`已导出 ${db} 的建表 SQL`);
    } catch (err: any) {
      message.error(err.message);
    }
  };

  const handleShowTableDDL = async (db: string, tbl: string) => {
    try {
      const res = await api('/api/query', {
        method: 'POST',
        body: JSON.stringify({ sql: `SHOW CREATE TABLE \`${db}\`.\`${tbl}\`` })
      });
      const ddl = res.data?.[0]?.statement || res.data?.[0]?.['CREATE TABLE'] || '未读取到建表语句';
      setDdlDrawer({
        open: true,
        title: `${db}.${tbl} 建表语句 (DDL)`,
        ddl
      });
    } catch (err: any) {
      message.error(err.message);
    }
  };

  const formatBytes = (bytes: any) => {
    const num = Number(bytes);
    if (!Number.isFinite(num) || num <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(num) / Math.log(1024));
    return `${(num / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  };

  const filteredDbs = databases.filter((db) => db.toLowerCase().includes(dbSearch.toLowerCase()));
  const filteredTables = tables.filter((tbl) => tbl.name?.toLowerCase().includes(tableSearch.toLowerCase()));

  return (
    <div style={{ padding: 12, display: 'flex', height: '100vh', gap: 12, boxSizing: 'border-box' }}>
      {/* Left: Database List */}
      <Card
        size="small"
        style={{ width: 260, display: 'flex', flexDirection: 'column', height: '100%' }}
        bodyStyle={{ padding: 0, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
        title={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Space size={6}>
              <DatabaseOutlined />
              <span style={{ fontSize: 13, fontWeight: 600 }}>数据库 ({databases.length})</span>
            </Space>
            <Button size="small" type="text" icon={<ReloadOutlined />} onClick={fetchDatabases} loading={loadingDbs} />
          </div>
        }
      >
        <div style={{ padding: '8px 10px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
          <Input
            size="small"
            placeholder="搜索数据库..."
            value={dbSearch}
            onChange={(e) => setDbSearch(e.target.value)}
            allowClear
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <List
            size="small"
            dataSource={filteredDbs}
            renderItem={(db) => (
              <List.Item
                onClick={() => setSelectedDb(db)}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  background: selectedDb === db ? token.colorFillAlter : 'transparent',
                  borderLeft: selectedDb === db ? `3px solid ${token.colorPrimary}` : '3px solid transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between'
                }}
              >
                <Space size={8} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <DatabaseOutlined style={{ color: selectedDb === db ? token.colorPrimary : token.colorTextTertiary }} />
                  <Text strong={selectedDb === db} style={{ fontSize: 13 }}>
                    {db}
                  </Text>
                </Space>
                <Tooltip title={`导出 ${db} 完整建表 SQL`}>
                  <Button
                    size="small"
                    type="text"
                    icon={<DownloadOutlined style={{ fontSize: 12 }} />}
                    onClick={(e) => handleExportDatabaseSchema(db, e)}
                  />
                </Tooltip>
              </List.Item>
            )}
          />
        </div>
      </Card>

      {/* Right: Tables in Selected Database */}
      <Card
        size="small"
        style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}
        bodyStyle={{ padding: 0, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
        title={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Space size={6}>
              <TableOutlined />
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                {selectedDb} / 数据表 ({filteredTables.length})
              </span>
            </Space>
            <Input
              size="small"
              placeholder="搜索数据表..."
              style={{ width: 180 }}
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              allowClear
            />
          </div>
        }
      >
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <List
            size="small"
            loading={loadingTables}
            dataSource={filteredTables}
            renderItem={(tbl) => (
              <List.Item
                style={{
                  padding: '10px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between'
                }}
              >
                <div>
                  <Space size={8}>
                    <TableOutlined style={{ color: token.colorPrimary }} />
                    <Text strong style={{ fontSize: 13 }}>
                      {tbl.name}
                    </Text>
                    <Tag>{tbl.engine || 'Table'}</Tag>
                  </Space>
                  <div style={{ fontSize: 11, color: token.colorTextTertiary, marginTop: 4, fontFamily: 'monospace' }}>
                    {Number(tbl.total_rows || 0).toLocaleString()} rows · 磁盘 {formatBytes(tbl.total_bytes)}
                  </div>
                </div>

                <Space size={6}>
                  <Tooltip title="查看建表语句 (DDL)">
                    <Button
                      size="small"
                      icon={<CodeOutlined />}
                      onClick={() => handleShowTableDDL(selectedDb, tbl.name)}
                    >
                      DDL
                    </Button>
                  </Tooltip>
                  <Tooltip title="在工作台快速查询">
                    <Button
                      size="small"
                      type="primary"
                      icon={<PlayCircleOutlined />}
                      onClick={() => {
                        onJumpToQuery(`SELECT * FROM \`${selectedDb}\`.\`${tbl.name}\` LIMIT 100;`);
                      }}
                    >
                      查询
                    </Button>
                  </Tooltip>
                </Space>
              </List.Item>
            )}
          />
        </div>
      </Card>

      {/* DDL Drawer with CodeMirror Syntax Highlighting */}
      <Drawer
        title={ddlDrawer.title}
        placement="right"
        width={660}
        bodyStyle={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%' }}
        onClose={() => setDdlDrawer({ open: false, title: '', ddl: '' })}
        open={ddlDrawer.open}
        extra={
          <Button
            size="small"
            icon={<CopyOutlined />}
            onClick={() => {
              navigator.clipboard.writeText(ddlDrawer.ddl);
              message.success('建表语句已复制');
            }}
          >
            复制 DDL
          </Button>
        }
      >
        <div
          style={{
            flex: 1,
            borderRadius: 8,
            overflow: 'hidden',
            border: `1px solid ${token.colorBorderSecondary}`,
            height: '100%'
          }}
        >
          <CodeMirror
            value={ddlDrawer.ddl}
            height="100%"
            theme={themeMode === 'dark' ? oneDark : 'light'}
            extensions={[sqlLang()]}
            editable={false}
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: false
            }}
            style={{ height: '100%', fontSize: 13 }}
          />
        </div>
      </Drawer>
    </div>
  );
};
