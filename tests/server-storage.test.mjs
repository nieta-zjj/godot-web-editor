import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { zipSync, unzipSync } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApplication } from '../server/app.js';
import { digest } from '../server/store.js';

const directory = resolve('.runtime', `storage-${randomUUID()}`);
const secret = randomBytes(32).toString('hex');
let application;
let base;
let cookie;

async function start() {
  application = createApplication({ dataDirectory: directory, token: secret, origin: 'http://localhost:8788' });
  await new Promise((resolve) => application.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${application.server.address().port}`;
}

async function api(path, { method = 'GET', json, bytes, status = 200, authenticated = true } = {}) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(authenticated ? { Authorization: `Bearer ${secret}` } : {}), ...(json === undefined ? bytes ? { 'Content-Type': 'application/octet-stream' } : {} : { 'Content-Type': 'application/json' }) },
    body: json === undefined ? bytes : JSON.stringify(json),
  });
  const result = response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, status, JSON.stringify(result));
  return result;
}

await test('服务器持久化、版本冲突、导入导出与 MCP', async (t) => {
  await mkdir(directory, { recursive: true });
  await start();
  t.after(async () => { await application.close(); await rm(directory, { recursive: true }); });
  let project;
  let firstSaved;
  const contents = Buffer.from('extends Node\n\nfunc value():\n\treturn 42\n');

  await t.test('未授权请求被拒绝，登录会话可用于浏览器', async () => {
    await api('/api/projects', { authenticated: false, status: 401 });
    const login = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GWE': '1' }, body: JSON.stringify({ token: secret }) });
    assert.equal(login.status, 200);
    cookie = login.headers.getSetCookie()[0].split(';')[0];
    assert.match(login.headers.getSetCookie()[0], /HttpOnly/);
    const response = await fetch(`${base}/api/projects`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    const csrf = await fetch(`${base}/api/projects`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '拒绝无来源校验请求' }) });
    assert.equal(csrf.status, 403);
    const otherOrigin = await fetch(`${base}/api/projects`, { headers: { Cookie: cookie, Origin: 'https://untrusted.invalid' } });
    assert.equal(otherOrigin.status, 403);
  });

  await t.test('项目写入服务器并读取相同字节', async () => {
    project = await api('/api/projects', { method: 'POST', json: { name: '持久化验证' }, status: 201 });
    assert.ok(project.files.some((file) => file.path === 'project.godot'));
    const blob = await api(`/api/projects/${project.id}/blobs`, { method: 'POST', bytes: contents, status: 201 });
    firstSaved = await api(`/api/projects/${project.id}/revisions`, { method: 'POST', json: { baseRevision: project.revision, files: [...project.files, { path: 'logic.gd', ...blob }] } });
    const read = await api(`/api/projects/${project.id}/blobs/${blob.hash}`);
    assert.deepEqual(read, contents);
    assert.deepEqual(await readFile(join(application.store.filesDirectory(project.id), 'logic.gd')), contents);
  });

  await t.test('旧版本提交被拒绝且不会改变当前数据', async () => {
    const conflict = await api(`/api/projects/${project.id}/revisions`, { method: 'POST', json: { baseRevision: project.revision, files: project.files }, status: 409 });
    assert.equal(conflict.code, 'revision_conflict');
    assert.equal((await api(`/api/projects/${project.id}`)).revision, firstSaved.revision);
    const bad = await api(`/api/projects/${project.id}/revisions`, { method: 'POST', json: { baseRevision: firstSaved.revision, files: [...firstSaved.files, { path: '../outside.gd', hash: digest(contents), size: contents.length }] }, status: 400 });
    assert.ok(bad.error);
  });

  await t.test('服务器重启后项目、文件和会话仍然存在', async () => {
    await application.close();
    await start();
    const restored = await api(`/api/projects/${project.id}`);
    assert.equal(restored.revision, firstSaved.revision);
    assert.deepEqual(await api(`/api/projects/${project.id}/blobs/${digest(contents)}`), contents);
    assert.equal((await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })).status, 200);
  });

  await t.test('所有文件删除都要求确认，并能从历史恢复', async () => {
    const blocked = await api(`/api/projects/${project.id}/revisions`, { method: 'POST', json: { baseRevision: firstSaved.revision, files: project.files }, status: 409 });
    assert.equal(blocked.code, 'deletion_confirmation');
    const removed = await api(`/api/projects/${project.id}/revisions`, { method: 'POST', json: { baseRevision: firstSaved.revision, files: project.files, confirmDeletes: true } });
    const restored = await api(`/api/projects/${project.id}/restore`, { method: 'POST', json: { baseRevision: removed.revision, revision: firstSaved.revision } });
    assert.ok(restored.files.some((file) => file.path === 'logic.gd'));
    assert.notEqual(restored.revision, firstSaved.revision);
  });

  await t.test('服务器上的普通工具直接修改项目目录，API 会读取修改并保存历史', async () => {
    const before = await api(`/api/projects/${project.id}`);
    const file = join(application.store.filesDirectory(project.id), 'external.txt');
    await writeFile(file, '通过服务器文件系统写入\n');
    const current = await api(`/api/projects/${project.id}`);
    assert.notEqual(current.revision, before.revision);
    const entry = current.files.find((entry) => entry.path === 'external.txt');
    assert.ok(entry);
    assert.equal((await api(`/api/projects/${project.id}/blobs/${entry.hash}`)).toString(), '通过服务器文件系统写入\n');
    await unlink(file);
    assert.ok(!(await api(`/api/projects/${project.id}`)).files.some((entry) => entry.path === 'external.txt'));
    assert.ok((await api(`/api/projects/${project.id}?revision=${current.revision}`)).files.some((entry) => entry.path === 'external.txt'));
  });

  await t.test('项目中的符号链接不能读取项目目录以外的文件', async () => {
    const outside = join(directory, 'outside.txt');
    const link = join(application.store.filesDirectory(project.id), 'linked.txt');
    await writeFile(outside, '项目外部的数据');
    await symlink(outside, link);
    const result = await api(`/api/projects/${project.id}`, { status: 409 });
    assert.equal(result.code, 'symlink');
    await unlink(link);
  });

  await t.test('40 MiB 二进制文件上传后内容校验通过', async () => {
    const bytes = randomBytes(40 * 1024 * 1024);
    const blob = await api(`/api/projects/${project.id}/blobs`, { method: 'POST', bytes, status: 201 });
    assert.equal(blob.size, bytes.length);
    assert.equal(blob.hash, digest(bytes));
  });

  await t.test('ZIP 导出和重新导入保留项目源文件', async () => {
    const archive = await api(`/api/projects/${project.id}/archive`);
    assert.deepEqual(Buffer.from(unzipSync(archive)['logic.gd']), contents);
    const imported = await fetch(`${base}/api/import?name=ZIP验证`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/zip' }, body: archive });
    assert.equal(imported.status, 201);
    assert.ok((await imported.json()).files.some((file) => file.path === 'logic.gd'));
    const traversal = zipSync({ 'project.godot': Buffer.from('config_version=5\n'), '../outside.txt': contents });
    const invalid = await fetch(`${base}/api/import?name=路径检查`, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/zip' }, body: traversal });
    assert.equal(invalid.status, 400);
  });

  await t.test('真实 MCP 客户端读写服务器，旧版本和未经确认的删除被拒绝', async () => {
    const client = new Client({ name: 'storage-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }));
    try {
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 17);
      const state = JSON.parse((await client.callTool({ name: 'get_status', arguments: { project: project.id } })).content[0].text);
      const write = await client.callTool({ name: 'write_files', arguments: { project: project.id, base_revision: state.revision, files: [{ path: 'from-mcp.gd', content: 'extends RefCounted\n' }] } });
      assert.ok(!write.isError, JSON.stringify(write));
      const revision = JSON.parse(write.content[0].text).revision;
      const stale = await client.callTool({ name: 'write_files', arguments: { project: project.id, base_revision: state.revision, files: [{ path: 'from-mcp.gd', content: 'extends Node\n' }] } });
      assert.equal(stale.isError, true);
      const blocked = await client.callTool({ name: 'delete_files', arguments: { project: project.id, base_revision: revision, paths: ['from-mcp.gd'] } });
      assert.equal(blocked.isError, true);
      const deleted = await client.callTool({ name: 'delete_files', arguments: { project: project.id, base_revision: revision, paths: ['from-mcp.gd'], confirm_deletes: true } });
      assert.ok(!deleted.isError, JSON.stringify(deleted));
    } finally { await client.close(); }
  });
});
