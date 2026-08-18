const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);
const apiRoot = new URL('api/', document.baseURI);
const defaultSQLPlaceholder = '输入 SQL，或选择库表生成查询建议';
const monitorCacheTTL = 60 * 60 * 1000;
let state = {
  csrf: '', user: null, clusters: [], managedClusters: [], activeCluster: '',
  activeView: 'query', pendingCluster: '', suggestedSQL: '', selectedDatabase: '',
  selectedTable: '', queryResult: null, resultColumnVisibility: [],
  monitorLoadingCluster: '', alertingConfig: null, alertRules: [], alertWebhooks: [],
  processes: [], processesInterval: null,
  sortColumn: null, sortAsc: true
};

const lucideIcons = {
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  'bell-ring': '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/><path d="M4 2C2.8 3.7 2 5.7 2 8M20 2c1.2 1.7 2 3.7 2 6"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-up': '<path d="m18 15-6-6-6 6"/>',
  'code-xml': '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  'file-down': '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="m9 15 3 3 3-3"/>',
  'download-cloud': '<path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M12 12v9"/><path d="m8 17 4 4 4-4"/>',
  'log-out': '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
  network: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  'refresh-cw': '<path d="M3 12a9 9 0 0 1 15.74-6.26L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.74 6.26L3 16"/><path d="M8 16H3v5"/>',
  'scroll-text': '<path d="M15 12h-5M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
  'server-cog': '<path d="m10.85 14.77-.38.93M13.15 14.77a3 3 0 1 0-2.3-5.54l-.38-.93M13.15 9.23l.38-.93M13.53 15.7l-.38-.93M14.77 10.85l.93-.38M14.77 13.15l.93.38M9.23 10.85l-.93-.38M9.23 13.15l-.93.38"/><path d="M4.5 10H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-.5M4.5 14H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2h-.5M6 18h.01M6 6h.01"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  'shield-check': '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z"/><path d="m9 12 2 2 4-4"/>',
  'square-terminal': '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2"/>',
  'table-2': '<path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/>',
  'trash-2': '<path d="M10 11v6M14 11v6M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3.13a4 4 0 0 1 0 7.74M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
  webhook: '<path d="M18 16.98h-5.99c-1.1 0-1.95-.94-2.48-1.9L7 10.5"/><path d="m6 14-3-1.5L4.5 10"/><path d="M6 8.3a4 4 0 1 1 7.5-2.3l-3 5.2"/><circle cx="6" cy="18" r="3"/><path d="M14.3 18a4 4 0 1 0 2.2-7.5L11 10.4"/>',
  cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  'sun-moon': '<path d="M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>'
};

function icon(name, size = 16) {
  return `<svg class="lucide-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${lucideIcons[name] || ''}</svg>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-lucide]').forEach(element => { element.innerHTML = icon(element.dataset.lucide, Number(element.dataset.iconSize) || 16); });
}

// Theme system
function getSavedTheme() { return localStorage.getItem('clickhouse_console_theme') || 'auto'; }
function applyTheme(theme) {
  document.body.classList.remove('theme-dark', 'theme-light');
  if (theme === 'dark') document.body.classList.add('theme-dark');
  else if (theme === 'light') document.body.classList.add('theme-light');
  localStorage.setItem('clickhouse_console_theme', theme);
  const toggle = $('#themeToggle');
  if (toggle) toggle.title = `切换主题 (当前: ${theme === 'dark' ? '深色' : theme === 'light' ? '浅色' : '跟随系统'})`;
}
function cycleTheme() {
  const current = getSavedTheme();
  const next = current === 'auto' ? 'dark' : current === 'dark' ? 'light' : 'auto';
  applyTheme(next);
  toast(`已切换为${next === 'dark' ? '深色' : next === 'light' ? '浅色' : '跟随系统'}主题`);
}
$('#themeToggle').onclick = cycleTheme;
applyTheme(getSavedTheme());

const sqlKeywords = new Set('ADD AFTER ALIAS ALL ALTER AND ANTI ANY ARRAY AS ASC ASOF ATTACH BETWEEN BY CASE CAST CHECK CLEAR CLUSTER CODEC COLLATE COLUMN COMMENT CONSTRAINT CREATE CROSS CUBE DATABASE DATABASES DEFAULT DELETE DESC DESCRIBE DETACH DICTIONARY DISTINCT DISTRIBUTED DROP ELSE END ENGINE EXISTS EXPLAIN FINAL FIRST FORMAT FROM FULL FUNCTION GLOBAL GRANT GROUP HAVING IF IN INDEX INNER INSERT INTERVAL INTO IS JOIN KEY KILL LAST LEFT LIKE LIMIT LIVE LOCAL MATERIALIZED MODIFY MOVE MUTATION NOT NULL NULLS ON OPTIMIZE OR ORDER OUTER PARTITION PREWHERE PRIMARY PROJECTION RENAME REPLACE REVOKE RIGHT SAMPLE SELECT SETTINGS SHOW SYNC SYSTEM TABLE TABLES TEMPORARY THEN TIES TO TOP TOTALS TRUNCATE TTL UNION UPDATE USE USING VALUES VIEW WHEN WHERE WINDOW WITH'.split(' '));
const sqlTypes = new Set('AGGREGATEFUNCTION ARRAY BOOL BOOLEAN DATE DATE32 DATETIME DATETIME64 DECIMAL ENUM ENUM8 ENUM16 FIXEDSTRING FLOAT32 FLOAT64 INT8 INT16 INT32 INT64 INT128 INT256 IPV4 IPV6 JSON LOWCARDINALITY MAP NESTED NOTHING NULLABLE OBJECT POINT POLYGON RING SIMPLEAGGREGATEFUNCTION STRING TUPLE UINT8 UINT16 UINT32 UINT64 UINT128 UINT256 UUID VARIANT'.split(' '));
const sqlTokenPattern = /(--[^\n]*|#![^\n]*|#(?=[ \t])[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\$([A-Za-z0-9_]*)\$[\s\S]*?\$\2\$|'(?:\\[\s\S]|'')*'|`(?:\\[\s\S]|``)*`|"(?:\\[\s\S]|"")*"|\b(?:0x[\da-f]+|0b[01]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/gim;

function highlightSQL(sql) {
  let output = '';
  let cursor = 0;
  sqlTokenPattern.lastIndex = 0;
  for (const match of sql.matchAll(sqlTokenPattern)) {
    output += esc(sql.slice(cursor, match.index));
    const token = match[0];
    const upper = token.toUpperCase();
    let tokenClass = '';
    if (token.startsWith('--') || token.startsWith('#') || token.startsWith('//') || token.startsWith('/*')) tokenClass = 'sql-comment';
    else if (token.startsWith("'") || token.startsWith('$')) tokenClass = 'sql-string';
    else if (token.startsWith('`') || token.startsWith('"')) tokenClass = 'sql-identifier';
    else if (/^(?:0x|0b|\d)/i.test(token)) tokenClass = 'sql-number';
    else if (sqlKeywords.has(upper)) tokenClass = 'sql-keyword';
    else if (sqlTypes.has(upper) || /^(?:U?Int(?:8|16|32|64|128|256)|Float(?:32|64)|Decimal\d*|DateTime64)$/i.test(token)) tokenClass = 'sql-type';
    else if (/^\s*\(/.test(sql.slice(match.index + token.length))) tokenClass = 'sql-function';
    output += tokenClass ? `<span class="${tokenClass}">${esc(token)}</span>` : esc(token);
    cursor = match.index + token.length;
  }
  return output + esc(sql.slice(cursor));
}

function syncSQLHighlight() {
  const editor = $('#sql');
  const highlight = $('#sqlHighlight');
  highlight.scrollTop = editor.scrollTop;
  highlight.scrollLeft = editor.scrollLeft;
}

function updateSQLHighlight() {
  const value = $('#sql').value;
  $('#sqlHighlight').innerHTML = highlightSQL(value) + (value.endsWith('\n') ? ' ' : '');
  syncSQLHighlight();
}

