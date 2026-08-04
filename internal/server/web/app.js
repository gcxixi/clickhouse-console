const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);
const apiRoot = new URL('api/', document.baseURI);
const defaultSQLPlaceholder = '输入 SQL，或选择库表生成查询建议';
const monitorCacheTTL = 60 * 60 * 1000;
let state = {csrf: '', user: null, clusters: [], managedClusters: [], activeCluster: '', activeView: 'query', pendingCluster: '', suggestedSQL: '', selectedDatabase: '', selectedTable: '', queryResult: null, resultColumnVisibility: [], monitorLoadingCluster: ''};

const lucideIcons = {
  activity: '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  'code-xml': '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
  'log-out': '<path d="m16 17 5-5-5-5"/><path d="M21 12H9"/><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>',
  network: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  'refresh-cw': '<path d="M3 12a9 9 0 0 1 15.74-6.26L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.74 6.26L3 16"/><path d="M8 16H3v5"/>',
  'scroll-text': '<path d="M15 12h-5M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
  'server-cog': '<path d="m10.85 14.77-.38.93M13.15 14.77a3 3 0 1 0-2.3-5.54l-.38-.93M13.15 9.23l.38-.93M13.53 15.7l-.38-.93M14.77 10.85l.93-.38M14.77 13.15l.93.38M9.23 10.85l-.93-.38M9.23 13.15l-.93.38"/><path d="M4.5 10H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-.5M4.5 14H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2h-.5M6 18h.01M6 6h.01"/>',
  'square-terminal': '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2"/>',
  'table-2': '<path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/>',
  'trash-2': '<path d="M10 11v6M14 11v6M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3.13a4 4 0 0 1 0 7.74M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>'
};

function icon(name, size = 16) {
  return `<svg class="lucide-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${lucideIcons[name] || ''}</svg>`;
}

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-lucide]').forEach(element => { element.innerHTML = icon(element.dataset.lucide, Number(element.dataset.iconSize) || 16); });
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
    state = {csrf: '', user: null, clusters: [], managedClusters: [], activeCluster: '', activeView: 'query', pendingCluster: '', suggestedSQL: '', selectedDatabase: '', selectedTable: '', queryResult: null, resultColumnVisibility: [], monitorLoadingCluster: ''};
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
  if (view === 'monitor') loadMonitor();
  if (view === 'clusters') loadManagedClusters();
  if (view === 'users') loadUsers();
  if (view === 'audit') loadAudit();
}

$$('nav button').forEach(button => button.onclick = () => activateView(button.dataset.view));

async function checkHealth() {
  const cluster = state.activeCluster;
  try {
    await api('/api/health');
    if (cluster !== state.activeCluster) return;
    $('#health').className = 'health ok';
    $('#health span').textContent = `${cluster} · 已连接`;
  } catch {
    if (cluster !== state.activeCluster) return;
    $('#health').className = 'health bad';
    $('#health span').textContent = `${cluster} · 连接失败`;
  }
}

function renderClusterSelector() {
  const select = $('#clusterSelect');
  select.replaceChildren(...state.clusters.map(cluster => new Option(cluster.alias, cluster.alias)));
  select.value = state.activeCluster;
  select.disabled = state.clusters.length < 2;
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
    resetEditorTables();
    resetQueryResult();
    $('#databases').replaceChildren();
    $('#tablesTitle').innerHTML = `${icon('table-2')}<span>数据表</span>`;
    $('#tables').innerHTML = '<div class="empty">选择一个数据库</div>';
    checkHealth();
    loadEditorDatabases().catch(error => toast(error.message));
    if (state.activeView === 'schema') loadDatabases();
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
  $('#queryStatus').className = 'status hidden';
  $('#queryStatus').textContent = '';
  $('#resultMeta').textContent = '等待执行';
  $('#resultColumns').className = 'result-column-controls hidden';
  $('#resultColumns').replaceChildren();
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
});

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
$('#format').onclick = () => {
  const editor = $('#sql');
  if (!editor.value.trim()) return;
  editor.value = editor.value.trim().replace(/\s+(FROM|WHERE|GROUP BY|ORDER BY|LIMIT|SETTINGS|FORMAT)\s+/gi, '\n$1 ');
};

