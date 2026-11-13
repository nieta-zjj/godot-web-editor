import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { z, ZodError } from 'zod';
import { ProjectStore, StorageError, digest } from './store.js';
import { prepareProject, importZip, exportZip } from './projects.js';
import { EditorConnections } from './connections.js';
import { mcpHandler } from './mcp.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const COOKIE = 'gwe_server_session';
const sameSecret = (left, right) => timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)));

export function createApplication({ dataDirectory, token, origin, engineDirectory = join(root, '.cache/engine') }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('GWE_TOKEN 至少需要 32 个字符');
  const publicOrigin = new URL(origin).origin;
  const store = new ProjectStore(dataDirectory);
  const app = express();
  const server = createServer(app);
  const connections = new EditorConnections(server, publicOrigin);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store' });
    if (req.headers.origin && req.headers.origin !== publicOrigin) return res.status(403).json({ error: '请求来源不匹配' });
    next();
  });
  app.use(cookieParser());
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.post('/api/session', express.json({ limit: '4kb' }), (req, res) => {
    if (req.get('X-GWE') !== '1' || typeof req.body?.token !== 'string' || !sameSecret(req.body.token, token)) return res.status(401).json({ error: '访问密钥错误' });
    const session = randomBytes(32).toString('base64url');
    store.createSession(session);
    res.cookie(COOKIE, session, { httpOnly: true, secure: publicOrigin.startsWith('https:'), sameSite: 'strict', maxAge: 86400000, path: '/' });
    res.json({ authenticated: true });
  });
  const authorize = (req, res, next) => {
    const bearer = req.get('Authorization');
    const bearerAuth = bearer?.startsWith('Bearer ') && sameSecret(bearer.slice(7), token);
    if (!bearerAuth && !store.hasSession(req.cookies[COOKIE])) return res.status(401).json({ error: '请登录服务器' });
    if (!bearerAuth && !['GET', 'HEAD'].includes(req.method) && req.get('X-GWE') !== '1') return res.status(403).json({ error: '请求缺少来源校验' });
    next();
  };
  app.use('/api', authorize);
  app.get('/api/session', (_req, res) => res.json({ authenticated: true }));
  app.delete('/api/session', (req, res) => {
    store.deleteSession(req.cookies[COOKIE]);
    res.clearCookie(COOKIE, { path: '/' });
    res.sendStatus(204);
  });
  app.get('/api/projects', (_req, res) => res.json({ projects: store.list() }));
  app.post('/api/projects', express.json({ limit: '4kb' }), async (req, res) => {
    const name = z.string().trim().min(1).max(120).parse(req.body?.name);
    res.status(201).json(store.create(name, await prepareProject(name)));
  });
  app.post('/api/import', express.raw({ type: 'application/zip', limit: '256mb' }), async (req, res) => {
    const name = z.string().trim().min(1).max(120).parse(req.query.name);
    res.status(201).json(store.create(name, await prepareProject(name, importZip(req.body))));
  });
  app.get('/api/projects/:id', (req, res) => res.json(store.snapshot(req.params.id, req.query.revision)));
  app.get('/api/projects/:id/history', (req, res) => res.json({ revisions: store.history(req.params.id) }));
  app.get('/api/projects/:id/archive', (req, res) => {
    const snapshot = store.snapshot(req.params.id, req.query.revision);
    res.type('application/zip').attachment(`${req.params.id}.zip`).send(exportZip(store, snapshot));
  });
  app.get('/api/projects/:id/blobs/:hash', (req, res) => {
    const snapshot = store.snapshot(req.params.id, req.query.revision);
    if (!snapshot.files.some((file) => file.hash === req.params.hash)) throw new StorageError(404, 'missing_file', '该版本中没有这个文件');
    res.type('application/octet-stream').send(store.blob(req.params.hash));
  });
  app.post('/api/projects/:id/blobs', express.raw({ type: 'application/octet-stream', limit: '256mb' }), (req, res) => {
    store.snapshot(req.params.id);
    if (!Buffer.isBuffer(req.body)) throw new StorageError(400, 'invalid_body', '请上传二进制文件内容');
    res.status(201).json(store.putBlob(req.body));
  });
  app.post('/api/projects/:id/revisions', express.json({ limit: '8mb' }), (req, res) => {
    const body = z.object({ baseRevision: z.string().uuid(), files: z.array(z.unknown()), message: z.string().max(1000).optional(), confirmDeletes: z.boolean().optional() }).parse(req.body);
    const result = store.commit({ ...body, id: req.params.id });
    connections.changed(req.params.id);
    res.json(result);
  });
  app.post('/api/projects/:id/restore', express.json({ limit: '4kb' }), (req, res) => {
    const body = z.object({ revision: z.string().uuid(), baseRevision: z.string().uuid() }).parse(req.body);
    const result = store.restore(req.params.id, body.revision, body.baseRevision);
    connections.changed(req.params.id);
    res.json(result);
  });
  app.post('/api/projects/:id/connect', (req, res) => {
    store.snapshot(req.params.id);
    res.json({ ticket: connections.ticket(req.params.id) });
  });
  app.post('/mcp', authorize, express.json({ limit: '256mb' }), mcpHandler(store, connections));
  app.get('/build-info.json', async (_req, res) => {
    const wasm = await stat(join(engineDirectory, 'godot.editor.wasm'));
    res.json({ app: '0.3.0', godot: '4.7.2', storage: 'server', wasmSize: wasm.size });
  });
  app.get('/', (_req, res) => res.sendFile(join(root, 'web/server.html')));
  app.use(express.static(engineDirectory, { index: false, maxAge: '1h' }));
  app.use(express.static(join(root, 'web'), { index: false }));
  app.use((err, _req, res, _next) => {
    const status = err instanceof ZodError ? 400 : err.status ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? '服务器操作失败，请检查服务日志' : err.message, code: err.code, ...err.details });
  });
  return { server, store, connections, close: async () => {
    connections.close();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
  } };
}