async function api(path, opts = {}) {
  opts.headers = {...(opts.headers || {})};
  if (opts.body) opts.headers['Content-Type'] = 'application/json';
  if (state.csrf && opts.method && opts.method !== 'GET') opts.headers['X-CSRF-Token'] = state.csrf;
  const endpoint = new URL(path.replace(/^\/?api\//, ''), apiRoot);
  const response = await fetch(endpoint, opts);
  let data = null;
  try { data = await response.json(); } catch {}
  if (response.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('登录已过期');
  }
  if (!response.ok) throw new Error(data?.error || `请求失败 (${response.status})`);
  return data;
}

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

function showApp(data) {
  state = {...state, ...data};
  state.clusters = data.clusters || state.clusters;
  state.activeCluster = data.active_cluster || state.activeCluster;
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#username').textContent = data.user.Username;
  $('#role').textContent = data.user.Role;
  $('#avatar').textContent = data.user.Username[0].toUpperCase();
  $$('.admin-only').forEach(element => element.classList.toggle('hidden', data.user.Role !== 'admin'));
  renderClusterSelector();
  checkHealth();
  loadEditorDatabases().catch(error => toast(error.message));
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('#loginError').textContent = '';
  const form = new FormData(event.target);
  try {
    showApp(await api('/api/login', {method: 'POST', body: JSON.stringify(Object.fromEntries(form))}));
  } catch (error) {
    $('#loginError').textContent = error.message;
  }
});

$('#logout').onclick = async () => {
  try { await api('/api/logout', {method: 'POST'}); }
  finally {
    state = {csrf: '', user: null, clusters: [], managedClusters: [], activeCluster: '', activeView: 'query', pendingCluster: '', suggestedSQL: '', selectedDatabase: '', selectedTable: '', queryResult: null, resultColumnVisibility: [], monitorLoadingCluster: '', alertingConfig: null, alertRules: [], alertWebhooks: [], processes: [], processesInterval: null};
    showLogin();
  }
};

function activateView(view) {
  state.activeView = view;
  $('main').classList.toggle('query-active', view === 'query');
  $$('nav button').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $$('.view').forEach(element => element.classList.add('hidden'));
  $(`#${view}View`).classList.remove('hidden');
  if (view === 'schema') loadDatabases();
  if (view === 'processes') loadProcesses();
  if (view === 'monitor') loadMonitor();
  if (view === 'alerting') loadAlerting();
  if (view === 'clusters') loadManagedClusters();
  if (view === 'users') loadUsers();
  if (view === 'audit') loadAudit();
}

$$('nav button').forEach(button => button.onclick = () => activateView(button.dataset.view));

async function checkHealth() {
  const cluster = state.activeCluster;
  const dot = $('#healthDot');
  const label = $('#currentClusterLabel');
  try {
    await api('/api/health');
    if (cluster !== state.activeCluster) return;
    if (dot) { dot.className = 'status-dot ok'; dot.title = `${cluster} · 已连接`; }
    if (label) label.textContent = cluster;
  } catch {
    if (cluster !== state.activeCluster) return;
    if (dot) { dot.className = 'status-dot bad'; dot.title = `${cluster} · 连接失败`; }
    if (label) label.textContent = cluster;
  }
}

function renderClusterSelector() {
  const select = $('#clusterSelect');
  select.replaceChildren(...state.clusters.map(cluster => new Option(cluster.alias, cluster.alias)));
  select.value = state.activeCluster;
  select.disabled = state.clusters.length < 2;
  const label = $('#currentClusterLabel');
  if (label) label.textContent = state.activeCluster || '选择集群';
}

$('#clusterSelect').addEventListener('change', event => {
  const target = event.target.value;
  event.target.value = state.activeCluster;
  if (!target || target === state.activeCluster) return;
  state.pendingCluster = target;
  $('#clusterFrom').textContent = state.activeCluster;
  $('#clusterTo').textContent = target;
  $('#clusterDialog').showModal();
});

$$('.close-cluster').forEach(button => button.onclick = () => {
  state.pendingCluster = '';
  $('#clusterDialog').close();
});

$('#clusterForm').onsubmit = async event => {
  event.preventDefault();
  const alias = state.pendingCluster;
  if (!alias) return;
  const submit = event.submitter;
  submit.disabled = true;
  submit.textContent = '切换中…';
  try {
    const data = await api('/api/cluster', {method: 'POST', body: JSON.stringify({alias, confirm_alias: alias})});
    state = {...state, ...data, clusters: data.clusters || state.clusters, activeCluster: data.active_cluster};
    state.pendingCluster = '';
    $('#clusterDialog').close();
    renderClusterSelector();
    clearSuggestedSQL();
    $('#sql').value = '';
    updateSQLHighlight();
    resetEditorTables();
    resetQueryResult();
    $('#databases').replaceChildren();
    $('#tablesTitle').innerHTML = `${icon('table-2')}<span>数据表</span>`;
    $('#tables').innerHTML = '<div class="empty">选择一个数据库</div>';
    checkHealth();
    loadEditorDatabases().catch(error => toast(error.message));
    if (state.activeView === 'schema') loadDatabases();
    if (state.activeView === 'processes') loadProcesses();
    if (state.activeView === 'monitor') loadMonitor();
    toast(`已切换到集群 ${alias}`);
  } catch (error) { toast(error.message); }
  finally {
    submit.disabled = false;
    submit.textContent = '确认切换';
  }
};

function setSelectOptions(select, label, values) {
  select.replaceChildren(new Option(label, ''), ...values.map(value => new Option(value, value)));
}

async function loadEditorDatabases(preferredDatabase = '', preferredTable = '') {
  const databaseSelect = $('#queryDatabase');
  const current = preferredDatabase || databaseSelect.value;
  databaseSelect.disabled = true;
  setSelectOptions(databaseSelect, '加载数据库…', []);
  const result = await api('/api/query', {method: 'POST', body: JSON.stringify({sql: 'SELECT name FROM system.databases ORDER BY name'})});
  const databases = result.data.map(row => String(row.name));
  setSelectOptions(databaseSelect, '选择数据库', databases);
  databaseSelect.disabled = false;
  if (current && databases.includes(current)) {
    databaseSelect.value = current;
    await loadEditorTables(current, preferredTable);
  } else {
    resetEditorTables();
  }
}

function resetEditorTables() {
  const tableSelect = $('#queryTable');
  setSelectOptions(tableSelect, '选择数据表', []);
  tableSelect.disabled = true;
  state.selectedDatabase = '';
  state.selectedTable = '';
}

async function loadEditorTables(database, preferredTable = '') {
  const tableSelect = $('#queryTable');
  state.selectedDatabase = database;
  state.selectedTable = '';
  tableSelect.disabled = true;
  setSelectOptions(tableSelect, '加载数据表…', []);
  if (!database) {
    resetEditorTables();
    return;
  }
  const result = await api('/api/query', {method: 'POST', body: JSON.stringify({sql: `SELECT name FROM system.tables WHERE database=${sqlLiteral(database)} ORDER BY name`})});
  const tables = result.data.map(row => String(row.name));
  setSelectOptions(tableSelect, '选择数据表', tables);
  tableSelect.disabled = false;
  if (preferredTable && tables.includes(preferredTable)) {
    tableSelect.value = preferredTable;
    await stageTableQuery(database, preferredTable);
  }
}

async function stageTableQuery(database, table) {
  const editor = $('#sql');
  state.selectedDatabase = database;
  state.selectedTable = table;
  state.suggestedSQL = '';
  editor.value = '';
  updateSQLHighlight();
  editor.placeholder = '正在读取数据表字段…';
  $('#suggestionHint').classList.add('hidden');
  resetQueryResult();
  editor.focus();
  editor.setSelectionRange(0, 0);
  try {
    const result = await api('/api/query', {method: 'POST', body: JSON.stringify({sql: `SELECT name FROM system.columns WHERE database=${sqlLiteral(database)} AND table=${sqlLiteral(table)} ORDER BY position`})});
    if (state.selectedDatabase !== database || state.selectedTable !== table) return;
    const columns = (result.data || []).map(row => String(row.name));
    if (!columns.length) throw new Error(`未读取到 ${database}.${table} 的字段`);
    state.suggestedSQL = `SELECT\n${columns.map(column => `    ${quoteIdentifier(column)}`).join(',\n')}\nFROM ${quoteIdentifier(database)}.${quoteIdentifier(table)}\nLIMIT 100`;
    editor.placeholder = state.suggestedSQL;
    $('#suggestionHint').classList.remove('hidden');
  } catch (error) {
    if (state.selectedDatabase !== database || state.selectedTable !== table) return;
    clearSuggestedSQL();
    throw error;
  }
}

function resetQueryResult() {
  state.queryResult = null;
  state.resultColumnVisibility = [];
  state.sortColumn = null;
  state.sortAsc = true;
  $('#queryStatus').className = 'status hidden';
  $('#queryStatus').textContent = '';
  $('#resultMeta').textContent = '等待执行';
  $('#resultColumns').className = 'result-column-controls hidden';
  $('#resultColumns').replaceChildren();
  $('#resultExportFormat').disabled = true;
  $('#exportResult').disabled = true;
  $('#result').className = 'empty';
  $('#result').textContent = '确认并运行 SQL 后，结果将显示在这里';
}

function clearSuggestedSQL() {
  state.suggestedSQL = '';
  $('#sql').placeholder = defaultSQLPlaceholder;
  $('#suggestionHint').classList.add('hidden');
}

function acceptSuggestedSQL() {
  if (!state.suggestedSQL || $('#sql').value) return false;
  const editor = $('#sql');
  const suggestion = state.suggestedSQL;
  clearSuggestedSQL();
  editor.value = suggestion;
  updateSQLHighlight();
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
  return true;
}

$('#queryDatabase').addEventListener('change', async event => {
  clearSuggestedSQL();
  try { await loadEditorTables(event.target.value); }
  catch (error) { toast(error.message); resetEditorTables(); }
});

$('#queryTable').addEventListener('change', async event => {
  if (!event.target.value) {
    state.selectedTable = '';
    clearSuggestedSQL();
    return;
  }
  try { await stageTableQuery($('#queryDatabase').value, event.target.value); }
  catch (error) { toast(error.message); }
});

$('#sql').addEventListener('input', event => {
  if (state.suggestedSQL && event.target.value) clearSuggestedSQL();
  updateSQLHighlight();
});

$('#sql').addEventListener('scroll', syncSQLHighlight);

$('#sql').addEventListener('keydown', event => {
  if (event.key === 'Tab' && state.suggestedSQL && !event.currentTarget.value) {
    event.preventDefault();
    acceptSuggestedSQL();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    runQuery();
  }
});

$('#run').onclick = runQuery;
$('#dryRun').onclick = dryRunQuery;
$('#format').onclick = () => {
  const editor = $('#sql');
  if (!editor.value.trim()) return;
  editor.value = editor.value.trim().replace(/\s+(FROM|WHERE|GROUP BY|ORDER BY|LIMIT|SETTINGS|FORMAT)\s+/gi, '\n$1 ');
  updateSQLHighlight();
};

async function dryRunQuery() {
  const sql = $('#sql').value.trim();
  if (!sql) return;
  $('#dryRun').disabled = true;
  $('#run').disabled = true;
  $('#dryRun').innerHTML = `${icon('shield-check', 13)}<span>检查中…</span>`;
  $('#queryStatus').className = 'status hidden';
  try {
    const result = await api('/api/query/dry-run', {method: 'POST', body: JSON.stringify({sql})});
    const semantic = (result.statements || []).filter(statement => statement.validation === 'semantic').length;
    const syntax = result.statement_count - semantic;
    const detail = [semantic ? `${semantic} 条语义分析` : '', syntax ? `${syntax} 条语法检查` : ''].filter(Boolean).join('，');
    $('#queryStatus').className = 'status ok';
    $('#queryStatus').textContent = `Dry Run 通过 · ${result.statement_count} 条语句 · ${detail} · ${result.elapsed_ms} ms`;
  } catch (error) {
    $('#queryStatus').className = 'status error';
    $('#queryStatus').textContent = error.message;
  } finally {
    $('#dryRun').disabled = false;
    $('#run').disabled = false;
    $('#dryRun').innerHTML = `${icon('shield-check', 13)}<span>Dry Run</span>`;
  }
}

async function runQuery() {
  const sql = $('#sql').value.trim();
  if (!sql) return;
  $('#run').disabled = true;
  $('#dryRun').disabled = true;
  $('#run').innerHTML = `${icon('play', 13)}<span>执行中…</span>`;
  $('#queryStatus').className = 'status hidden';
  try {
    const result = await api('/api/query', {method: 'POST', body: JSON.stringify({sql})});
    saveQueryHistory(sql, result.elapsed_ms, result.rows || 0);
    $('#queryStatus').className = 'status ok';
    $('#queryStatus').textContent = result.kind === 'batch' ? `${result.statement_count} 条语句执行成功 · ${result.elapsed_ms} ms` : `执行成功 · ${result.elapsed_ms} ms`;
    $('#resultMeta').textContent = result.kind === 'query' ? `${result.rows || 0} 行 · ${result.elapsed_ms} ms` : result.kind === 'batch' ? `${result.statement_count} 条全部成功${result.meta?.length ? ` · 最后一条返回 ${result.rows || 0} 行` : ''}` : `${result.kind.toUpperCase()} 执行成功`;
    renderResult(result);
  } catch (error) {
    $('#queryStatus').className = 'status error';
    $('#queryStatus').textContent = error.message;
  } finally {
    $('#run').disabled = false;
    $('#dryRun').disabled = false;
    $('#run').innerHTML = `${icon('play', 13)}<span>运行</span><kbd>⌘↵</kbd>`;
  }
}

function renderResult(result) {
  state.queryResult = result;
  state.sortColumn = null;
  state.sortAsc = true;
  if (!result.meta?.length) {
    state.resultColumnVisibility = [];
    $('#resultColumns').className = 'result-column-controls hidden';
    $('#resultColumns').replaceChildren();
    $('#resultExportFormat').disabled = true;
    $('#exportResult').disabled = true;
    $('#result').className = 'empty';
    $('#result').textContent = result.kind === 'batch' ? `${result.statement_count} 条语句已按顺序执行成功` : '命令执行成功';
    return;
  }
  $('#resultExportFormat').disabled = false;
  $('#exportResult').disabled = false;
  state.resultColumnVisibility = readResultColumnVisibility(result.meta);
  renderResultColumnControls(result.meta);
  renderResultTable();
}

function resultColumnPreferenceKey(meta) {
  const signature = meta.map(column => [String(column.name), String(column.type)]);
  return `clickhouse-console:${apiRoot.pathname}:result-columns:${JSON.stringify([state.activeCluster, signature])}`;
}

function readResultColumnVisibility(meta) {
  try {
    const saved = JSON.parse(localStorage.getItem(resultColumnPreferenceKey(meta)) || 'null');
    if (Array.isArray(saved) && saved.length === meta.length && saved.every(item => typeof item === 'boolean')) return saved;
  } catch {}
  return new Array(meta.length).fill(true);
}

function writeResultColumnVisibility(meta, visibility) {
  try { localStorage.setItem(resultColumnPreferenceKey(meta), JSON.stringify(visibility)); } catch {}
}

function renderResultColumnControls(meta) {
  const controls = $('#resultColumns');
  controls.className = 'result-column-controls';
  controls.innerHTML = `
    <span class="result-column-label">显示字段</span>
    <div class="result-column-options">
      ${meta.map((column, index) => `
        <label title="${esc(column.name)} (${esc(column.type)})">
          <input type="checkbox" data-column-index="${index}" ${state.resultColumnVisibility[index] ? 'checked' : ''}>
          <span>${esc(column.name)}</span>
        </label>`).join('')}
    </div>`;
  controls.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
    checkbox.onchange = () => {
      const index = Number(checkbox.dataset.columnIndex);
      state.resultColumnVisibility[index] = checkbox.checked;
      writeResultColumnVisibility(meta, state.resultColumnVisibility);
      renderResultTable();
    };
  });
}