async function runQuery() {
  const sql = $('#sql').value.trim();
  if (!sql) return;
  $('#run').disabled = true;
  $('#run').innerHTML = `${icon('play', 13)}<span>执行中…</span>`;
  $('#queryStatus').className = 'status hidden';
  try {
    const result = await api('/api/query', {method: 'POST', body: JSON.stringify({sql})});
    $('#queryStatus').className = 'status ok';
    $('#queryStatus').textContent = `执行成功 · ${result.elapsed_ms} ms`;
    $('#resultMeta').textContent = result.kind === 'query' ? `${result.rows || 0} 行 · ${result.elapsed_ms} ms` : `${result.kind.toUpperCase()} 执行成功`;
    renderResult(result);
  } catch (error) {
    $('#queryStatus').className = 'status error';
    $('#queryStatus').textContent = error.message;
  } finally {
    $('#run').disabled = false;
    $('#run').innerHTML = `${icon('play', 13)}<span>运行</span><kbd>⌘↵</kbd>`;
  }
}

function renderResult(result) {
  state.queryResult = result;
  if (!result.meta?.length) {
    state.resultColumnVisibility = [];
    $('#resultColumns').className = 'result-column-controls hidden';
    $('#resultColumns').replaceChildren();
    $('#result').className = 'empty';
    $('#result').textContent = '命令执行成功';
    return;
  }
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
  return meta.map(() => true);
}

function writeResultColumnVisibility() {
  if (!state.queryResult?.meta?.length) return;
  try { localStorage.setItem(resultColumnPreferenceKey(state.queryResult.meta), JSON.stringify(state.resultColumnVisibility)); } catch {}
}

function renderResultColumnControls(meta) {
  const controls = $('#resultColumns');
  controls.className = 'result-column-controls';
  controls.innerHTML = `<span class="result-column-label">显示字段</span><div class="result-column-options">${meta.map((column, index) => `<label title="${esc(column.type)}"><input type="checkbox" data-column-index="${index}" ${state.resultColumnVisibility[index] ? 'checked' : ''}><span>${esc(column.name)}</span></label>`).join('')}</div>`;
  controls.querySelectorAll('input').forEach(input => input.addEventListener('change', event => {
    state.resultColumnVisibility[Number(event.currentTarget.dataset.columnIndex)] = event.currentTarget.checked;
    writeResultColumnVisibility();
    renderResultTable();
  }));
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
  $('#result').className = 'table-wrap';
  $('#result').innerHTML = `<table><thead><tr>${visibleColumns.map(({column}) => `<th title="${esc(column.type)}">${esc(column.name)}</th>`).join('')}</tr></thead><tbody>${(result.data || []).map(row => `<tr>${visibleColumns.map(({column}) => `<td class="code result-cell">${esc(value(row[column.name]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  requestAnimationFrame(updateResultOverflowTooltips);
}

function updateResultOverflowTooltips() {
  $$('#result td.result-cell').forEach(cell => {
    if (cell.scrollWidth > cell.clientWidth) cell.title = cell.textContent;
    else cell.removeAttribute('title');
  });
}

$('#result').addEventListener('mouseover', event => {
  const cell = event.target.closest('td.result-cell');
  if (!cell) return;
  if (cell.scrollWidth > cell.clientWidth) cell.title = cell.textContent;
  else cell.removeAttribute('title');
});

async function loadDatabases() {
  try {
    const result = await api('/api/query', {method: 'POST', body: JSON.stringify({sql: 'SELECT name FROM system.databases ORDER BY name'})});
    $('#databases').innerHTML = result.data.map(row => `<button data-db="${esc(row.name)}">${icon('database')}<span>${esc(row.name)}</span></button>`).join('');
    $$('#databases button').forEach(button => button.onclick = () => loadTables(button.dataset.db, button));
  } catch (error) { toast(error.message); }
}

async function loadTables(database, databaseButton) {
  $$('#databases button').forEach(button => button.classList.remove('active'));
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
        <div class="ddl-panel hidden"><div class="ddl-heading"><span>建表语句</span><button class="copy-ddl" title="复制建表语句" aria-label="复制建表语句" disabled>${icon('copy')}</button></div><pre>加载中…</pre></div>
      </div>`).join('') : '<div class="empty">暂无数据表</div>';
    $$('#tables .ddl-action').forEach(button => button.onclick = () => toggleDDL(button));
    $$('#tables .query-action').forEach(button => button.onclick = () => openTableInWorkbench(button.closest('.table-entry').dataset.db, button.closest('.table-entry').dataset.table));
  } catch (error) { toast(error.message); }
}

