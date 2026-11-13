import { resolve } from 'node:path';
import { createApplication } from './app.js';

const port = Number(process.env.PORT ?? 8788);
const host = process.env.HOST ?? '127.0.0.1';
const application = createApplication({
  dataDirectory: resolve(process.env.GWE_DATA_DIR ?? 'data'),
  token: process.env.GWE_TOKEN,
  origin: process.env.GWE_ORIGIN ?? `http://localhost:${port}`,
});
application.server.listen(port, host, () => console.log(`Godot 编辑器服务已启动，端口 ${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await application.close();
  process.exit(0);
});
