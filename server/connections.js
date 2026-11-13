import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { StorageError } from './store.js';

export class EditorConnections {
  constructor(server, origin) {
    this.tickets = new Map();
    this.connections = new Map();
    this.pending = new Map();
    this.ws = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url, origin);
      const ticket = this.tickets.get(url.searchParams.get('ticket'));
      this.tickets.delete(url.searchParams.get('ticket'));
      if (url.pathname !== '/live' || request.headers.origin !== origin || !ticket || ticket.expires < Date.now()) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      this.ws.handleUpgrade(request, socket, head, (connection) => this.attach(connection, ticket.project));
    });
  }

  ticket(project) {
    for (const [id, ticket] of this.tickets) if (ticket.expires < Date.now()) this.tickets.delete(id);
    const id = randomUUID();
    this.tickets.set(id, { project, expires: Date.now() + 10000 });
    return id;
  }

  attach(socket, project) {
    this.connections.set(socket, project);
    socket.on('message', (bytes) => {
      let message;
      try { message = JSON.parse(bytes.toString()); }
      catch { socket.close(1007, 'Invalid JSON'); return; }
      const pending = this.pending.get(message.id);
      if (pending?.socket !== socket) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    socket.on('close', () => {
      this.connections.delete(socket);
      for (const [id, request] of this.pending) {
        if (request.socket !== socket) continue;
        clearTimeout(request.timer);
        this.pending.delete(id);
        request.reject(new Error('编辑器连接已关闭'));
      }
    });
    socket.on('error', () => socket.terminate());
  }

  changed(project) {
    for (const [socket, id] of this.connections) {
      if (id === project && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'changed' }));
    }
  }

  call(project, name, args) {
    const sockets = [...this.connections].filter(([socket, id]) => id === project && socket.readyState === WebSocket.OPEN).map(([socket]) => socket);
    if (sockets.length !== 1) throw new StorageError(409, 'editor_connection', sockets.length ? '项目在多个浏览器中打开，请保留一个编辑器后调用此工具' : '这个工具需要打开项目编辑器');
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const socket = sockets[0];
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('编辑器操作超时'));
      }, 150000);
      this.pending.set(id, { resolve, reject, timer, socket });
      socket.send(JSON.stringify({ type: 'call', id, name, args }));
    });
  }

  close() {
    for (const socket of this.connections.keys()) socket.terminate();
    this.ws.close();
  }
}