async function toggleDDL(button) {
  const entry = button.closest('.table-entry');
  const panel = entry.querySelector('.ddl-panel');
  if (button.dataset.loaded === 'true') {
    const willShow = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willShow);
    button.classList.toggle('active', willShow);
    button.setAttribute('aria-expanded', String(willShow));
    return;
  }
  panel.classList.remove('hidden');
  button.classList.add('active');
  button.setAttribute('aria-expanded', 'true');
  button.disabled = true;
  try {
    const sql = `SHOW CREATE TABLE ${quoteIdentifier(entry.dataset.db)}.${quoteIdentifier(entry.dataset.table)}`;
    const result = await api('/api/query', {method: 'POST', body: JSON.stringify({sql})});
    const statement = String(result.data?.[0]?.statement || Object.values(result.data?.[0] || {})[0] || '未返回建表语句');
    entry.querySelector('pre').textContent = statement;
    const copyButton = entry.querySelector('.copy-ddl');
    copyButton.disabled = false;
    copyButton.onclick = () => copyText(statement);
    button.dataset.loaded = 'true';
  } catch (error) {
    entry.querySelector('pre').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function openTableInWorkbench(database, table) {
  activateView('query');
  try { await loadEditorDatabases(database, table); }
  catch (error) { toast(error.message); }
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.style.position = 'fixed';
      helper.style.opacity = '0';
      document.body.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      helper.remove();
    }
    toast('建表语句已复制');
  } catch { toast('复制失败，请手动复制'); }
}

$('#refreshSchema').onclick = loadDatabases;

async function loadManagedClusters() {
  try {
    state.managedClusters = await api('/api/clusters');
    $('#clusterRows').innerHTML = state.managedClusters.map(cluster => `<tr><td><strong>${esc(cluster.alias)}</strong></td><td><span class="tag">${cluster.source === 'platform' ? '平台' : '环境变量'}</span></td><td class="code" title="${esc(cluster.url)}">${esc(cluster.url)}</td><td>${esc(cluster.database)}</td><td><span class="tag ok">已加密配置</span></td><td>${cluster.source === 'platform' ? `<div class="row-actions"><button class="ghost edit-cluster" data-id="${esc(cluster.id)}">${icon('pencil', 13)}<span>编辑</span></button><button class="ghost delete-cluster" data-id="${esc(cluster.id)}">${icon('trash-2', 13)}<span>删除</span></button></div>` : '<span class="muted">只读</span>'}</td></tr>`).join('');
    $$('.edit-cluster').forEach(button => button.onclick = () => openClusterEditor(button.dataset.id));
    $$('.delete-cluster').forEach(button => button.onclick = () => deleteManagedCluster(button.dataset.id));
  } catch (error) { toast(error.message); }
}

function configureCredentialFields(enabled, required) {
  $('#credentialFields').classList.toggle('hidden', !enabled);
  const user = $('#clusterManageForm').elements.clusterUser;
  user.required = required;
  if (!enabled) {
    user.value = '';
    $('#clusterManageForm').elements.clusterPassword.value = '';
  }
}

$('#newCluster').onclick = () => {
  const form = $('#clusterManageForm');
  form.reset();
  form.elements.id.value = '';
  form.elements.alias.disabled = false;
  form.elements.database.value = 'default';
  $('#clusterManageTitle').textContent = '添加集群';
  $('#updateCredentialsLabel').classList.add('hidden');
  configureCredentialFields(true, true);
  $('#clusterManageError').textContent = '';
  $('#clusterManageDialog').showModal();
};

function openClusterEditor(id) {
  const cluster = state.managedClusters.find(item => item.id === id && item.source === 'platform');
  if (!cluster) return;
  const form = $('#clusterManageForm');
  form.reset();
  form.elements.id.value = cluster.id;
  form.elements.alias.value = cluster.alias;
  form.elements.alias.disabled = true;
  form.elements.url.value = cluster.url;
  form.elements.database.value = cluster.database;
  $('#clusterManageTitle').textContent = `编辑 ${cluster.alias}`;
  $('#updateCredentialsLabel').classList.remove('hidden');
  $('#updateCredentials').checked = false;
  configureCredentialFields(false, false);
  $('#clusterManageError').textContent = '';
  $('#clusterManageDialog').showModal();
}

$('#updateCredentials').onchange = event => configureCredentialFields(event.target.checked, event.target.checked);
$$('.close-cluster-manage').forEach(button => button.onclick = () => {
  $('#clusterManageForm').reset();
  $('#clusterManageDialog').close();
});

async function encryptClusterCredentials(user, password) {
  if (!globalThis.crypto?.subtle || !globalThis.isSecureContext) throw new Error('凭据加密需要 HTTPS 或 localhost 安全上下文');
  const jwk = await api('/api/clusters/transport-key');
  const publicKey = await crypto.subtle.importKey('jwk', jwk, {name: 'RSA-OAEP', hash: 'SHA-256'}, false, ['encrypt']);
  const aesKey = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt']);
  const rawKey = await crypto.subtle.exportKey('raw', aesKey);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify({user, password}));
  const ciphertext = await crypto.subtle.encrypt({name: 'AES-GCM', iv: nonce}, aesKey, plaintext);
  const wrappedKey = await crypto.subtle.encrypt({name: 'RSA-OAEP'}, publicKey, rawKey);
  return {key: base64(wrappedKey), nonce: base64(nonce), ciphertext: base64(ciphertext)};
}

