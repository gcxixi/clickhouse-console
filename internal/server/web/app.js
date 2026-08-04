const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);
const apiRoot = new URL('api/', document.baseURI);
const defaultSQLPlaceholder = '输入 SQL，或选择库表生成查询建议';
let state = {csrf: '', user: null, suggestedSQL: '', selectedDatabase: '', selectedTable: ''};

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
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#username').textContent = data.user.Username;
  $('#role').textContent = data.user.Role;
  $('#avatar').textContent = data.user.Username[0].toUpperCase();
  $$('.admin-only').forEach(element => element.classList.toggle('hidden', data.user.Role !== 'admin'));
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
    state = {csrf: '', user: null, suggestedSQL: '', selectedDatabase: '', selectedTable: ''};
    showLogin();
  }
};

const views = {
  query: ['SQL 工作台', '查询并管理 ClickHouse 数据'],
  schema: ['对象浏览器', '浏览数据库和数据表'],
  users: ['用户管理', '管理控制台账号与角色'],
  audit: ['审计日志', '追踪关键操作与执行结果']
};

function activateView(view) {
  $$('nav button').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  $$('.view').forEach(element => element.classList.add('hidden'));
  $(`#${view}View`).classList.remove('hidden');
  $('#title').textContent = views[view][0];
  $('#subtitle').textContent = views[view][1];
  if (view === 'schema') loadDatabases();
  if (view === 'users') loadUsers();
  if (view === 'audit') loadAudit();
}

$$('nav button').forEach(button => button.onclick = () => activateView(button.dataset.view));

async function checkHealth() {
  try {
    await api('/api/health');
    $('#health').className = 'health ok';
    $('#health span').textContent = 'ClickHouse 已连接';
  } catch {
    $('#health').className = 'health bad';
    $('#health span').textContent = 'ClickHouse 连接失败';
  }
}

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
    stageTableQuery(database, preferredTable);
  }
}

function stageTableQuery(database, table) {
  const editor = $('#sql');
  state.selectedDatabase = database;
  state.selectedTable = table;
  state.suggestedSQL = `SELECT *\nFROM ${quoteIdentifier(database)}.${quoteIdentifier(table)}\nLIMIT 100`;
  editor.value = '';
  editor.placeholder = state.suggestedSQL;
  $('#suggestionHint').classList.remove('hidden');
  resetQueryResult();
  editor.focus();
  editor.setSelectionRange(0, 0);
}

function resetQueryResult() {
  $('#queryStatus').className = 'status hidden';
  $('#queryStatus').textContent = '';
  $('#resultMeta').textContent = '等待执行';
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

$('#queryTable').addEventListener('change', event => {
  if (event.target.value) stageTableQuery($('#queryDatabase').value, event.target.value);
  else clearSuggestedSQL();
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
  $('#run').textContent = '执行中…';
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
    $('#run').innerHTML = '▶ 运行 <kbd>⌘↵</kbd>';
  }
}

function renderResult(result) {
  if (!result.meta?.length) {
    $('#result').className = 'empty';
    $('#result').textContent = '命令执行成功';
    return;
  }
  const columns = result.meta.map(column => column.name);
  $('#result').className = 'table-wrap';
  $('#result').innerHTML = `<table><thead><tr>${result.meta.map(column => `<th title="${esc(column.type)}">${esc(column.name)}</th>`).join('')}</tr></thead><tbody>${(result.data || []).map(row => `<tr>${columns.map(column => { const fullValue = value(row[column]); return `<td class="code" title="${esc(fullValue)}">${esc(fullValue)}</td>`; }).join('')}</tr>`).join('')}</tbody></table>`;
}

async function loadDatabases() {
  try {
    const result = await api('/api/query', {method: 'POST', body: JSON.stringify({sql: 'SELECT name FROM system.databases ORDER BY name'})});
    $('#databases').innerHTML = result.data.map(row => `<button data-db="${esc(row.name)}">▱ &nbsp;${esc(row.name)}</button>`).join('');
    $$('#databases button').forEach(button => button.onclick = () => loadTables(button.dataset.db, button));
  } catch (error) { toast(error.message); }
}

async function loadTables(database, databaseButton) {
  $$('#databases button').forEach(button => button.classList.remove('active'));
  databaseButton.classList.add('active');
  $('#tablesTitle').textContent = `${database} / 数据表`;
  try {
    const result = await api('/api/query', {method: 'POST', body: JSON.stringify({sql: `SELECT name, engine, total_rows FROM system.tables WHERE database=${sqlLiteral(database)} ORDER BY name`})});
    $('#tables').innerHTML = result.data.length ? result.data.map(row => `
      <div class="table-entry" data-db="${esc(database)}" data-table="${esc(row.name)}">
        <div class="table-summary">
          <div class="table-identity"><strong>▦ ${esc(row.name)}</strong><small>${esc(row.engine)} · ${esc(value(row.total_rows))} rows</small></div>
          <div class="table-actions">
            <button class="table-action ddl-action" title="查看建表语句" aria-label="查看 ${esc(row.name)} 建表语句" aria-expanded="false">⌘</button>
            <button class="table-action query-action" title="在工作台查询" aria-label="查询 ${esc(row.name)}">▶</button>
          </div>
        </div>
        <div class="ddl-panel hidden"><div class="ddl-heading"><span>建表语句</span><button class="copy-ddl" title="复制建表语句" aria-label="复制建表语句" disabled>⧉</button></div><pre>加载中…</pre></div>
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
    $('#auditRows').innerHTML = rows.map(row => `<tr><td>${date(row.At)}</td><td>${esc(row.User || '—')}</td><td>${esc(row.Action)}</td><td><span class="tag ${row.Status === 'ok' ? 'ok' : 'error'}">${esc(row.Status)}</span></td><td>${row.DurationMS || 0} ms</td><td class="code" title="${esc(row.Error || row.Statement)}">${esc(row.Error || row.Statement || '—')}</td></tr>`).join('');
  } catch (error) { toast(error.message); }
}

$('#refreshAudit').onclick = loadAudit;

function quoteIdentifier(input) { return `\`${String(input).replaceAll('\\', '\\\\').replaceAll('`', '\\`')}\``; }
function sqlLiteral(input) { return `'${String(input).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`; }
function esc(input) { return String(input ?? '').replace(/[&<>'"]/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[char])); }
function value(input) { return typeof input === 'object' && input !== null ? JSON.stringify(input) : String(input ?? 'NULL'); }
function date(input) { return new Date(input).toLocaleString(); }
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); setTimeout(() => $('#toast').classList.remove('show'), 2600); }

(async () => { try { showApp(await api('/api/session')); } catch { showLogin(); } })();
