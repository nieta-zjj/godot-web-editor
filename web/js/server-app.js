import { EditorBridge } from './bridge.js';
import { GodotHost } from './godot-host.js';
import { LogBuffer } from './logs.js';
import { ProjectAPI } from './project-api.js';
import { installGodotAI, registerWebMCP } from './ai-bridge.js';
import { request, ServerSync } from './server-sync.js';

const $ = (selector) => document.querySelector(selector);
let sync;
let api;
let host;
let safeNavigation = false;
let interaction = 0;
let savedInteraction = 0;

function showError(error) {
  $('#error-text').textContent = error.message;
  for (const selector of ['#login-error', '#project-error']) $(selector).textContent = error.message;
  $('#operation-error').hidden = false;
  $('#resolve-error').hidden = error.code !== 'file_conflict';
  if (sync) sync.fail(error);
}

function handle(selector, event, action) {
  $(selector).addEventListener(event, async (e) => {
    if (event === 'submit') e.preventDefault();
    const button = event === 'submit' ? e.submitter : e.currentTarget;
    if (button?.tagName === 'BUTTON') button.disabled = true;
    try { await action(e); }
    catch (error) { showError(error); }
    finally { if (button?.tagName === 'BUTTON') button.disabled = false; }
  });
}

function navigate(project = '') {
  safeNavigation = true;
  location.href = project ? `/?project=${encodeURIComponent(project)}` : '/';
}

async function showProjects() {
  const { projects } = await request('/api/projects');
  $('#project-list').replaceChildren(...projects.map((project) => {
    const button = document.createElement('button');
    button.textContent = project.name;
    button.onclick = () => navigate(project.id);
    return button;
  }));
  $('#project-empty').hidden = projects.length > 0;
  $('#loading').hidden = true;
  $('#project-dialog').showModal();
}

async function saveNow(confirmDeletes = false) {
  const startedInteraction = interaction;
  let result;
  try { result = await sync.push(undefined, { confirmDeletes }); }
  catch (error) {
    if (error.code !== 'deletion_confirmation') throw error;
    if (!confirm(`确认从项目中删除以下文件？\n${error.paths.join('\n')}\n服务器版本历史会保留文件内容。`)) throw error;
    result = await sync.push(undefined, { confirmDeletes: true });
  }
  if (interaction === startedInteraction) savedInteraction = interaction;
  $('#operation-error').hidden = true;
  sync.start();
  return result;
}

async function refreshFiles() {
  const { files } = await api.call('list_files');
  const placeholder = new Option('选择文件', '');
  $('#file-select').replaceChildren(placeholder, ...files.sort((a, b) => a.path.localeCompare(b.path)).map((file) => new Option(file.path, file.path)));
}

async function showHistory() {
  const { revisions } = await request(`${sync.url}/history`);
  $('#history-list').replaceChildren(...revisions.map((revision) => {
    const row = document.createElement('div');
    const text = document.createElement('span');
    text.textContent = `${new Date(revision.created_at).toLocaleString()}  ${revision.message}`;
    const download = document.createElement('button');
    download.textContent = '下载这个版本';
    download.onclick = () => downloadArchive(revision.revision);
    const restore = document.createElement('button');
    restore.textContent = '恢复这个版本';
    restore.disabled = revision.revision === sync.snapshot.revision;
    restore.onclick = async () => {
      try {
        if (!confirm('确认恢复此版本？当前内容会保留在服务器历史记录中。')) return;
        await saveNow();
        sync.stop();
        await request(`${sync.url}/restore`, { method: 'POST', json: { revision: revision.revision, baseRevision: sync.snapshot.revision } });
        navigate(sync.snapshot.id);
      } catch (error) { showError(error); }
    };
    row.append(text, download, restore);
    return row;
  }));
  $('#history-dialog').showModal();
}

function downloadArchive(revision = sync.snapshot.revision) {
  const anchor = document.createElement('a');
  anchor.href = `${sync.url}/archive?revision=${revision}`;
  anchor.download = `${sync.snapshot.name}.zip`;
  anchor.click();
}