function base64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

$('#clusterManageForm').onsubmit = async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const updateCredentials = !id || $('#updateCredentials').checked;
  const submit = $('#saveCluster');
  submit.disabled = true;
  submit.textContent = '加密并保存…';
  $('#clusterManageError').textContent = '';
  try {
    const credentials = updateCredentials ? await encryptClusterCredentials(form.elements.clusterUser.value.trim(), form.elements.clusterPassword.value) : {key: '', nonce: '', ciphertext: ''};
    const payload = {alias: form.elements.alias.value, url: form.elements.url.value, database: form.elements.database.value, update_credentials: updateCredentials, credentials};
    await api(id ? `/api/clusters/${encodeURIComponent(id)}` : '/api/clusters', {method: id ? 'PUT' : 'POST', body: JSON.stringify(payload)});
    form.reset();
    $('#clusterManageDialog').close();
    const session = await api('/api/session');
    state.clusters = session.clusters;
    state.activeCluster = session.active_cluster;
    renderClusterSelector();
    await loadManagedClusters();
    toast(id ? '集群配置已更新' : '集群已添加');
  } catch (error) { $('#clusterManageError').textContent = error.message; }
  finally {
    form.elements.clusterPassword.value = '';
    submit.disabled = false;
    submit.textContent = '保存';
  }
};

async function deleteManagedCluster(id) {
  const cluster = state.managedClusters.find(item => item.id === id && item.source === 'platform');
  if (!cluster || !confirm(`确认删除平台集群 ${cluster.alias}？`)) return;
  try {
    await api(`/api/clusters/${encodeURIComponent(id)}`, {method: 'DELETE'});
    const session = await api('/api/session');
    state.clusters = session.clusters;
    renderClusterSelector();
    await loadManagedClusters();
    toast('集群已删除');
  } catch (error) { toast(error.message); }
}

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
    $('#auditRows').innerHTML = rows.map(row => `<tr><td>${date(row.At)}</td><td>${esc(row.User || '—')}</td><td><span class="tag">${esc(row.Cluster || '—')}</span></td><td>${esc(row.Action)}</td><td><span class="tag ${row.Status === 'ok' ? 'ok' : 'error'}">${esc(row.Status)}</span></td><td>${row.DurationMS || 0} ms</td><td class="code" title="${esc(row.Error || row.Statement)}">${esc(row.Error || row.Statement || '—')}</td></tr>`).join('');
  } catch (error) { toast(error.message); }
}

$('#refreshAudit').onclick = loadAudit;

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
  const eventRows = events.map(row => `<tr><td class="code" title="${esc(row.event)}">${esc(row.event)}</td><td>${esc(formatCount(row.value))}</td></tr>`).join('');
  const metricRows = metrics.map(row => `<tr><td class="code" title="${esc(row.metric)}">${esc(row.metric)}</td><td>${esc(formatCount(row.value))}</td></tr>`).join('');
  $('#monitorContent').innerHTML = `
    <div class="metric-cards">${cards.map(card => `<div class="metric-card"><small>${card[0]}</small><strong title="${esc(card[1])}">${esc(card[1])}</strong></div>`).join('')}</div>
    <div class="monitor-grid">
      <div class="panel monitor-panel monitor-panel-wide"><div class="panel-title"><strong>最大数据表 / Parts</strong><span>前 ${parts.length} 项 · ${esc(formatBytes(partBytes))} · ${disks.length} 个磁盘</span></div><div class="table-wrap"><table><thead><tr><th>数据库</th><th>数据表</th><th>磁盘</th><th>空间</th><th>Parts</th><th>行数</th></tr></thead><tbody>${partsRows}</tbody></table></div></div>
      <div class="panel monitor-panel"><div class="panel-title"><strong>累计事件</strong><span>${events.length} 项</span></div><div class="table-wrap"><table><thead><tr><th>事件</th><th>累计值</th></tr></thead><tbody>${eventRows}</tbody></table></div></div>
      <div class="panel monitor-panel"><div class="panel-title"><strong>实时指标</strong><span>${metrics.length} 项</span></div><div class="table-wrap"><table><thead><tr><th>指标</th><th>当前值</th></tr></thead><tbody>${metricRows}</tbody></table></div></div>
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

hydrateIcons();
(async () => { try { showApp(await api('/api/session')); } catch { showLogin(); } })();