function renderResultTable() {
  const result = state.queryResult;
  if (!result?.meta?.length) return;
  const visibleColumns = result.meta.map((column, index) => ({column, index})).filter(item => state.resultColumnVisibility[item.index]);
  if (!visibleColumns.length) {
    $('#result').className = 'empty result-no-columns';
    $('#result').textContent = '请至少选择一个字段以显示查询结果';
    return;
  }
  let rows = [...(result.data || [])];
  if (state.sortColumn) {
    const col = state.sortColumn;
    const asc = state.sortAsc;
    rows.sort((a, b) => {
      const va = a[col], vb = b[col];
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const na = Number(va), nb = Number(vb);
      if (!isNaN(na) && !isNaN(nb)) return asc ? na - nb : nb - na;
      return asc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });
  }
  $('#result').className = 'table-wrap';
  $('#result').innerHTML = `<table><thead><tr>${visibleColumns.map(({column}) => {
    const isSorted = state.sortColumn === column.name;
    const sortClass = isSorted ? (state.sortAsc ? 'sorted-asc' : 'sorted-desc') : '';
    const arrow = isSorted ? (state.sortAsc ? ' ▲' : ' ▼') : ' ⇅';
    return `<th class="sortable ${sortClass}" data-col="${esc(column.name)}" title="点击按 ${esc(column.name)} 排序">${esc(column.name)}<span class="sort-icon">${arrow}</span></th>`;
  }).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${visibleColumns.map(({column}) => `<td class="code result-cell copyable" data-val="${esc(value(row[column.name]))}">${esc(value(row[column.name]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  
  $$('#result th.sortable').forEach(th => {
    th.onclick = () => {
      const col = th.dataset.col;
      if (state.sortColumn === col) state.sortAsc = !state.sortAsc;
      else { state.sortColumn = col; state.sortAsc = true; }
      renderResultTable();
    };
  });
  $$('#result td.copyable').forEach(td => {
    td.onclick = () => copyText(td.dataset.val, '单元格内容已复制');
  });
  requestAnimationFrame(updateResultOverflowTooltips);
}

function updateResultOverflowTooltips() {
  $$('#result td.result-cell').forEach(cell => {
    if (cell.scrollWidth > cell.clientWidth) cell.title = cell.textContent;
    else cell.removeAttribute('title');
  });
}

function exportQueryResult() {
  const result = state.queryResult;
  const format = $('#resultExportFormat').value;
  const config = ResultExport.formats[format];
  if (!result?.meta?.length || !config) return;
  const content = ResultExport.serialize(result, format);
  const blob = new Blob([content], {type: config.mime});
  const objectURL = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.href = objectURL;
  link.download = `${ResultExport.safeName(state.activeCluster)}-query-${stamp}.${config.extension}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectURL);
  toast(`已导出 ${result.data?.length || 0} 行 ${format}`);
}

$('#exportResult').onclick = exportQueryResult;

// Stream Export Directly from ClickHouse Server
async function streamExportQueryResult() {
  const sql = $('#sql').value.trim();
  if (!sql) { toast('请先在编辑器输入要导出的 SQL 查询'); return; }
  const format = $('#resultExportFormat').value || 'CSVWithNames';
  const btn = $('#streamExportResult');
  btn.disabled = true;
  btn.innerHTML = `${icon('download-cloud', 13)}<span>导出中…</span>`;
  try {
    const endpoint = new URL('query/stream-export', apiRoot);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(state.csrf ? {'X-CSRF-Token': state.csrf} : {})
      },
      body: JSON.stringify({
        sql,
        format,
        filename: `${ResultExport.safeName(state.activeCluster)}-export`
      })
    });
    if (!response.ok) {
      let err = `导出失败 (${response.status})`;
      try { const errObj = await response.json(); err = errObj.error || err; } catch {}
      throw new Error(err);
    }
    const blob = await response.blob();
    const objectURL = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const cd = response.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : `export-${Date.now()}.${ResultExport.formats[format]?.extension || 'txt'}`;
    link.href = objectURL;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectURL);
    toast(`流式导出完成: ${filename}`);
  } catch (error) {
    toast(error.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${icon('download-cloud', 13)}<span>流式导出</span>`;
  }
}
$('#streamExportResult').onclick = streamExportQueryResult;

// Running Queries (Processes) View & Query Killer
async function loadProcesses() {
  try {
    const data = await api('/api/processes');
    state.processes = data.processes || [];
    renderProcesses();
  } catch (error) {
    toast(error.message);
  }
}

function renderProcesses() {
  const list = state.processes || [];
  $('#processesCount').textContent = `${list.length} 个正在运行的查询`;
  $('#processRows').innerHTML = list.length ? list.map(p => `<tr>
    <td class="code" title="${esc(p.query_id)}">${esc(p.query_id)}</td>
    <td>${esc(p.user)}</td>
    <td>${Number(p.elapsed).toFixed(1)}s</td>
    <td>${formatCount(p.read_rows)}</td>
    <td>${formatBytes(p.read_bytes)}</td>
    <td>${formatBytes(p.memory_usage)}</td>
    <td class="code" title="${esc(p.query)}">${esc(p.query)}</td>
    <td>${state.user?.Role !== 'viewer' ? `<button class="kill-btn" data-query-id="${esc(p.query_id)}">终止 (Kill)</button>` : ''}</td>
  </tr>`).join('') : '<tr><td colspan="8" class="empty">当前没有正在运行的查询</td></tr>';
  $$('.kill-btn').forEach(btn => btn.onclick = () => killQuery(btn.dataset.queryId, btn));
}

async function killQuery(queryId, btn) {
  if (!confirm(`确认终止运行中的查询 ${queryId} 吗？`)) return;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '终止中…';
  }
  try {
    await api('/api/processes/kill', {method: 'POST', body: JSON.stringify({query_id: queryId})});
    toast(`查询 ${queryId} 已终止`);
    setTimeout(loadProcesses, 300);
  } catch (error) {
    toast(error.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = '终止 (Kill)';
    }
  }
}

$('#refreshProcesses').onclick = loadProcesses;
$('#autoRefreshProcesses').onchange = event => {
  if (event.target.checked) {
    if (!state.processesInterval) {
      state.processesInterval = setInterval(() => {
        if (state.activeView === 'processes') loadProcesses();
      }, 3000);
    }
  } else {
    if (state.processesInterval) {
      clearInterval(state.processesInterval);
      state.processesInterval = null;
    }
  }
};

// Built-in Snippets and Query History
const builtInSnippets = [
  {
    title: '慢查询 Top 10（近 1 小时）',
    desc: '从 system.query_log 获取执行时间最长的完成查询',
    sql: `SELECT\n    query_id,\n    user,\n    query_duration_ms / 1000 AS duration_s,\n    read_rows,\n    formatReadableSize(read_bytes) AS read_size,\n    formatReadableSize(memory_usage) AS memory,\n    query\nFROM system.query_log\nWHERE type = 'QueryFinish' AND event_time >= now() - INTERVAL 1 HOUR\nORDER BY query_duration_ms DESC\nLIMIT 10;`
  },
  {
    title: '表磁盘大小与行数概览',
    desc: '统计每个表的数据行数、分区 Part 数量和磁盘空间占用',
    sql: `SELECT\n    database,\n    table,\n    formatReadableSize(sum(bytes_on_disk)) AS size_on_disk,\n    sum(rows) AS total_rows,\n    count() AS parts_count\nFROM system.parts\nWHERE active\nGROUP BY database, table\nORDER BY sum(bytes_on_disk) DESC\nLIMIT 20;`
  },
  {
    title: '后台合并状态 (Merges)',
    desc: '查看当前正在执行的后台 Part 合并任务进度与速度',
    sql: `SELECT\n    database,\n    table,\n    elapsed,\n    round(progress, 2) AS progress,\n    num_parts,\n    formatReadableSize(total_size_bytes_compressed) AS total_size,\n    formatReadableSize(bytes_read_uncompressed) AS read_bytes,\n    formatReadableSize(bytes_written_uncompressed) AS written_bytes\nFROM system.merges;`
  },
  {
    title: '副本同步队列与延迟 (Replicas)',
    desc: '监控副本表的同步队列大小与只读状态',
    sql: `SELECT\n    database,\n    table,\n    is_leader,\n    is_readonly,\n    queue_size,\n    inserts_in_queue,\n    merges_in_queue,\n    log_pointer,\n    total_replicas,\n    active_replicas\nFROM system.replicas;`
  },
  {
    title: '系统错误日志统计 (System Errors)',
    desc: '近 24 小时内发生的 ClickHouse 错误类型与发生次数',
    sql: `SELECT\n    name,\n    value AS error_count,\n    last_error_time,\n    last_error_message\nFROM system.errors\nWHERE value > 0\nORDER BY last_error_time DESC\nLIMIT 20;`
  }
];

function getCustomSnippets() {
  try { return JSON.parse(localStorage.getItem('clickhouse_console_custom_snippets') || '[]'); } catch { return []; }
}
function saveCustomSnippets(list) {
  try { localStorage.setItem('clickhouse_console_custom_snippets', JSON.stringify(list)); } catch {}
}
function getQueryHistory() {
  try { return JSON.parse(localStorage.getItem('clickhouse_console_history') || '[]'); } catch { return []; }
}
function saveQueryHistory(sql, elapsed_ms, rows) {
  if (!sql) return;
  const list = getQueryHistory();
  list.unshift({sql, cluster: state.activeCluster, elapsed_ms, rows, at: Date.now()});
  if (list.length > 50) list.length = 50;
  try { localStorage.setItem('clickhouse_console_history', JSON.stringify(list)); } catch {}
}

function renderSnippetsModal() {
  const custom = getCustomSnippets();
  const allSnippets = [...custom.map((s, i) => ({...s, isCustom: true, customIndex: i})), ...builtInSnippets];
  $('#snippetsList').innerHTML = allSnippets.map(item => `
    <div class="snippet-card">
      <div class="snippet-card-head">
        <strong>${esc(item.title)}</strong>
        <div class="snippet-card-actions">
          <button class="ghost load-snippet" data-sql="${esc(item.sql)}">${icon('play', 12)}<span>载入</span></button>
          <button class="ghost copy-snippet" data-sql="${esc(item.sql)}">${icon('copy', 12)}<span>复制</span></button>
          ${item.isCustom ? `<button class="ghost delete-snippet" data-index="${item.customIndex}">${icon('trash-2', 12)}<span>删除</span></button>` : ''}
        </div>
      </div>
      <small>${esc(item.desc || '')}</small>
      <pre>${esc(item.sql)}</pre>
    </div>
  `).join('');

  $$('.load-snippet').forEach(btn => btn.onclick = () => {
    $('#sql').value = btn.dataset.sql;
    updateSQLHighlight();
    $('#snippetsDialog').close();
    toast('已载入 SQL 到工作台');
  });
  $$('.copy-snippet').forEach(btn => btn.onclick = () => copyText(btn.dataset.sql, 'SQL 片段已复制'));
  $$('.delete-snippet').forEach(btn => btn.onclick = () => {
    const idx = Number(btn.dataset.index);
    const list = getCustomSnippets();
    list.splice(idx, 1);
    saveCustomSnippets(list);
    renderSnippetsModal();
    toast('已删除自定义片段');
  });

  const history = getQueryHistory();
  $('#historyList').innerHTML = history.length ? history.map(item => `
    <div class="snippet-card">
      <div class="snippet-card-head">
        <strong>${esc(item.cluster)} · ${date(item.at)}</strong>
        <div class="snippet-card-actions">
          <small>${item.elapsed_ms || 0}ms · ${item.rows || 0}行</small>
          <button class="ghost load-snippet" data-sql="${esc(item.sql)}">${icon('play', 12)}<span>载入</span></button>
          <button class="ghost copy-snippet" data-sql="${esc(item.sql)}">${icon('copy', 12)}<span>复制</span></button>
        </div>
      </div>
      <pre>${esc(item.sql)}</pre>
    </div>
  `).join('') : '<div class="empty">暂无查询历史记录</div>';

  $$('#historyList .load-snippet').forEach(btn => btn.onclick = () => {
    $('#sql').value = btn.dataset.sql;
    updateSQLHighlight();
    $('#snippetsDialog').close();
    toast('已载入历史 SQL 到工作台');
  });
  $$('#historyList .copy-snippet').forEach(btn => btn.onclick = () => copyText(btn.dataset.sql, '历史 SQL 已复制'));
}

$('#openSnippets').onclick = () => {
  renderSnippetsModal();
  $('#snippetsDialog').showModal();
};
$$('.close-snippets').forEach(btn => btn.onclick = () => $('#snippetsDialog').close());

$$('[data-snippet-tab]').forEach(button => button.onclick = () => {
  $$('[data-snippet-tab]').forEach(item => item.classList.toggle('active', item === button));
  $$('[data-snippet-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.snippetPanel !== button.dataset.snippetTab));
});

$('#saveCurrentAsSnippet').onclick = () => {
  const sql = $('#sql').value.trim();
  if (!sql) { toast('编辑器中没有 SQL 语句'); return; }
  const title = prompt('请输入片段名称：');
  if (!title) return;
  const desc = prompt('请输入片段说明（可选）：') || '';
  const custom = getCustomSnippets();
  custom.unshift({title, desc, sql});
  saveCustomSnippets(custom);
  renderSnippetsModal();
  toast('已保存为自定义片段');
};

$('#clearQueryHistory').onclick = () => {
  if (!confirm('确认清空所有查询历史记录？')) return;
  localStorage.removeItem('clickhouse_console_history');
  renderSnippetsModal();
  toast('查询历史已清空');
};

async function loadDatabases() {
  try {
    const result = await api('/api/query', {method: 'POST', body: JSON.stringify({sql: 'SELECT name FROM system.databases ORDER BY name'})});
    $('#databases').innerHTML = result.data.map(row => `<div class="database-entry"><button class="database-select" data-db="${esc(row.name)}">${icon('database')}<span>${esc(row.name)}</span></button><button class="database-export" data-db="${esc(row.name)}" title="导出完整建表 SQL" aria-label="导出 ${esc(row.name)} 建表 SQL">${icon('file-down')}</button></div>`).join('');
    $$('#databases .database-select').forEach(button => button.onclick = () => loadTables(button.dataset.db, button));
    $$('#databases .database-export').forEach(button => button.onclick = () => exportDatabaseSchema(button.dataset.db, button));
  } catch (error) { toast(error.message); }
}

async function loadTables(database, databaseButton) {
  $$('#databases .database-select').forEach(button => button.classList.remove('active'));
  databaseButton.classList.add('active');
  $('#tablesTitle').innerHTML = `${icon('table-2')}<span>${esc(database)} / 数据表</span>`;
  try {
    const result = await api('/api/query', {method: 'POST', body: JSON.stringify({sql: `SELECT name, engine, total_rows, total_bytes FROM system.tables WHERE database=${sqlLiteral(database)} ORDER BY name`})});
    $('#tables').innerHTML = result.data.length ? result.data.map(row => `
      <div class="table-entry" data-db="${esc(database)}" data-table="${esc(row.name)}">
        <div class="table-summary">
          <div class="table-identity"><strong>${icon('table-2')}<span>${esc(row.name)}</span></strong><small>${esc(row.engine)} · ${esc(value(row.total_rows))} rows · 磁盘 ${esc(formatBytes(row.total_bytes))}</small></div>
          <div class="table-actions">
            <button class="table-action ddl-action" title="查看建表语句" aria-label="查看 ${esc(row.name)} 建表语句" aria-expanded="false">${icon('code-xml')}</button>
            <button class="table-action query-action" title="在工作台查询" aria-label="查询 ${esc(row.name)}">${icon('play')}</button>
          </div>
        </div>
      </div>`).join('') : '<div class="empty">该数据库下没有数据表</div>';
    $$('#tables .table-entry').forEach(entry => {
      entry.querySelector('.ddl-action').onclick = () => toggleTableDDL(entry);
      entry.querySelector('.query-action').onclick = () => jumpToQuery(entry.dataset.db, entry.dataset.table);
    });
  } catch (error) { toast(error.message); }
}

async function exportDatabaseSchema(database, button) {
  button.disabled = true;
  button.classList.add('loading');
  try {
    const endpoint = new URL('schema/export', apiRoot);
    endpoint.searchParams.set('database', database);
    const response = await fetch(endpoint, {headers: state.csrf ? {'X-CSRF-Token': state.csrf} : {}});
    if (!response.ok) {
      let message = `导出失败 (${response.status})`;
      try { message = (await response.json())?.error || message; } catch {}
      throw new Error(message);
    }
    const sql = await response.text();
    const blob = new Blob([sql], {type: 'text/sql; charset=utf-8'});
    const objectURL = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const filename = response.headers.get('X-Export-Filename') || `${database}-schema.sql`;
    link.href = objectURL;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectURL);
    toast(`已导出 ${database} 的建表 SQL`);
  } catch (error) { toast(error.message); }
  finally {
    button.disabled = false;
    button.classList.remove('loading');
  }
}

async function toggleTableDDL(entry) {
  const database = entry.dataset.db;
  const table = entry.dataset.table;
  const button = entry.querySelector('.ddl-action');
  const existing = entry.querySelector('.ddl-panel');
  if (existing) {
    existing.remove();
    button.classList.remove('active');
    button.setAttribute('aria-expanded', 'false');
    return;
  }
  button.disabled = true;
  try {
    const result = await api('/api/query', {method: 'POST', body: JSON.stringify({sql: `SHOW CREATE TABLE ${quoteIdentifier(database)}.${quoteIdentifier(table)}`})});
    const ddl = String(result.data?.[0]?.statement || result.data?.[0]?.['CREATE TABLE'] || '未读取到建表语句');
    const panel = document.createElement('div');
    panel.className = 'ddl-panel';
    panel.innerHTML = `<div class="ddl-heading"><span>建表语句</span><button type="button" class="copy-ddl" title="复制建表语句" aria-label="复制建表语句">${icon('copy', 13)}</button></div><pre>${esc(ddl)}</pre>`;
    panel.querySelector('.copy-ddl').onclick = () => copyText(ddl, '建表语句已复制');
    entry.appendChild(panel);
    button.classList.add('active');
    button.setAttribute('aria-expanded', 'true');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}

async function jumpToQuery(database, table) {
  activateView('query');
  try {
    await loadEditorDatabases(database, table);
    if ($('#queryDatabase').value !== database) $('#queryDatabase').value = database;
    if ($('#queryTable').value !== table) $('#queryTable').value = table;
    await stageTableQuery(database, table);
    acceptSuggestedSQL();
  } catch (error) { toast(error.message); }
}

async function loadManagedClusters() {
  try {
    const items = await api('/api/clusters');
    state.managedClusters = items;
    $('#clusterRows').innerHTML = items.length ? items.map(cluster => `<tr>
      <td><strong>${esc(cluster.alias)}</strong></td>
      <td><span class="tag">${cluster.source === 'managed' ? '平台管理' : '环境变量'}</span></td>
      <td>${esc(cluster.url)}</td><td>${esc(cluster.database || 'default')}</td>
      <td><span class="tag ${cluster.credentials_present ? 'ok' : ''}">${cluster.credentials_present ? '已配置' : '无认证'}</span></td>
      <td><div class="row-actions">${cluster.source === 'managed' ? `<button class="ghost edit-cluster" data-id="${cluster.id}">${icon('pencil', 13)}<span>编辑</span></button><button class="ghost delete-cluster" data-id="${cluster.id}">${icon('trash-2', 13)}<span>删除</span></button>` : '<span class="muted">只读</span>'}</div></td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">暂无集群配置</td></tr>';
    $$('.edit-cluster').forEach(button => button.onclick = () => openClusterEditor(Number(button.dataset.id)));
    $$('.delete-cluster').forEach(button => button.onclick = () => deleteCluster(Number(button.dataset.id)));
  } catch (error) { toast(error.message); }
}

$('#refreshSchema').onclick = loadDatabases;
$('#newCluster').onclick = () => {
  const form = $('#clusterManageForm');
  form.reset(); form.elements.id.value = ''; form.elements.database.value = 'default';
  $('#clusterManageTitle').textContent = '添加集群';
  $('#updateCredentialsLabel').classList.add('hidden');
  $('#updateCredentials').checked = false;
  configureCredentialFields(true);
  $('#clusterManageError').textContent = '';
  $('#clusterManageDialog').showModal();
};

function openClusterEditor(id) {
  const cluster = state.managedClusters.find(item => item.id === id);
  if (!cluster) return;
  const form = $('#clusterManageForm');
  form.reset();
  form.elements.id.value = cluster.id;
  form.elements.alias.value = cluster.alias;
  form.elements.url.value = cluster.url;
  form.elements.database.value = cluster.database || 'default';
  $('#clusterManageTitle').textContent = `编辑集群 ${cluster.alias}`;
  $('#updateCredentialsLabel').classList.remove('hidden');
  $('#updateCredentials').checked = false;
  configureCredentialFields(false);
  $('#clusterManageError').textContent = '';
  $('#clusterManageDialog').showModal();
}

function configureCredentialFields(enabled) {
  const container = $('#credentialFields');
  container.classList.toggle('hidden', !enabled);
  container.querySelectorAll('input').forEach(input => { input.disabled = !enabled; if (!enabled) input.value = ''; });
}

$('#updateCredentials').onchange = event => configureCredentialFields(event.target.checked);
$$('.close-cluster-manage').forEach(button => button.onclick = () => $('#clusterManageDialog').close());

$('#clusterManageForm').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const userVal = (form.elements.clusterUser?.value || '').trim();
  const passVal = form.elements.clusterPassword?.value || '';
  const hasCredentials = Boolean(userVal || passVal);
  const updateCredentials = !id ? hasCredentials : $('#updateCredentials').checked;
  const submit = $('#saveCluster');
  submit.disabled = true;
  $('#clusterManageError').textContent = '';
  try {
    const credentials = (updateCredentials && hasCredentials)
      ? await encryptPayload({user: userVal, password: passVal})
      : {key: '', nonce: '', ciphertext: ''};
    const payload = {
      alias: form.elements.alias.value,
      url: form.elements.url.value,
      database: form.elements.database.value || 'default',
      update_credentials: updateCredentials,
      credentials
    };
    const response = await api(id ? `/api/clusters/${id}` : '/api/clusters', {method: id ? 'PUT' : 'POST', body: JSON.stringify(payload)});
    state.clusters = response.clusters || state.clusters;
    renderClusterSelector();
    if (form.elements.clusterPassword) form.elements.clusterPassword.value = '';
    $('#clusterManageDialog').close();
    await loadManagedClusters();
    toast(id ? '集群已更新' : '集群已添加');
  } catch (error) { $('#clusterManageError').textContent = error.message; }
  finally { submit.disabled = false; }
};

async function deleteCluster(id) {
  const cluster = state.managedClusters.find(item => item.id === id);
  if (!cluster || !confirm(`确认删除集群 ${cluster.alias}？`)) return;
  try {
    const response = await api(`/api/clusters/${id}`, {method: 'DELETE'});
    state.clusters = response.clusters || state.clusters;
    renderClusterSelector();
    await loadManagedClusters();
    toast('集群已删除');
  } catch (error) { toast(error.message); }
}

async function encryptPayload(payload) {
  const keyResponse = await api('/api/clusters/transport-key');
  const serverKey = await importServerPublicKey(keyResponse);
  const aesKey = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const rawKey = await crypto.subtle.importKey('raw', aesKey, {name: 'AES-GCM'}, false, ['encrypt']);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertextBuffer = await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce}, rawKey, plaintext);
  const wrappedKey = await crypto.subtle.encrypt({name: 'RSA-OAEP'}, serverKey, aesKey);
  return {key: bytesToBase64(new Uint8Array(wrappedKey)), nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(new Uint8Array(ciphertextBuffer))};
}

async function importServerPublicKey(keyData) {
  if (keyData && typeof keyData === 'object' && keyData.kty === 'RSA') {
    return crypto.subtle.importKey('jwk', keyData, {name: 'RSA-OAEP', hash: 'SHA-256'}, false, ['encrypt']);
  }
  const pem = typeof keyData === 'string' ? keyData : (keyData?.key || '');
  const clean = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\r|\n/g, '');
  const binary = Uint8Array.from(atob(clean), char => char.charCodeAt(0));
  return crypto.subtle.importKey('spki', binary.buffer, {name: 'RSA-OAEP', hash: 'SHA-256'}, false, ['encrypt']);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// Alerting System
async function loadAlerting() {
  try {
    const [config, rules, webhooks, events, deliveries] = await Promise.all([
      api('/api/alerting/config'),
      api('/api/alerting/rules').catch(() => []),
      api('/api/alerting/webhooks').catch(() => []),
      api('/api/alerting/events?limit=100').catch(() => []),
      api('/api/alerting/deliveries?limit=100').catch(() => [])
    ]);
    state.alertingConfig = config;
    $('#alertingStatus').className = `tag ${config.enabled ? 'ok' : ''}`;
    $('#alertingStatus').textContent = config.enabled ? '运行中' : config.configured ? '已暂停' : '未配置';
    $('#alertingSource').textContent = config.configured ? `${config.driver.toUpperCase()} · 保留 ${config.history_limit} 条` : '尚未配置报警数据库';
    state.alertRules = rules || [];
    state.alertWebhooks = webhooks || [];
    renderAlertRules(); renderAlertWebhooks(); renderAlertEvents(events || []); renderAlertDeliveries(deliveries || []);
  } catch (error) { toast(error.message); }
}

function renderAlertRules() {
  $('#alertRuleRows').innerHTML = state.alertRules.length ? state.alertRules.map(rule => `<tr>
    <td><strong>#${rule.id}</strong></td><td><strong>${esc(rule.name)}</strong><div class="code table-subline" title="${esc(rule.sql)}">${esc(rule.sql)}</div></td><td><span class="tag">${esc(rule.cluster)}</span></td>
    <td>${formatSecondsCompact(rule.interval_seconds)} / ${rule.repeat_interval_seconds ? `${formatSecondsCompact(rule.repeat_interval_seconds)}重复` : '单次'}</td><td><span class="tag ${rule.state === 'firing' ? 'error' : rule.state === 'pending' ? 'pending' : 'ok'}">${rule.enabled ? esc(rule.state) : 'disabled'}</span>${rule.last_error ? `<div class="error table-subline" title="${esc(rule.last_error)}">${esc(rule.last_error)}</div>` : ''}</td>
    <td class="code" title="${esc(rule.last_value || '')}">${esc(rule.last_value || '—')}<div class="muted table-subline">${rule.last_evaluated_at ? date(rule.last_evaluated_at) : '尚未执行'}</div></td>
    <td><div class="row-actions"><button class="ghost edit-alert-rule" data-id="${rule.id}">${icon('pencil', 13)}<span>编辑</span></button><button class="ghost delete-alert-rule" data-id="${rule.id}">${icon('trash-2', 13)}<span>删除</span></button></div></td></tr>`).join('') : '<tr><td colspan="7" class="empty">暂无报警规则</td></tr>';
  $$('.edit-alert-rule').forEach(button => button.onclick = () => openAlertRuleEditor(Number(button.dataset.id)));
  $$('.delete-alert-rule').forEach(button => button.onclick = () => deleteAlertRule(Number(button.dataset.id)));
}

const channelNames = {generic: '通用', wecom: '企业微信', feishu: '飞书', dingtalk: '钉钉', slack: 'Slack'};

function renderAlertWebhooks() {
  $('#alertWebhookRows').innerHTML = state.alertWebhooks.length ? state.alertWebhooks.map(webhook => `<tr>
    <td><strong>#${webhook.id}</strong></td>
    <td><strong>${esc(webhook.name)}</strong></td>
    <td><span class="tag">${esc(channelNames[webhook.channel_type] || webhook.channel_type || '通用')}</span></td>
    <td class="code" title="${esc(webhook.url_hint)}">${esc(webhook.url_hint)}</td>
    <td><span class="tag ${webhook.auth_configured ? 'ok' : ''}">${webhook.auth_configured ? '已配置' : '无'}</span></td>
    <td>${date(webhook.updated_at)}</td>
    <td><div class="row-actions"><button class="ghost test-alert-webhook" data-id="${webhook.id}">${icon('send', 13)}<span>测试</span></button><button class="ghost edit-alert-webhook" data-id="${webhook.id}">${icon('pencil', 13)}<span>编辑</span></button><button class="ghost delete-alert-webhook" data-id="${webhook.id}">${icon('trash-2', 13)}<span>删除</span></button></div></td></tr>`).join('') : '<tr><td colspan="7" class="empty">暂无 Webhook</td></tr>';
  $$('.test-alert-webhook').forEach(button => button.onclick = () => testAlertWebhook(Number(button.dataset.id)));
  $$('.edit-alert-webhook').forEach(button => button.onclick = () => openAlertWebhookEditor(Number(button.dataset.id)));
  $$('.delete-alert-webhook').forEach(button => button.onclick = () => deleteAlertWebhook(Number(button.dataset.id)));
}

async function testAlertWebhook(id) {
  try {
    const res = await api(`/api/alerting/webhooks/${id}/test`, {method: 'POST'});
    if (res.error) toast(`测试响应异常: ${res.error}`);
    else toast(`测试消息发送成功 (HTTP ${res.http_status})`);
    await loadAlerting();
  } catch (error) { toast(`测试失败: ${error.message}`); }
}

function renderAlertEvents(items) {
  $('#alertEventRows').innerHTML = items.length ? items.map(item => `<tr><td>${date(item.created_at)}</td><td><strong>#${item.rule_id}</strong> ${esc(item.rule_name)}</td><td><span class="tag">${esc(item.cluster)}</span></td><td><span class="tag ${item.status === 'firing' ? 'error' : 'ok'}">${esc(item.status)}</span></td><td class="code">${esc(item.value || '—')}</td><td>${date(item.started_at)}${item.ended_at ? `<div class="muted table-subline">恢复 ${date(item.ended_at)}</div>` : ''}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">暂无触发记录</td></tr>';
}

function renderAlertDeliveries(items) {
  $('#alertDeliveryRows').innerHTML = items.length ? items.map(item => `<tr><td>${date(item.created_at)}</td><td><strong>#${item.rule_id}</strong> ${esc(item.rule_name)}</td><td>${esc(item.webhook_name)}</td><td><span class="tag ${item.status === 'sent' ? 'ok' : 'error'}">${esc(item.status)}</span></td><td>${item.http_status || '—'}</td><td class="code" title="${esc(item.error || item.response_body || '')}">${esc(item.error || item.response_body || '—')}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">暂无发送记录</td></tr>';
}

$$('[data-alert-tab]').forEach(button => button.onclick = () => {
  $$('[data-alert-tab]').forEach(item => item.classList.toggle('active', item === button));
  $$('[data-alert-panel]').forEach(panel => panel.classList.toggle('hidden', panel.dataset.alertPanel !== button.dataset.alertTab));
});

$('#refreshAlerting').onclick = loadAlerting;
$('#configureAlerting').onclick = () => {
  const config = state.alertingConfig || {};
  const form = $('#alertConfigForm'); form.reset();
  form.elements.enabled.checked = Boolean(config.enabled);
  form.elements.driver.value = config.driver || 'sqlite';
  form.elements.historyLimit.value = config.history_limit || 300;
  $('#updateAlertDatabaseLabel').classList.toggle('hidden', !config.configured);
  $('#updateAlertDatabase').checked = !config.configured;
  configureAlertDatabaseField(!config.configured);
  $('#alertConfigError').textContent = '';
  updateAlertConfigHelp();
  $('#alertConfigDialog').showModal();
};

function configureAlertDatabaseField(enabled) {
  $('#alertDatabaseField').classList.toggle('hidden', !enabled);
  $('#alertConfigForm').elements.databaseDSN.required = enabled;
  if (!enabled) $('#alertConfigForm').elements.databaseDSN.value = '';
}
function updateAlertConfigHelp() {
  const driver = $('#alertConfigForm').elements.driver.value;
  $('#alertConfigHelp').textContent = driver === 'sqlite' ? 'SQLite 示例：file:/data/alerts.db?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)' : driver === 'postgres' ? 'PostgreSQL 示例：postgres://user:password@db:5432/alerts?sslmode=require' : 'MySQL 示例：user:password@tcp(db:3306)/alerts?tls=true&timeout=5s';
}
$('#updateAlertDatabase').onchange = event => configureAlertDatabaseField(event.target.checked);
$('#alertConfigForm').elements.driver.onchange = () => { updateAlertConfigHelp(); if (state.alertingConfig?.driver && state.alertingConfig.driver !== $('#alertConfigForm').elements.driver.value) { $('#updateAlertDatabase').checked = true; configureAlertDatabaseField(true); } };
$$('.close-alert-config').forEach(button => button.onclick = () => $('#alertConfigDialog').close());
$('#alertConfigForm').onsubmit = async event => {
  event.preventDefault(); const form = event.currentTarget; const updateDatabase = $('#updateAlertDatabase').checked; const submit = $('#saveAlertConfig'); submit.disabled = true; $('#alertConfigError').textContent = '';
  try {
    const database = updateDatabase ? await encryptPayload({secret: form.elements.databaseDSN.value}) : {key:'',nonce:'',ciphertext:''};
    await api('/api/alerting/config', {method:'PUT', body:JSON.stringify({enabled:form.elements.enabled.checked,driver:form.elements.driver.value,history_limit:Number(form.elements.historyLimit.value),update_database:updateDatabase,database})});
    form.elements.databaseDSN.value = ''; $('#alertConfigDialog').close(); await loadAlerting(); toast('报警存储配置已更新');
  } catch (error) { $('#alertConfigError').textContent = error.message; }
  finally { submit.disabled = false; }
};

function configureAlertTargetFields(enabled) {
  $('#alertTargetFields').classList.toggle('hidden', !enabled);
  $('#alertWebhookForm').elements.url.required = enabled;
  if (!enabled) { $('#alertWebhookForm').elements.url.value = ''; $('#alertWebhookForm').elements.authorization.value = ''; }
}
$('#newAlertWebhook').onclick = () => { const form=$('#alertWebhookForm');form.reset();form.elements.id.value='';form.elements.channelType.value='generic';$('#alertWebhookTitle').textContent='新建 Webhook';$('#updateAlertTargetLabel').classList.add('hidden');configureAlertTargetFields(true);$('#alertWebhookError').textContent='';$('#alertWebhookDialog').showModal(); };
function openAlertWebhookEditor(id) { const item=state.alertWebhooks.find(value=>value.id===id);if(!item)return;const form=$('#alertWebhookForm');form.reset();form.elements.id.value=item.id;form.elements.name.value=item.name;form.elements.channelType.value=item.channel_type||'generic';$('#alertWebhookTitle').textContent=`编辑 #${item.id}`;$('#updateAlertTargetLabel').classList.remove('hidden');$('#updateAlertTarget').checked=false;configureAlertTargetFields(false);$('#alertWebhookError').textContent='';$('#alertWebhookDialog').showModal(); }
$('#updateAlertTarget').onchange = event => configureAlertTargetFields(event.target.checked);
$$('.close-alert-webhook').forEach(button => button.onclick = () => $('#alertWebhookDialog').close());
$('#alertWebhookForm').onsubmit = async event => {
  event.preventDefault();const form=event.currentTarget;const id=form.elements.id.value;const updateTarget=!id||$('#updateAlertTarget').checked;const submit=$('#saveAlertWebhook');submit.disabled=true;$('#alertWebhookError').textContent='';
  try {
    const target=updateTarget?await encryptPayload({url:form.elements.url.value,authorization:form.elements.authorization.value}):{key:'',nonce:'',ciphertext:''};
    await api(id?`/api/alerting/webhooks/${id}`:'/api/alerting/webhooks',{method:id?'PUT':'POST',body:JSON.stringify({name:form.elements.name.value,channel_type:form.elements.channelType.value,update_target:updateTarget,target})});
    form.elements.authorization.value='';form.elements.url.value='';$('#alertWebhookDialog').close();await loadAlerting();toast(id?'Webhook 已更新':'Webhook 已创建');
  } catch(error){$('#alertWebhookError').textContent=error.message}finally{submit.disabled=false}
};
async function deleteAlertWebhook(id){const item=state.alertWebhooks.find(value=>value.id===id);if(!item||!confirm(`确认删除 Webhook #${id} ${item.name}？`))return;try{await api(`/api/alerting/webhooks/${id}`,{method:'DELETE'});await loadAlerting();toast('Webhook 已删除')}catch(error){toast(error.message)}}

function populateAlertRuleOptions(form) { form.elements.cluster.replaceChildren(...state.clusters.map(item=>new Option(item.alias,item.alias)));form.elements.webhookId.replaceChildren(new Option('不发送，仅记录',''),...state.alertWebhooks.map(item=>new Option(`#${item.id} ${item.name}`,String(item.id)))); }
$('#newAlertRule').onclick = () => {const form=$('#alertRuleForm');form.reset();form.elements.id.value='';form.elements.intervalSeconds.value=60;form.elements.forSeconds.value=0;form.elements.repeatIntervalSeconds.value=0;form.elements.enabled.checked=true;populateAlertRuleOptions(form);$('#alertRuleTitle').textContent='新建报警规则';$('#alertRuleError').textContent='';$('#alertRuleDialog').showModal();};
function openAlertRuleEditor(id){const item=state.alertRules.find(value=>value.id===id);if(!item)return;const form=$('#alertRuleForm');form.reset();populateAlertRuleOptions(form);form.elements.id.value=item.id;form.elements.name.value=item.name;form.elements.cluster.value=item.cluster;form.elements.intervalSeconds.value=item.interval_seconds;form.elements.forSeconds.value=item.for_seconds;form.elements.repeatIntervalSeconds.value=item.repeat_interval_seconds||0;form.elements.webhookId.value=item.webhook_id?String(item.webhook_id):'';form.elements.enabled.checked=item.enabled;form.elements.sql.value=item.sql;$('#alertRuleTitle').textContent=`编辑规则 #${item.id}`;$('#alertRuleError').textContent='';$('#alertRuleDialog').showModal();}
$$('.close-alert-rule').forEach(button => button.onclick = () => $('#alertRuleDialog').close());
$('#alertRuleForm').onsubmit = async event => {
  event.preventDefault();const form=event.currentTarget;const id=form.elements.id.value;const webhookId=form.elements.webhookId.value;
  const payload={name:form.elements.name.value,cluster:form.elements.cluster.value,sql:form.elements.sql.value,interval_seconds:Number(form.elements.intervalSeconds.value),for_seconds:Number(form.elements.forSeconds.value),repeat_interval_seconds:Number(form.elements.repeatIntervalSeconds.value)||0,webhook_id:webhookId?Number(webhookId):null,enabled:form.elements.enabled.checked};
  try{await api(id?`/api/alerting/rules/${id}`:'/api/alerting/rules',{method:id?'PUT':'POST',body:JSON.stringify(payload)});$('#alertRuleDialog').close();await loadAlerting();toast(id?'报警规则已更新':'报警规则已创建')}catch(error){$('#alertRuleError').textContent=error.message}
};
async function deleteAlertRule(id){const item=state.alertRules.find(value=>value.id===id);if(!item||!confirm(`确认删除报警规则 #${id} ${item.name}？`))return;try{await api(`/api/alerting/rules/${id}`,{method:'DELETE'});await loadAlerting();toast('报警规则已删除')}catch(error){toast(error.message)}}
function formatSecondsCompact(input){const seconds=Number(input)||0;if(seconds===0)return '立即';if(seconds%86400===0)return `${seconds/86400}天`;if(seconds%3600===0)return `${seconds/3600}小时`;if(seconds%60===0)return `${seconds/60}分`;return `${seconds}秒`}

async function loadUsers() {
  try {
    const users = await api('/api/users');
    $('#userRows').innerHTML = users.map(user => `<tr><td><strong>${esc(user.Username)}</strong></td><td><span class="tag">${esc(user.Role)}</span></td><td><span class="tag ${user.Disabled ? 'error' : 'ok'}">${user.Disabled ? '已停用' : '正常'}</span></td><td>${date(user.CreatedAt)}</td><td>${user.ID === state.user.ID ? '当前账号' : `<button class="ghost toggle-user" data-id="${user.ID}" data-disabled="${user.Disabled}">${user.Disabled ? '启用' : '停用'}</button>`}</td></tr>`).join('');
    $$('.toggle-user').forEach(button => button.onclick = async () => {
      try {
        await api(`/api/users/${button.dataset.id}`, {method: 'PATCH', body: JSON.stringify({Disabled: button.dataset.disabled !== 'true'})});
        loadUsers();
      } catch (error) { toast(error.message); }
    });
  } catch (error) { toast(error.message); }
}

$('#newUser').onclick = () => { $('#userForm').reset(); $('#userError').textContent = ''; $('#userDialog').showModal(); };
$$('.close').forEach(element => element.onclick = () => $('#userDialog').close());
$('#userForm').onsubmit = async event => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target));
  try {
    await api('/api/users', {method: 'POST', body: JSON.stringify(body)});
    $('#userDialog').close();
    loadUsers();
    toast('用户已创建');
  } catch (error) { $('#userError').textContent = error.message; }
};

async function loadAudit() {
  try {
    const rows = await api('/api/audit?limit=500');
    $('#auditRows').innerHTML = rows.map(row => {
      const detail = String(row.Error || row.Statement || '—');
      return `<tr><td>${date(row.At)}</td><td>${esc(row.User || '—')}</td><td><span class="tag">${esc(row.Cluster || '—')}</span></td><td>${esc(row.Action)}</td><td><span class="tag ${row.Status === 'ok' ? 'ok' : 'error'}">${esc(row.Status)}</span></td><td>${row.DurationMS || 0} ms</td><td class="code audit-detail"><div class="audit-statement"><span class="audit-statement-text">${esc(detail)}</span><span class="audit-statement-actions"><span class="audit-icon-action audit-expand hidden" role="button" tabindex="0" data-audit-action="expand" title="展开完整内容" aria-label="展开完整内容" aria-expanded="false">${icon('chevron-down')}</span><span class="audit-icon-action" role="button" tabindex="0" data-audit-action="copy" title="复制完整内容" aria-label="复制完整内容">${icon('copy')}</span></span></div></td></tr>`;
    }).join('');
    requestAnimationFrame(refreshAuditExpandControls);
  } catch (error) { toast(error.message); }
}

$('#refreshAudit').onclick = loadAudit;

function refreshAuditExpandControls() {
  $$('#auditRows .audit-statement').forEach(container => {
    const text = container.querySelector('.audit-statement-text');
    const control = container.querySelector('.audit-expand');
    const expanded = text.classList.contains('expanded');
    text.classList.remove('expanded');
    const truncated = text.scrollWidth > text.clientWidth + 1;
    if (expanded && truncated) text.classList.add('expanded');
    control.classList.toggle('hidden', !truncated);
    if (!truncated) {
      control.setAttribute('aria-expanded', 'false');
      control.setAttribute('aria-label', '展开完整内容');
      control.title = '展开完整内容';
      control.innerHTML = icon('chevron-down');
    }
  });
}

function handleAuditAction(target) {
  const action = target.closest('[data-audit-action]');
  if (!action) return;
  const text = action.closest('.audit-statement').querySelector('.audit-statement-text');
  if (action.dataset.auditAction === 'copy') {
    copyText(text.textContent, '审计详情已复制');
    return;
  }
  const expanded = text.classList.toggle('expanded');
  action.setAttribute('aria-expanded', String(expanded));
  action.setAttribute('aria-label', expanded ? '收起完整内容' : '展开完整内容');
  action.title = expanded ? '收起完整内容' : '展开完整内容';
  action.innerHTML = icon(expanded ? 'chevron-up' : 'chevron-down');
}

$('#auditRows').addEventListener('click', event => handleAuditAction(event.target));
$('#auditRows').addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('[data-audit-action]')) {
    event.preventDefault();
    handleAuditAction(event.target);
  }
});
window.addEventListener('resize', refreshAuditExpandControls);

