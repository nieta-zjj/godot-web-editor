import { base64ToBytes, bytesToBase64, mapLimit, Mutex } from './util.js';

export async function request(path, { method = 'GET', json, bytes, type = 'application/octet-stream' } = {}) {
  const response = await fetch(path, {
    method, cache: 'no-store', headers: { 'X-GWE': '1', ...(json !== undefined ? { 'Content-Type': 'application/json' } : bytes !== undefined ? { 'Content-Type': type } : {}) },
    body: json !== undefined ? JSON.stringify(json) : bytes,
  });
  if (!response.ok) {
    const body = await response.json();
    throw Object.assign(new Error(body.error), body, { status: response.status });
  }
  if (response.status === 204) return null;
  return response.headers.get('Content-Type')?.includes('application/json') ? response.json() : new Uint8Array(await response.arrayBuffer());
}

async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
const byPath = (files) => new Map(files.map((file) => [file.path, file]));
const equal = (left, right) => left?.hash === right?.hash;

export class ServerSync extends EventTarget {
  constructor({ snapshot, bridge, host, projectDir }) {
    super();
    this.snapshot = snapshot;
    this.bridge = bridge;
    this.host = host;
    this.projectDir = projectDir;
    this.url = `/api/projects/${snapshot.id}`;
    this.mutex = new Mutex();
    this.status = { phase: 'idle', head: snapshot.revision, pending: [], conflicts: [], remotePending: [], lastError: null };
    this.stopped = false;
    this.note = '';
  }

  emit(patch) {
    Object.assign(this.status, patch);
    this.dispatchEvent(new CustomEvent('status', { detail: this.status }));
  }

  fail(error) {
    this.stop();
    this.emit({ phase: 'error', lastError: error.message, error });
  }

  addNote(note) { this.note = note; }

  async download(file, revision = this.snapshot.revision) {
    const bytes = await request(`${this.url}/blobs/${file.hash}?revision=${revision}`);
    if (bytes.length !== file.size || await sha256(bytes) !== file.hash) throw new Error(`文件完整性校验失败：${file.path}`);
    return bytes;
  }

  async load(engine) {
    await mapLimit(this.snapshot.files, 4, async (file) => engine.copyToFS(`${this.projectDir}/${file.path}`, await this.download(file)));
  }

  async copyRuntime(engine) {
    const files = await this.bridge.call('runtime_files', {}, 60000);
    await mapLimit(files, 4, async (file) => {
      const result = await this.bridge.call('read_file', { path: file.path, encoding: 'base64' }, 60000);
      engine.copyToFS(`${this.projectDir}/${file.path}`, base64ToBytes(result.content));
    });
  }

  async manifest() {
    return (await this.bridge.call('file_manifest', {}, 60000)).map(({ path, hash, size }) => ({ path, hash, size }));
  }

  differences(files) {
    const base = byPath(this.snapshot.files);
    const local = byPath(files);
    return [...new Set([...base.keys(), ...local.keys()])].filter((path) => !equal(base.get(path), local.get(path)));
  }

  async refreshStatus() {
    this.emit({ pending: this.differences(await this.manifest()) });
  }

  async apply(remote, writes, deletes) {
    for (const file of writes) {
      const content = bytesToBase64(await this.download(file, remote.revision));
      const result = await this.bridge.call('write_files', { files: [{ path: file.path, encoding: 'base64', content }] }, 60000);
      if (result.errors.length) throw new Error(result.errors.join('\n'));
    }
    if (deletes.length) {
      const result = await this.bridge.call('delete_files', { paths: deletes });
      if (result.errors.length) throw new Error(result.errors.join('\n'));
    }
    const actual = byPath(await this.manifest());
    if (writes.some((file) => !equal(file, actual.get(file.path))) || deletes.some((path) => actual.has(path))) throw new Error('编辑器尚未完整应用服务器文件');
  }

  async pullLocked(resolutions = {}, expectedRevision) {
    const remote = await request(this.url);
    if (expectedRevision && remote.revision !== expectedRevision) throw Object.assign(new Error('服务器再次发生修改，请重新检查冲突'), { code: 'revision_conflict' });
    if (remote.revision === this.snapshot.revision) return { applied: 0 };
    await this.bridge.call('save_all');
    const local = byPath(await this.manifest());
    const base = byPath(this.snapshot.files);
    const incoming = byPath(remote.files);
    const conflicts = [];
    const writes = [];
    const deletes = [];
    for (const path of new Set([...base.keys(), ...local.keys(), ...incoming.keys()])) {
      const current = local.get(path);
      const next = incoming.get(path);
      const before = base.get(path);
      if (equal(current, next) || equal(next, before)) continue;
      if (!equal(current, before) && !['local', 'server'].includes(resolutions[path])) {
        conflicts.push(path);
        continue;
      }
      if (!equal(current, before) && resolutions[path] === 'local') continue;
      if (next) writes.push(next);
      else deletes.push(path);
    }
    if (conflicts.length) {
      this.emit({ conflicts });
      throw Object.assign(new Error('存在同时修改的文件，请选择要保留的内容'), { code: 'file_conflict', paths: conflicts, revision: remote.revision });
    }
    await this.apply(remote, writes, deletes);
    this.snapshot = remote;
    this.emit({ head: remote.revision, conflicts: [], lastError: null, error: null });
    await this.refreshStatus();
    return { applied: writes.length + deletes.length };
  }

  pull(resolutions, revision) {
    return this.mutex.run(() => this.pullLocked(resolutions, revision));
  }

  push(message, { confirmDeletes = false } = {}) {
    return this.mutex.run(async () => {
      this.emit({ phase: 'saving', lastError: null, error: null });
      await this.bridge.call('save_all');
      await this.pullLocked();
      const files = await this.manifest();
      const changed = this.differences(files);
      this.emit({ pending: changed });
      if (changed.length) {
        const base = byPath(this.snapshot.files);
        await mapLimit(files.filter((file) => !equal(base.get(file.path), file)), 3, async (file) => {
          const result = await this.bridge.call('read_file', { path: file.path, encoding: 'base64' }, 60000);
          const bytes = base64ToBytes(result.content);
          if (await sha256(bytes) !== file.hash) throw new Error(`保存期间文件发生修改，请重新保存：${file.path}`);
          const uploaded = await request(`${this.url}/blobs`, { method: 'POST', bytes });
          if (uploaded.hash !== file.hash) throw new Error(`服务器文件校验失败：${file.path}`);
        });
        this.snapshot = await request(`${this.url}/revisions`, { method: 'POST', json: { baseRevision: this.snapshot.revision, files, message: message ?? (this.note || '保存项目'), confirmDeletes } });
        this.note = '';
      }
      this.emit({ phase: 'idle', head: this.snapshot.revision, conflicts: [], error: null });
      await this.refreshStatus();
      return { revision: this.snapshot.revision, files: changed, storage: 'server' };
    });
  }

  start() {
    this.stop();
    this.stopped = false;
    const generation = Symbol();
    this.generation = generation;
    const tick = async () => {
      try {
        await this.push();
        if (!this.stopped && this.generation === generation) this.timer = setTimeout(tick, 2000);
      } catch (error) { this.fail(error); }
    };
    this.timer = setTimeout(tick, 2000);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
