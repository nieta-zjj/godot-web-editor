import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { zipSync } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../server/app.js';

const runtime = resolve('.runtime', `browser-${randomUUID()}`);
await mkdir(runtime, { recursive: true });
const browserTemp = resolve(process.env.GWE_BROWSER_TMP ?? '.runtime/chrome');
await mkdir(browserTemp, { recursive: true });
process.env.TMPDIR = browserTemp;
const token = randomBytes(32).toString('hex');
const port = Number(process.env.GWE_E2E_PORT ?? 18988);
const origin = `http://127.0.0.1:${port}`;
const directory = join(runtime, 'data');
let application;
let browser;
const messages = [];
const pageErrors = [];
let passed = false;
const log = (message) => { messages.push(message); console.log(message); };
const start = async () => {
  application = createApplication({ dataDirectory: directory, token, origin });
  await new Promise((resolve) => application.server.listen(port, '127.0.0.1', resolve));
};
const api = async (path, options = {}) => {
  const response = await fetch(origin + path, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  assert.ok(response.ok, `${path}: ${response.status} ${response.ok ? '' : await response.text()}`);
  return response.headers.get('Content-Type')?.includes('application/json') ? response.json() : response.text();
};
async function login(page) {
  await page.goto(origin);
  await page.locator('#login-dialog[open]').waitFor();
  await page.fill('#access-token', token);
  await page.click('#login-form button');
  await page.locator('#project-dialog[open]').waitFor();
}
async function ready(page) {
  await page.waitForFunction(() => document.body.dataset.ready === 'true', null, { timeout: 180000 });
}
async function readStored(id, path) {
  const snapshot = await api(`/api/projects/${id}`);
  const file = snapshot.files.find((file) => file.path === path);
  assert.ok(file, path);
  return api(`/api/projects/${id}/blobs/${file.hash}`);
}
const config = `config_version=5\n\n[application]\nconfig/name="服务器持久化验证"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.7", "GL Compatibility")\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\nrenderer/rendering_method.mobile="gl_compatibility"\n`;
const scene = `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n\n[node name="Visible" type="ColorRect" parent="."]\noffset_right = 200.0\noffset_bottom = 120.0\ncolor = Color(0.2, 0.8, 0.4, 1)\n`;
const archive = Buffer.from(zipSync({
  'project.godot': Buffer.from(config),
  'main.tscn': Buffer.from(scene),
  'main.gd': Buffer.from('extends Node2D\n\nfunc _ready():\n\tprint("SERVER_PROJECT_RUNNING")\n'),
  'logic.gd': Buffer.from('extends RefCounted\n\nfunc value():\n\treturn 42\n'),
  'tests/test_logic.gd': Buffer.from('extends RefCounted\n\nfunc test_value(t):\n\tvar logic = load("res://logic.gd").new()\n\tt.eq(logic.value(), 42, "服务器项目的实际脚本")\n'),
}));

try {
  await start();
  browser = await chromium.launch({ ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
  let context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let page = await context.newPage();
  page.on('pageerror', (error) => { pageErrors.push(error.message); log(`浏览器错误：${error.message}`); });
  page.on('console', (message) => { if (message.type() === 'error') log(`控制台：${message.text().slice(0, 1000)}`); });
  page.on('dialog', (dialog) => dialog.accept());
  await login(page);
  await page.fill('#import-name', '服务器持久化验证');
  await page.setInputFiles('#import-zip', { name: 'project.zip', mimeType: 'application/zip', buffer: archive });
  await page.click('#import-project button');
  await ready(page);
  const id = new URL(page.url()).searchParams.get('project');
  log(`实际 Godot 编辑器已启动，项目 ${id}`);
  assert.deepEqual(await page.evaluate(() => indexedDB.databases()), []);
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  log('浏览器没有项目 IndexedDB 或 localStorage 数据');

  await page.click('#toggle-files');
  await page.fill('#file-path', 'notes/persistence.txt');
  await page.fill('#file-content', '这个文件保存在服务器。\n');
  await page.click('#write-file');
  await page.waitForFunction(() => window.godotServer.sync.status.phase === 'idle' && !window.godotServer.sync.status.pending.length);
  assert.equal(await readStored(id, 'notes/persistence.txt'), '这个文件保存在服务器。\n');
  log('通过网页控件编辑文件后，服务器返回相同内容');
  await writeFile(join(application.store.filesDirectory(id), 'external.gd'), 'extends Node\n# 由服务器工具直接写入\n');
  await page.waitForFunction(() => window.godotServer.sync.snapshot.files.some((file) => file.path === 'external.gd'), null, { timeout: 30000 });
  assert.match((await page.evaluate(() => window.godotAI.readFile('external.gd'))).content, /由服务器工具直接写入/);
  log('服务器目录直接写入的普通文件出现在浏览器编辑器中');

  await page.evaluate(() => window.godotAI.run());
  await page.waitForFunction(() => window.godotServer.host.logs.query({ limit: 100 }).some((line) => line.source === 'game' && line.text.includes('SERVER_PROJECT_RUNNING')), null, { timeout: 60000 });
  await page.evaluate(() => window.godotAI.stop());
  await page.waitForFunction(() => !window.godotServer.host.game, null, { timeout: 30000 });
  assert.deepEqual(await page.evaluate(() => indexedDB.databases()), []);
  log('游戏通过内存中的完整项目运行并输出实际脚本日志');
  for (let run = 0; run < 2; run++) {
    const since = await page.evaluate(() => window.godotServer.host.logs.query({ limit: 1 }).at(-1)?.seq ?? 0);
    await page.evaluate(() => window.godotAI.run());
    await page.waitForFunction((seq) => window.godotServer.host.logs.query({ since: seq, limit: 100 }).some((line) => line.source === 'game' && line.text.includes('SERVER_PROJECT_RUNNING')), since, { timeout: 60000 });
    await page.evaluate(() => window.godotAI.stop());
    await page.waitForFunction(() => !window.godotServer.host.game);
  }
  log('连续启动与停止游戏完成，运行资源正常释放');

  const tests = await page.evaluate(() => window.godotAI.call('run_tests'));
  assert.equal(tests.ok, true, JSON.stringify(tests));
  assert.equal(tests.passed, 1);
  const scripts = await page.evaluate(() => window.godotAI.call('check_scripts'));
  assert.equal(scripts.ok, true, JSON.stringify(scripts));
  log('实际 Godot 执行项目测试和 GDScript 检查通过');

  const client = new Client({ name: 'browser-check', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const state = await client.callTool({ name: 'get_editor_state', arguments: { project: id } });
  assert.ok(!state.isError, JSON.stringify(state));
  assert.equal(JSON.parse(state.content[0].text).main_scene, 'main.tscn');
  await client.close();
  log('MCP 已通过真实 WebSocket 读取 Godot 编辑器状态');

  await page.evaluate(() => window.godotAI.syncNow());
  await page.evaluate(() => window.godotServer.sync.stop());
  await page.evaluate(() => window.godotAI.writeFile('notes/persistence.txt', '浏览器中的并发修改\n'));
  const before = await api(`/api/projects/${id}`);
  const blob = await api(`/api/projects/${id}/blobs`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: '其他客户端的并发修改\n' });
  const remote = await api(`/api/projects/${id}/revisions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseRevision: before.revision, files: before.files.map((file) => file.path === 'notes/persistence.txt' ? { path: file.path, ...blob } : file) }) });
  const conflict = await page.evaluate(async () => {
    try { await window.godotAI.syncNow(); return null; }
    catch (error) { return error.code; }
  });
  assert.equal(conflict, 'file_conflict');
  assert.equal(await readStored(id, 'notes/persistence.txt'), '其他客户端的并发修改\n');
  await page.evaluate(async (revision) => {
    await window.godotServer.sync.pull({ 'notes/persistence.txt': 'local' }, revision);
    await window.godotAI.syncNow();
  }, remote.revision);
  assert.equal(await readStored(id, 'notes/persistence.txt'), '浏览器中的并发修改\n');
  log('真实并发修改触发冲突，明确选择后成功保存，服务器历史保留两份内容');

  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); window.godotServer.sync.stop(); });
  await context.close();
  await application.close();
  await start();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await login(page);
  await page.goto(`${origin}/?project=${id}`);
  await ready(page);
  const restored = await page.evaluate(() => window.godotAI.readFile('notes/persistence.txt'));
  assert.equal(restored.content, '浏览器中的并发修改\n');
  assert.deepEqual(await page.evaluate(() => indexedDB.databases()), []);
  log('服务器重启并更换全新浏览器会话后，项目内容完整恢复');
  await page.evaluate(() => window.godotServer.sync.stop());
  await context.close();
  assert.deepEqual(pageErrors, []);
  passed = true;
} finally {
  if (browser) await browser.close();
  if (application?.server.listening) await application.close();
  await writeFile(resolve('.runtime/server-e2e-result.json'), JSON.stringify({ passed, messages }, null, 2));
  if (passed) await rm(runtime, { recursive: true });
  else console.error(`验证数据保留在 ${runtime}`);
}