function monitorCacheKey(cluster) { return `clickhouse-console:${apiRoot.pathname}:monitor:${cluster}`; }
function readMonitorCache(cluster) {
  try {
    const cached = JSON.parse(localStorage.getItem(monitorCacheKey(cluster)) || 'null');
    if (!cached || cached.cluster !== cluster || !cached.snapshot || !Number.isFinite(cached.recordedAt)) return null;
    return cached;
  } catch { return null; }
}
function writeMonitorCache(cluster, snapshot, recordedAt) {
  try { localStorage.setItem(monitorCacheKey(cluster), JSON.stringify({cluster, snapshot, recordedAt})); } catch {}
}

async function loadMonitor(force = false) {
  const cluster = state.activeCluster;
  if (!cluster) return;
  const cached = readMonitorCache(cluster);
  if (!force && cached) {
    renderMonitor(cached.snapshot, true, cached.recordedAt);
    if (Date.now() - cached.recordedAt <= monitorCacheTTL) return;
  }
  await fetchMonitor(cluster);
}

async function fetchMonitor(cluster) {
  if (state.monitorLoadingCluster === cluster) return;
  state.monitorLoadingCluster = cluster;
  $('#refreshMonitor').disabled = true;
  $('#refreshMonitor').innerHTML = `${icon('refresh-cw', 13)}<span>刷新中…</span>`;
  $('#monitorError').classList.add('hidden');
  try {
    const result = await api('/api/monitor');
    if (cluster !== state.activeCluster || result.cluster !== cluster) return;
    const recordedAt = Date.now();
    writeMonitorCache(cluster, result.snapshot, recordedAt);
    renderMonitor(result.snapshot, false, recordedAt);
  } catch (error) {
    if (cluster !== state.activeCluster) return;
    $('#monitorError').textContent = error.message;
    $('#monitorError').classList.remove('hidden');
    if (!readMonitorCache(cluster)) $('#monitorContent').innerHTML = '<div class="empty monitor-empty">监控数据加载失败</div>';
  } finally {
    if (state.monitorLoadingCluster === cluster) state.monitorLoadingCluster = '';
    if (cluster === state.activeCluster) {
      $('#refreshMonitor').disabled = false;
      $('#refreshMonitor').innerHTML = `${icon('refresh-cw', 13)}<span>刷新</span>`;
    }
  }
}

