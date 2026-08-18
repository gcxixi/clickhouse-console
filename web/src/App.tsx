import React, { useState, useEffect } from 'react';
import { ConfigProvider, App as AntApp, theme as antTheme, Spin } from 'antd';
import { AppLayout } from './components/AppLayout';
import { LoginView } from './views/LoginView';
import { QueryView } from './views/QueryView';
import { SchemaView } from './views/SchemaView';
import { ProcessesView } from './views/ProcessesView';
import { MonitorView } from './views/MonitorView';
import { AlertingView } from './views/AlertingView';
import { ClustersView } from './views/ClustersView';
import { UsersView } from './views/UsersView';
import { AuditView } from './views/AuditView';
import { api, setCSRFToken } from './api';
import { User, Cluster } from './types';

export const App: React.FC = () => {
  const [themeMode, setThemeMode] = useState<'light' | 'dark'>(() => {
    return (localStorage.getItem('clickhouse_console_theme') as 'light' | 'dark') || 'dark';
  });
  const [loadingSession, setLoadingSession] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [activeCluster, setActiveCluster] = useState<string>('');
  const [activeView, setActiveView] = useState<string>('query');
  const [overrideSQL, setOverrideSQL] = useState<string>('');

  useEffect(() => {
    localStorage.setItem('clickhouse_console_theme', themeMode);
    document.body.className = themeMode === 'dark' ? 'theme-dark' : 'theme-light';
  }, [themeMode]);

  useEffect(() => {
    const handleUnauthorized = () => {
      setUser(null);
    };
    window.addEventListener('ch-unauthorized', handleUnauthorized);
    return () => {
      window.removeEventListener('ch-unauthorized', handleUnauthorized);
    };
  }, []);

  useEffect(() => {
    const initSession = async () => {
      try {
        const data = await api('/api/session');
        setCSRFToken(data.csrf);
        setUser(data.user);
        setClusters(data.clusters || []);
        setActiveCluster(data.active_cluster || data.clusters?.[0]?.alias || '');
      } catch {
        setUser(null);
      } finally {
        setLoadingSession(false);
      }
    };
    initSession();
  }, []);

  const handleLoginSuccess = (data: any) => {
    setUser(data.user);
    setClusters(data.clusters || []);
    setActiveCluster(data.active_cluster || data.clusters?.[0]?.alias || '');
    setActiveView('query');
  };

  const handleLogout = async () => {
    try {
      await api('/api/logout', { method: 'POST' });
    } finally {
      setUser(null);
    }
  };

  const handleSwitchCluster = async (alias: string) => {
    const data = await api('/api/cluster', {
      method: 'POST',
      body: JSON.stringify({ alias, confirm_alias: alias })
    });
    setClusters(data.clusters || clusters);
    setActiveCluster(data.active_cluster || alias);
  };

  const toggleTheme = () => {
    setThemeMode((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const handleJumpToQuery = (sql: string) => {
    setOverrideSQL(sql);
    setActiveView('query');
  };

  if (loadingSession) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: themeMode === 'dark' ? '#0b0f17' : '#f8fafc' }}>
        <Spin size="large" />
      </div>
    );
  }

  return (
    <ConfigProvider
      theme={{
        algorithm:
          themeMode === 'dark'
            ? [antTheme.darkAlgorithm, antTheme.compactAlgorithm]
            : [antTheme.defaultAlgorithm, antTheme.compactAlgorithm],
        token: {
          colorPrimary: '#f59e0b',
          borderRadius: 6,
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        }
      }}
    >
      <AntApp>
        {!user ? (
          <LoginView onLoginSuccess={handleLoginSuccess} />
        ) : (
          <AppLayout
            user={user}
            clusters={clusters}
            activeCluster={activeCluster}
            activeView={activeView}
            themeMode={themeMode}
            onToggleTheme={toggleTheme}
            onSelectView={setActiveView}
            onSwitchCluster={handleSwitchCluster}
            onLogout={handleLogout}
          >
            {activeView === 'query' && (
              <QueryView
                activeCluster={activeCluster}
                themeMode={themeMode}
                initialSQL={overrideSQL}
                onClearOverrideSQL={() => setOverrideSQL('')}
              />
            )}
            {activeView === 'schema' && (
              <SchemaView
                activeCluster={activeCluster}
                themeMode={themeMode}
                onJumpToQuery={handleJumpToQuery}
              />
            )}
            {activeView === 'processes' && (
              <ProcessesView activeCluster={activeCluster} currentUser={user} />
            )}
            {activeView === 'monitor' && <MonitorView activeCluster={activeCluster} />}
            {activeView === 'alerting' && <AlertingView clusters={clusters} />}
            {activeView === 'clusters' && <ClustersView onClustersUpdated={setClusters} />}
            {activeView === 'users' && <UsersView currentUser={user} />}
            {activeView === 'audit' && <AuditView />}
          </AppLayout>
        )}
      </AntApp>
    </ConfigProvider>
  );
};
