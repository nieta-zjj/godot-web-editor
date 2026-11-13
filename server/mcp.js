import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { toMcpContent } from '../web/js/tool-defs.js';
import { serverToolDescriptors } from '../web/js/server-tool-defs.js';
import { looksLikeText } from '../web/js/util.js';
import { projectPath, StorageError } from './store.js';

export function createMcp(store, connections) {
  const server = new McpServer({ name: 'godot-server-editor', version: '0.3.0' });
  server.registerTool('list_projects', { description: '列出服务器保存的 Godot 项目。', inputSchema: z.object({}) }, async () => toMcpContent({ projects: store.list() }));
  for (const definition of serverToolDescriptors()) {
    const schema = z.fromJSONSchema(definition.inputSchema).extend({
      project: z.string().uuid().describe('list_projects 返回的项目 id'),
      base_revision: z.string().uuid().optional().describe('修改文件时必须提供 read_file 或 get_status 返回的 revision'),
      confirm_deletes: z.boolean().optional().describe('用户明确确认删除时设置为 true'),
    });
    server.registerTool(definition.name, { description: definition.description, inputSchema: schema, annotations: definition.annotations }, async (args) => {
      const { project, base_revision, confirm_deletes, ...input } = args;
      const snapshot = store.snapshot(project);
      let result;
      switch (definition.name) {
        case 'get_status':
          result = { storage: 'server', project, revision: snapshot.revision, name: snapshot.name, files: snapshot.files.length };
          break;
        case 'list_files':
          result = { revision: snapshot.revision, files: snapshot.files.filter((file) => !input.dir || file.path.startsWith(`${projectPath.parse(input.dir)}/`)) };
          break;
        case 'read_file': {
          const path = projectPath.parse(input.path.replace(/^res:\/\//, ''));
          const file = snapshot.files.find((file) => file.path === path);
          if (!file) throw new StorageError(404, 'missing_file', '文件不存在');
          const bytes = store.blob(file.hash);
          result = { revision: snapshot.revision, path, encoding: looksLikeText(bytes) ? 'utf8' : 'base64', content: bytes.toString(looksLikeText(bytes) ? 'utf8' : 'base64') };
          break;
        }
        case 'write_files':
        case 'delete_files': {
          if (!base_revision) throw new Error('请提供读取文件时的 base_revision');
          const files = new Map(snapshot.files.map((file) => [file.path, file]));
          if (definition.name === 'write_files') {
            for (const file of input.files) {
              const path = projectPath.parse(file.path.replace(/^res:\/\//, ''));
              files.set(path, { path, ...store.putBlob(Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8')) });
            }
          } else {
            for (const path of input.paths) files.delete(projectPath.parse(path.replace(/^res:\/\//, '')));
          }
          result = store.commit({ id: project, baseRevision: base_revision, files: [...files.values()], message: input.commit_message ?? 'MCP 修改项目', confirmDeletes: confirm_deletes === true });
          connections.changed(project);
          break;
        }
        default:
          result = await connections.call(project, definition.name, input);
      }
      return toMcpContent(result);
    });
  }
  return server;
}

export function mcpHandler(store, connections) {
  return async (request, response) => {
    const server = createMcp(store, connections);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  };
}