function renderMonitor(snapshot, cached, recordedAt) {
  const source = $('#monitorSource');
  source.className = cached ? 'cached' : 'live';
  source.textContent = cached ? `非最新数据 · 本地缓存于 ${date(recordedAt)}` : `实时数据 · 获取于 ${date(snapshot.generated_at || recordedAt)}`;
  const metrics = [...(snapshot.metrics || []), ...(snapshot.asynchronous_metrics || [])];
  const metricMap = new Map(metrics.map(row => [String(row.metric), number(row.value)]));
  const parts = snapshot.parts || [];
  const partBytes = parts.reduce((sum, row) => sum + number(row.bytes), 0);
  const partCount = parts.reduce((sum, row) => sum + number(row.parts), 0);
  const disks = snapshot.disks || [];
  const diskTotal = disks.reduce((sum, row) => sum + number(row.total_space_in_bytes), 0);
  const diskFree = disks.reduce((sum, row) => sum + number(row.free_space_in_bytes), 0);
  const diskUsed = Math.max(0, diskTotal - diskFree);
  const cards = [
    ['磁盘占用', `${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`],
    ['运行查询', formatCount(metricMap.get('Query'))],
    ['后台合并', formatCount(metricMap.get('Merge'))],
    ['内存占用', formatBytes(metricMap.get('MemoryTracking'))],
    ['运行时间', formatDuration(metricMap.get('Uptime'))],
    ['活动数据分区', formatCount(partCount)]
  ];
  const events = [...(snapshot.events || [])].sort((a, b) => number(b.value) - number(a.value));
  const partsRows = parts.map(row => `<tr><td>${esc(row.database)}</td><td class="code" title="${esc(row.table)}">${esc(row.table)}</td><td>${esc(row.disk_name)}</td><td>${esc(formatBytes(row.bytes))}</td><td>${esc(formatCount(row.parts))}</td><td>${esc(formatCount(row.rows))}</td></tr>`).join('');
  const eventRows = events.map(row => `<tr><td class="code metric-name-cell" title="${esc(row.event)}">${esc(row.event)}</td><td class="metric-val-cell">${esc(formatCount(row.value))}</td></tr>`).join('');
  const metricRows = metrics.map(row => `<tr><td class="code metric-name-cell" title="${esc(row.metric)}">${esc(row.metric)}</td><td class="metric-val-cell">${esc(formatCount(row.value))}</td></tr>`).join('');
  $('#monitorContent').innerHTML = `
    <div class="metric-cards">${cards.map(card => `<div class="metric-card"><small>${card[0]}</small><strong title="${esc(card[1])}">${esc(card[1])}</strong></div>`).join('')}</div>
    <div class="monitor-grid">
      <div class="panel monitor-panel monitor-panel-wide"><div class="panel-title"><strong>最大数据表 / Parts</strong><span>前 ${parts.length} 项 · ${esc(formatBytes(partBytes))} · ${disks.length} 个磁盘</span></div><div class="table-wrap"><table><thead><tr><th>数据库</th><th>数据表</th><th>磁盘</th><th>空间</th><th>Parts</th><th>行数</th></tr></thead><tbody>${partsRows}</tbody></table></div></div>
      <div class="panel monitor-panel"><div class="panel-title"><strong>累计事件</strong><span>${events.length} 项</span></div><div class="table-wrap"><table class="monitor-table"><thead><tr><th style="width:68%">事件名称</th><th style="width:32%;text-align:right">累计值</th></tr></thead><tbody>${eventRows || '<tr><td colspan="2" class="empty">暂无事件</td></tr>'}</tbody></table></div></div>
      <div class="panel monitor-panel"><div class="panel-title"><strong>实时指标</strong><span>${metrics.length} 项</span></div><div class="table-wrap"><table class="monitor-table"><thead><tr><th style="width:68%">指标名称</th><th style="width:32%;text-align:right">当前值</th></tr></thead><tbody>${metricRows || '<tr><td colspan="2" class="empty">暂无指标</td></tr>'}</tbody></table></div></div>
    </div>`;
}

