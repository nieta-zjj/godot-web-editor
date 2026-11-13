import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export class StorageError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    Object.assign(this, { status, code, details });
  }
}

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const projectPath = z.string().min(1).max(1024).refine((value) => {
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..' && part !== '.git' && part !== '.godot');
}, '项目路径必须位于项目内部，且不能包含缓存目录');
const manifestSchema = z.array(z.object({ path: projectPath, hash: hashSchema, size: z.number().int().nonnegative() })).max(20000);
const sorted = (files) => files.sort((a, b) => a.path.localeCompare(b.path));
const sameFiles = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

export class ProjectStore {
  constructor(directory) {
    this.directory = directory;
    for (const path of [directory, join(directory, 'objects'), join(directory, 'staging'), join(directory, 'projects')]) mkdirSync(path, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'metadata.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, head TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
        parent TEXT, files TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS revisions_project ON revisions(project_id, created_at);
      CREATE TABLE IF NOT EXISTS pending (project_id TEXT PRIMARY KEY REFERENCES projects(id));
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
    `);
    for (const row of this.db.prepare('SELECT project_id FROM pending').all()) this.applyPending(row.project_id);
  }

  close() { this.db.close(); }

  filesDirectory(id) {
    z.string().uuid().parse(id);
    return join(this.directory, 'projects', id, 'files');
  }

  atomicWrite(path, bytes) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, 'staging', randomUUID());
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  }

  objectPath(hash) { return join(this.directory, 'objects', hashSchema.parse(hash)); }

  putBlob(bytes) {
    const hash = digest(bytes);
    const path = this.objectPath(hash);
    if (!existsSync(path)) this.atomicWrite(path, bytes);
    return { hash, size: bytes.length };
  }

  blob(hash) {
    const path = this.objectPath(hash);
    if (!existsSync(path)) throw new StorageError(404, 'missing_blob', '服务器中没有这个文件内容');
    const bytes = readFileSync(path);
    if (digest(bytes) !== hash) throw new StorageError(500, 'corrupt_blob', '文件历史内容校验失败');
    return bytes;
  }

  list() {
    return this.db.prepare('SELECT id, name, head AS revision, created_at FROM projects ORDER BY created_at DESC').all();
  }

  readSnapshot(id, revision) {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!project) throw new StorageError(404, 'missing_project', '项目不存在');
    const row = this.db.prepare('SELECT * FROM revisions WHERE id = ? AND project_id = ?').get(revision ?? project.head, id);
    if (!row) throw new StorageError(404, 'missing_revision', '项目版本不存在');
    return { id, name: project.name, revision: row.id, parent: row.parent, files: JSON.parse(row.files), message: row.message, created_at: row.created_at };
  }

  scan(id) {
    const files = [];
    const walk = (directory, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === '.godot' || entry.name === '.git') continue;
        const path = projectPath.parse(prefix + entry.name);
        const full = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new StorageError(409, 'symlink', `项目文件不能指向外部路径：${path}`);
        if (entry.isDirectory()) walk(full, `${path}/`);
        else if (entry.isFile()) files.push({ path, ...this.putBlob(readFileSync(full)) });
        else throw new StorageError(409, 'special_file', `不支持特殊文件：${path}`);
      }
    };
    if (lstatSync(this.filesDirectory(id)).isSymbolicLink()) throw new StorageError(409, 'symlink', '项目根目录不能是符号链接');
    walk(this.filesDirectory(id));
    return sorted(files);
  }

  snapshot(id, revision) {
    if (revision) return this.readSnapshot(id, revision);
    this.applyPending(id);
    let current = this.readSnapshot(id);
    const files = this.validateManifest(this.scan(id));
    if (!sameFiles(current.files, files)) {
      // 服务器工具直接修改目录后，为这些修改保存一份历史记录。
      this.transaction(() => this.record(id, current.revision, files, '服务器目录中的修改', false));
      current = this.readSnapshot(id);
    }
    return current;
  }

  history(id) {
    this.snapshot(id);
    return this.db.prepare('SELECT id AS revision, parent, message, created_at FROM revisions WHERE project_id = ? ORDER BY rowid DESC').all(id);
  }

  validateManifest(files) {
    const manifest = sorted(manifestSchema.parse(files));
    if (!manifest.some((file) => file.path === 'project.godot')) throw new StorageError(400, 'missing_config', '项目必须包含 project.godot');
    if (new Set(manifest.map((file) => file.path)).size !== manifest.length) throw new StorageError(400, 'duplicate_path', '文件路径重复');
    const paths = new Set(manifest.map((file) => file.path));
    for (const file of manifest) {
      const parts = file.path.split('/');
      for (let i = 1; i < parts.length; i++) {
        if (paths.has(parts.slice(0, i).join('/'))) throw new StorageError(400, 'path_conflict', '文件与目录路径冲突');
      }
      const path = this.objectPath(file.hash);
      if (!existsSync(path) || statSync(path).size !== file.size) throw new StorageError(400, 'missing_blob', `文件内容尚未上传：${file.path}`);
    }
    return manifest;
  }

  record(id, parent, files, message, apply) {
    const revision = randomUUID();
    this.db.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?)').run(revision, id, parent, JSON.stringify(files), message, new Date().toISOString());
    this.db.prepare('UPDATE projects SET head = ? WHERE id = ?').run(revision, id);
    if (apply) this.db.prepare('INSERT INTO pending VALUES (?)').run(id);
    return this.readSnapshot(id);
  }

  create(name, files) {
    z.string().trim().min(1).max(120).parse(name);
    const id = randomUUID();
    const manifest = this.validateManifest([...files].map(([path, bytes]) => ({ path, ...this.putBlob(bytes) })));
    mkdirSync(this.filesDirectory(id), { recursive: true, mode: 0o700 });
    this.transaction(() => {
      this.db.prepare('INSERT INTO projects VALUES (?, ?, NULL, ?)').run(id, name.trim(), new Date().toISOString());
      this.record(id, null, manifest, '创建项目', true);
    });
    this.applyPending(id);
    return this.readSnapshot(id);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      committed = true;
      return result;
    } finally { if (!committed) this.db.exec('ROLLBACK'); }
  }

  commit({ id, baseRevision, files, message = '保存项目', confirmDeletes = false }) {
    const current = this.snapshot(id);
    const manifest = this.validateManifest(files);
    z.string().max(1000).parse(message);
    if (current.revision !== baseRevision) throw new StorageError(409, 'revision_conflict', '服务器已有新版本，请处理冲突后保存', { revision: current.revision });
    const paths = new Set(manifest.map((file) => file.path));
    const deleted = current.files.filter((file) => !paths.has(file.path)).map((file) => file.path);
    if (deleted.length && !confirmDeletes) throw new StorageError(409, 'deletion_confirmation', '请确认将从项目中删除的文件', { paths: deleted });
    if (sameFiles(current.files, manifest)) return current;
    this.transaction(() => {
      const head = this.db.prepare('SELECT head FROM projects WHERE id = ?').get(id).head;
      if (head !== baseRevision) throw new StorageError(409, 'revision_conflict', '服务器已有新版本，请重新读取', { revision: head });
      this.record(id, head, manifest, message, true);
    });
    this.applyPending(id);
    return this.readSnapshot(id);
  }

  checkedPath(id, path) {
    const directory = this.filesDirectory(id);
    if (lstatSync(directory).isSymbolicLink()) throw new StorageError(409, 'symlink', '项目根目录不能是符号链接');
    const parts = projectPath.parse(path).split('/');
    let full = directory;
    for (const part of parts) {
      full = join(full, part);
      if (existsSync(full) && lstatSync(full).isSymbolicLink()) throw new StorageError(409, 'symlink', `项目路径含有符号链接：${path}`);
    }
    return full;
  }

  applyPending(id) {
    if (!this.db.prepare('SELECT 1 FROM pending WHERE project_id = ?').get(id)) return;
    const target = this.readSnapshot(id);
    const before = new Map((target.parent ? this.readSnapshot(id, target.parent).files : []).map((file) => [file.path, file]));
    const after = new Map(target.files.map((file) => [file.path, file]));
    // pending 记录使服务器重启后能继续完成同一次文件写入。
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      const old = before.get(path);
      const next = after.get(path);
      if (old?.hash === next?.hash) continue;
      const full = this.checkedPath(id, path);
      if (existsSync(full) && lstatSync(full).isDirectory()) {
        if (readdirSync(full).length) throw new StorageError(409, 'disk_conflict', `目录中仍然存在文件：${path}`);
        rmdirSync(full);
      }
      const actual = existsSync(full) ? digest(readFileSync(full)) : undefined;
      if (actual === next?.hash) continue;
      if (actual !== old?.hash) throw new StorageError(409, 'disk_conflict', `服务器目录中的文件在保存期间发生修改：${path}`);
      if (next) this.atomicWrite(full, this.blob(next.hash));
      else {
        unlinkSync(full);
        let parent = dirname(full);
        while (parent !== this.filesDirectory(id) && readdirSync(parent).length === 0) {
          rmdirSync(parent);
          parent = dirname(parent);
        }
        syncDirectory(parent);
      }
    }
    this.db.prepare('DELETE FROM pending WHERE project_id = ?').run(id);
  }

  restore(id, revision, baseRevision) {
    const old = this.snapshot(id, revision);
    return this.commit({ id, baseRevision, files: old.files, confirmDeletes: true, message: `恢复版本 ${revision}` });
  }

  createSession(token) {
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES (?, ?)').run(digest(token), Date.now() + 24 * 3600 * 1000);
  }

  hasSession(token) {
    return typeof token === 'string' && !!this.db.prepare('SELECT 1 FROM sessions WHERE hash = ? AND expires > ?').get(digest(token), Date.now());
  }

  deleteSession(token) {
    if (typeof token === 'string') this.db.prepare('DELETE FROM sessions WHERE hash = ?').run(digest(token));
  }
}