async function connectTools() {
  const { ticket } = await request(`${sync.url}/connect`, { method: 'POST' });
  const url = new URL('/live', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  const socket = new WebSocket(url);
  socket.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'changed') {
      if (sync.status.phase !== 'error') sync.pull().catch(showError);
      return;
    }
    if (message.type !== 'call') return;
    try {
      await sync.pull();
      const result = await api.call(message.name, message.args);
      socket.send(JSON.stringify({ id: message.id, result }));
    } catch (error) {
      socket.send(JSON.stringify({ id: message.id, error: error.message }));
    }
  };
  socket.onclose = () => {
    if (!safeNavigation) {
      $('#error-text').textContent = 'MCP 连接已关闭，刷新页面可以重新连接。';
      $('#operation-error').hidden = false;
    }
  };
}

async function openProject(project) {
  const missing = GodotHost.missingFeatures();
  if (missing.length) throw new Error(`浏览器缺少运行 Godot 的功能：${missing.join(', ')}`);
  const snapshot = await request(`/api/projects/${encodeURIComponent(project)}`);
  const logs = new LogBuffer();
  const bridge = new EditorBridge();
  const projectDir = `/projects/${snapshot.id}`;
  host = new GodotHost({
    editorCanvas: $('#editor-canvas'), gameCanvas: $('#game-canvas'), gameLayer: $('#game-layer'), logs,
    persistentPaths: [],
    prepareGame: (engine) => sync.copyRuntime(engine),
    prepareEditor: async (engine) => {
      sync.snapshot = await request(sync.url);
      await sync.load(engine);
    },
  });
  sync = new ServerSync({ snapshot, bridge, host, projectDir });
  $('#project-name').textContent = snapshot.name;
  sync.addEventListener('status', () => {
    const status = sync.status;
    const label = $('#save-status');
    label.dataset.state = status.phase;
    label.textContent = status.phase === 'error' ? '尚未保存到服务器' : status.phase === 'saving' ? '正在保存' : status.pending.length ? `待保存 ${status.pending.length} 个文件` : '已保存到服务器';
    if (status.error) {
      $('#error-text').textContent = status.error.message;
      $('#operation-error').hidden = false;
      $('#resolve-error').hidden = status.error.code !== 'file_conflict';
    }
  });
  await host.init((current, total) => {
    $('#loading-text').textContent = '正在加载 Godot 编辑器';
    if (total) $('#loading-bar').value = current / total;
  });
  $('#loading-text').textContent = '正在从服务器读取项目';
  await sync.load(host.editor);
  await host.startEditor(projectDir);
  if (!await bridge.waitReady(90000)) throw new Error('Godot 项目插件未能启动，请检查项目脚本');
  api = new ProjectAPI({ sync, bridge, host, logs, info: { storage: 'server', projectId: snapshot.id, projectDir, appVersion: '0.3.0', godotVersion: '4.7.2' } });
  installGodotAI(api);
  registerWebMCP(api, logs);
  window.godotServer = { api, sync, host };
  logs.addEventListener('line', () => { $('#logs').textContent = logs.query({ limit: 150 }).map((entry) => `[${entry.source}] ${entry.text}`).join('\n'); });
  host.addEventListener('game-error', (event) => showError(event.detail));
  host.addEventListener('editor-exit', () => showError(new Error('编辑器已经关闭，刷新页面可读取服务器保存的项目')));
  $('#loading').hidden = true;
  for (const selector of ['#save', '#pull', '#toggle-files', '#history', '#download']) $(selector).disabled = false;
  await sync.push();
  sync.start();
  await connectTools();
  document.body.dataset.ready = 'true';
}