$('#refreshMonitor').onclick = () => loadMonitor(true);

function quoteIdentifier(input) { return `\`${String(input).replaceAll('\\', '\\\\').replaceAll('`', '\\`')}\``; }
function sqlLiteral(input) { return `'${String(input).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`; }
function esc(input) { return String(input ?? '').replace(/[&<>'"]/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[char])); }
function value(input) { return typeof input === 'object' && input !== null ? JSON.stringify(input) : String(input ?? 'NULL'); }
function number(input) { const parsed = Number(input); return Number.isFinite(parsed) ? parsed : 0; }
function formatCount(input) { return number(input).toLocaleString(undefined, {maximumFractionDigits: 2}); }
function formatDuration(input) {
  const seconds = Math.max(0, number(input));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return days ? `${days}天 ${hours}小时` : hours ? `${hours}小时 ${minutes}分` : `${minutes}分`;
}

function formatBytes(input) {
  if (input === null || input === undefined || input === '') return '—';
  const bytes = Number(input);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / (1024 ** index);
  const digits = index === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[index]}`;
}
function date(input) { return new Date(input).toLocaleString(); }
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); setTimeout(() => $('#toast').classList.remove('show'), 2600); }
async function copyText(text, successToast = '已复制到剪贴板') {
  try {
    await navigator.clipboard.writeText(text);
    toast(successToast);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    toast(successToast);
  }
}

hydrateIcons();
updateSQLHighlight();
(async () => { try { showApp(await api('/api/session')); } catch { showLogin(); } })();
