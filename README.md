# Godot Web Editor

浏览器中的 Godot 4.7.2 编辑器。项目文件保存在服务器的普通目录，浏览器负责编辑和运行；服务器同时提供文件历史、ZIP 导入导出和 MCP 操作接口。

项目基于 [Yeobi1124/godot-web-editor](https://github.com/Yeobi1124/godot-web-editor)，采用 MIT 许可证。

## 运行

需要 Node.js 24 或更新版本。

```bash
npm ci
npm run engine
export GWE_DATA_DIR="$PWD/data"
export GWE_ORIGIN="http://localhost:8788"
export GWE_TOKEN="$(openssl rand -hex 32)"
npm start
```

在浏览器打开 `http://localhost:8788`，使用 `GWE_TOKEN` 登录。访问密钥应通过进程管理器的环境变量持久配置。默认仅监听 `127.0.0.1`；监听其他地址时设置 `HOST`，端口通过 `PORT` 配置。通过域名访问时需要 HTTPS，并将 `GWE_ORIGIN` 设置为实际页面地址。

`npm run engine` 下载官方 Godot Web 编辑器并校验 SHA-256。引擎文件保存在 `.cache/engine/`。

## 项目文件

每个项目的当前文件保存在：

```text
data/projects/<项目 UUID>/files/
```

该目录直接包含 `project.godot`、场景、脚本和素材，可以使用服务器上的 Godot、Git、编辑器或 AI Agent 直接操作。服务器在下一次读取项目时检测这些文件的修改，保存历史并向网页提供更新。`.godot/` 和 `.git/` 留在服务器目录中，不会发送到浏览器。

服务器数据目录还包含：

- `objects/`：按内容 SHA-256 保存的普通文件，用于上传和历史版本。
- `metadata.sqlite`：项目索引、版本清单、会话及待完成写入记录，文件内容保存在文件系统。
- `staging/`：原子写入期间的临时文件。

应使用单个服务进程管理同一个数据目录。停止服务后备份整个 `GWE_DATA_DIR` 可以同时保留工程文件、历史和元数据。`objects/` 保留历史内容，当前不会自动清除旧版本。

## 浏览器保存行为

编辑器和游戏的 `persistentPaths` 均为空。项目文件不写入 IndexedDB 或 localStorage。登录状态使用 HttpOnly Cookie，Godot 引擎文件可以由浏览器 HTTP 缓存保存。

编辑器每两秒检查一次文件修改，保存打开的场景，将变化的文件上传服务器，并提交包含版本号的文件清单。页面显示“已保存到服务器”时，该版本已经完成服务器文件写入。网络错误或冲突会显示错误并停止自动保存；处理后点击“保存到服务器”继续。

尚未得到服务器确认的修改只存在于当前编辑器内存。关闭浏览器会丢失这些修改，因此应确认保存状态后离开。清除网站数据或更换浏览器后，可以重新登录并打开服务器上的项目。

不同文件的并发修改自动合并。同一文件两边同时修改时，页面要求选择当前编辑器内容或服务器内容。服务器拒绝基于旧版本的覆盖请求。删除文件需要明确确认，网页和 MCP 都执行服务器上的相同检查。

## 项目操作

- 新建项目或上传包含一个 Godot 项目的 ZIP。
- 使用 Godot 编辑场景与脚本，或使用网页文件面板编辑文本文件。
- 查看版本历史、下载任意版本、恢复到指定版本。恢复会产生新的历史版本。
- 在浏览器运行游戏、查看日志、执行项目测试和 GDScript 检查。

上传接口接受最多 256 MiB 的单文件或 ZIP；ZIP 解压后最多 512 MiB。项目大小仍受浏览器内存和 Web Godot 能力约束。服务器游戏运行使用独立 iframe，启动时从编辑器内存复制项目与导入缓存，停止时释放整个游戏页面。

## MCP

地址为服务器的 `/mcp`，客户端需要携带：

```http
Authorization: Bearer <GWE_TOKEN>
```

通过 `list_projects` 获取项目 UUID。文件操作和版本信息由服务器处理，编辑器关闭时也可使用。写入必须提供 `get_status` 或 `read_file` 返回的 `revision`，参数名为 `base_revision`；删除还需要 `confirm_deletes: true`。

打开项目后，网页通过 WebSocket 连接服务器。场景操作、截图、游戏运行、日志和测试工具发送到这个浏览器中的 Godot。项目同时在多个浏览器打开时，编辑器控制工具要求保留一个连接，避免请求发送到不确定的编辑器。

服务使用单个共享访问密钥管理工作区，持有密钥的客户端可以访问全部项目。它适用于个人或相互信任的团队工作区。

页面也提供 `window.godotAI` 和浏览器支持时的 WebMCP 接口。

## 验证

```bash
npm test
npm run engine
npx playwright install chromium
npm run test:server-e2e
```

服务器测试使用实际 HTTP 服务、文件系统、SQLite 和 MCP 客户端。浏览器测试使用真实 Chromium 和 Godot，检查导入、保存、游戏运行、脚本检查、并发冲突、服务器重启及新浏览器恢复。测试不替换网络服务或 Godot 执行结果。

可以通过 `CHROME_BIN` 指定 Chromium 路径。`GWE_BROWSER_TMP` 指定 Chromium 临时目录；目录应位于允许写入的位置，且路径足够短，以满足 Unix socket 的路径长度限制。

实现细节见 [架构说明](docs/ARCHITECTURE.md)。Cloudflare Worker 入口及其配置保留在 `worker/` 和 [CLOUD-SETUP.md](docs/CLOUD-SETUP.md)，自托管文件服务使用本文所述入口。