handle('#login-form', 'submit', async () => {
  await request('/api/session', { method: 'POST', json: { token: $('#access-token').value } });
  $('#access-token').value = '';
  $('#login-dialog').close();
  safeNavigation = true;
  location.reload();
});
handle('#create-project', 'submit', async () => {
  const project = await request('/api/projects', { method: 'POST', json: { name: $('#new-name').value } });
  navigate(project.id);
});
handle('#import-project', 'submit', async () => {
  const bytes = new Uint8Array(await $('#import-zip').files[0].arrayBuffer());
  const project = await request(`/api/import?name=${encodeURIComponent($('#import-name').value)}`, { method: 'POST', bytes, type: 'application/zip' });
  navigate(project.id);
});
handle('#save', 'click', () => saveNow());
handle('#pull', 'click', async () => { await sync.pull(); await saveNow(); });
handle('#projects', 'click', async () => { if (sync) await saveNow(); navigate(); });
handle('#logout', 'click', async () => { if (sync) await saveNow(); await request('/api/session', { method: 'DELETE' }); navigate(); });
handle('#toggle-files', 'click', async () => { $('#server-files').hidden = !$('#server-files').hidden; await refreshFiles(); });
handle('#refresh-files', 'click', refreshFiles);
handle('#file-select', 'change', async () => {
  if (!$('#file-select').value) return;
  const file = await api.call('read_file', { path: $('#file-select').value });
  $('#file-path').value = file.path;
  $('#file-content').value = file.encoding === 'utf8' ? file.content : '二进制文件，请通过 Godot 资源管理器操作。';
  $('#file-content').disabled = file.encoding !== 'utf8';
  $('#write-file').disabled = file.encoding !== 'utf8';
});
handle('#write-file', 'click', async () => {
  const result = await api.call('write_files', { files: [{ path: $('#file-path').value, content: $('#file-content').value }] });
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  await saveNow();
  await refreshFiles();
});
handle('#delete-file', 'click', async () => {
  const path = $('#file-path').value;
  if (!path || !confirm(`确认删除 ${path}？`)) return;
  const result = await api.call('delete_files', { paths: [path] });
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  await saveNow(true);
  await refreshFiles();
});
handle('#download', 'click', async () => { await saveNow(); downloadArchive(); });
handle('#history', 'click', showHistory);
handle('#close-history', 'click', () => $('#history-dialog').close());
handle('#stop-game', 'click', () => api.call('stop_project'));
handle('#resolve-error', 'click', () => {
  const error = sync.status.error;
  $('#conflict-files').replaceChildren(...error.paths.map((path) => {
    const label = document.createElement('label');
    label.textContent = path;
    const select = document.createElement('select');
    select.dataset.path = path;
    select.required = true;
    select.append(new Option('请选择保留的内容', ''), new Option('当前编辑器内容', 'local'), new Option('服务器内容', 'server'));
    label.append(select);
    return label;
  }));
  $('#conflict-dialog').dataset.revision = error.revision;
  $('#conflict-dialog').showModal();
});
handle('#conflict-form', 'submit', async () => {
  const resolutions = Object.fromEntries([...$('#conflict-files').querySelectorAll('select')].map((select) => [select.dataset.path, select.value]));
  await sync.pull(resolutions, $('#conflict-dialog').dataset.revision);
  $('#conflict-dialog').close();
  await saveNow();
});
handle('#cancel-conflict', 'click', () => $('#conflict-dialog').close());
for (const name of ['keydown', 'pointerdown']) $('#editor-area').addEventListener(name, () => interaction++, { capture: true });
window.addEventListener('beforeunload', (event) => {
  if (!safeNavigation && sync && (sync.status.pending.length || sync.status.phase !== 'idle' || interaction !== savedInteraction)) event.preventDefault();
});

async function main() {
  // 项目内容始终由服务器读取，清除浏览器存储不会影响服务器项目。
  const session = await fetch('/api/session', { cache: 'no-store' });
  if (session.status === 401) {
    $('#loading').hidden = true;
    $('#save-status').textContent = '请登录';
    $('#login-dialog').showModal();
    return;
  }
  if (!session.ok) throw new Error(`服务器连接失败：${session.status}`);
  const project = new URL(location.href).searchParams.get('project');
  if (project) await openProject(project);
  else await showProjects();
}
main().catch(showError);
