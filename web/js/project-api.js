// ProjectAPI: 프로젝트를 다루는 도구 모음. 모든 AI 진입 경로가 이 정의 하나를 공유한다.
//
//   window.godotAI (페이지 JS)        ─┐
//   WebMCP (navigator.modelContext)  ─┼─> ProjectAPI.call(name, args)
//   DOM AI 패널                       ─┤
//   Claude (MCP, Worker → mcp-link.js) ─┘
//
// 도구의 이름/설명/스키마는 tool-defs.js(Worker와 공용)에 있고, 여기서는 브라우저 쪽 처리만 붙인다.
// 결과는 JSON 직렬화 가능한 객체이며, 이미지는 { type: 'image', mimeType, data(base64) } 형태로 돌려준다.

import * as idb from './idbfs.js';
import { MassDeleteError } from './sync.js';
import { TOOL_DEFS, toDescriptor } from './tool-defs.js';
import { serverToolDescriptors } from './server-tool-defs.js';
import { base64ToBytes, bytesToBase64, looksLikeText, normalizeProjectPath, shortSha, utf8Decode } from './util.js';

export class ToolError extends Error {}

export class ProjectAPI extends EventTarget {
  #handlers = new Map();

  constructor({ sync, bridge, logs, host, info }) {
    super();
    this.sync = sync;
    this.bridge = bridge;
    this.logs = logs;
    this.host = host;
    this.info = info; // { owner, repo, branch, projectDir, appVersion, godotVersion }
    this.#registerHandlers();
    for (const d of TOOL_DEFS) if (!this.#handlers.has(d.name)) throw new Error(`도구 처리 함수가 없습니다: ${d.name}`);
  }

  /** MCP tools/list 형식의 도구 목록 */
  toolDescriptors() {
    return this.info.storage === 'server' ? serverToolDescriptors() : TOOL_DEFS.map(toDescriptor);
  }

  async call(name, args = {}) {
    const def = TOOL_DEFS.find((d) => d.name === name);
    const handler = this.#handlers.get(name);
    if (!def || !handler) throw new ToolError(`알 수 없는 도구: ${name}. 사용 가능한 도구: ${TOOL_DEFS.map((d) => d.name).join(', ')}`);
    const input = args && typeof args === 'object' ? args : {};
    for (const req of def.inputSchema.required ?? []) {
      if (input[req] === undefined || input[req] === null) throw new ToolError(`${name}: '${req}' 인자가 필요합니다`);
    }
    const result = await handler(input);
    this.dispatchEvent(new CustomEvent('tool-called', { detail: { name, args: input } }));
    return result;
  }

  #path(raw) {
    const p = normalizeProjectPath(raw);
    if (!p) throw new ToolError(`잘못된 경로입니다: ${JSON.stringify(raw)} (프로젝트 안의 상대 경로를 쓰세요)`);
    if (p === '.godot' || p.startsWith('.godot/') || p.startsWith('.git/')) throw new ToolError(`이 경로는 다룰 수 없습니다: ${p}`);
    return p;
  }

  #requireBridge() {
    if (!this.bridge.ready) throw new ToolError('에디터가 아직 준비되지 않았습니다. 에디터 로딩이 끝난 뒤 다시 시도하세요.');
  }

  /**
   * 테스트/스크립트 검사 씬(브리지 애드온의 runner/)을 이 브라우저의 Godot으로 실행하고 결과를 기다린다.
   * 결과는 게임 출력의 "GWE_RESULT {json}" 줄. 게임이 결과 없이 끝나거나 시간이 지나면 출력 끝부분을 돌려준다.
   */
  async #runRunner(mode, filter) {
    this.#requireBridge();
    await this.#ensureGameStopped();
    const since = this.logs.query({ limit: 1 }).at(-1)?.seq ?? 0;
    const TIMEOUT_MS = 120000;
    const done = new Promise((resolve) => {
      let timer = null;
      const finish = (value) => {
        clearTimeout(timer);
        this.logs.removeEventListener('line', onLine);
        this.host.removeEventListener('game-exit', onExit);
        resolve(value);
      };
      const onLine = (e) => {
        const { source, text } = e.detail;
        if (source === 'game' && text.startsWith('GWE_RESULT ')) {
          try {
            finish({ result: JSON.parse(text.slice('GWE_RESULT '.length)) });
          } catch {
            finish({ error: '결과 JSON을 읽지 못했습니다' });
          }
        }
      };
      // 결과 줄보다 종료가 먼저 오는 경우를 위해 잠깐 기다린 뒤 마무리
      const onExit = (e) => setTimeout(() => finish({ exitCode: e.detail?.code ?? null, error: '결과를 출력하기 전에 실행이 끝났습니다' }), 1500);
      timer = setTimeout(() => finish({ error: `시간 초과(${TIMEOUT_MS / 1000}초)` }), TIMEOUT_MS);
      this.logs.addEventListener('line', onLine);
      this.host.addEventListener('game-exit', onExit);
    });
    // 1) 설정 쓰기 + 씬 저장 → 2) 에디터가 IndexedDB에 저장할 때까지 기다림 → 3) 실행
    // (게임은 IndexedDB에서 파일을 읽는다. 방금 쓴 파일이 아직 저장되지 않았으면 예전 내용으로 실행된다)
    const nonce = Math.random().toString(36).slice(2);
    await this.bridge.call('prepare_runner', { mode, filter, nonce }, 30000);
    if (this.host.persistentPaths.length) {
      const cfgPath = `${this.info.projectDir}/.godot/gwe_runner.json`;
      for (let i = 0; i < 100; i++) {
        const bytes = await idb.readFile(cfgPath).catch(() => null);
        if (bytes && utf8Decode(bytes).includes(nonce)) break;
        await new Promise((res) => setTimeout(res, 100));
      }
    }
    await this.bridge.call('play_runner', {}, 30000);
    const r = await done;
    // 실행기 씬은 결과를 찍고 스스로 끝난다. 끝나지 않았으면 정리해서 다음 실행을 막지 않게 한다
    if (!this.host.persistentPaths.length) this.host.stopGame();
    if (!(await this.host.waitGameExit(5000))) await this.#ensureGameStopped();
    await this.bridge.call('stop').catch(() => {}); // 에디터의 "실행 중" 표시도 정리
    const output = this.logs
      .query({ since, limit: 0 })
      .filter((l) => l.source === 'game' && !l.text.startsWith('GWE_RESULT '))
      .map((l) => `${l.level === 'error' ? '[ERROR] ' : ''}${l.text}`);
    if (r.result) return { ...r.result, where: 'browser', output_tail: output.slice(-40) };
    return { ok: false, mode, where: 'browser', error: r.error, exit_code: r.exitCode ?? null, output_tail: output.slice(-80) };
  }

  async #ensureGameStopped() {
    if (!this.host.game) return;
    await this.bridge.call('stop').catch(() => {});
    this.host.stopGame();
    if (!(await this.host.waitGameExit(4000))) this.host.discardGame();
  }

  #on(name, handler) {
    this.#handlers.set(name, handler);
  }

  #registerHandlers() {
    this.#on('get_status', async () => {
      await this.sync.refreshStatus();
      const s = this.sync.status;
      let editor = null;
      if (this.bridge.ready) editor = await this.bridge.call('get_state').catch(() => null);
      return {
        mode: 'editor',
        ...(this.info.storage === 'server'
          ? { storage: 'server', project: this.info.projectId, revision: s.head }
          : { repository: `${this.info.owner}/${this.info.repo}`, branch: this.info.branch, head_commit: s.head }),
        sync_phase: s.phase,
        unsynced_files: s.pending,
        conflicts: s.conflicts,
        remote_changes_waiting: s.remotePending,
        last_error: s.lastError,
        editor_ready: this.bridge.ready,
        editor,
        game_running: !!this.host.game,
        tab_visible: document.visibilityState === 'visible',
        versions: { app: this.info.appVersion, godot: this.info.godotVersion, bridge: this.bridge.version },
      };
    });

    this.#on('list_files', async ({ dir }) => {
      const prefix = dir ? `${this.#path(dir)}/` : '';
      if (this.bridge.ready) {
        const files = await this.bridge.call('list_files', { dir: prefix.replace(/\/$/, '') });
        return { files: files.map((f) => ({ path: f.path, size: f.size })) };
      }
      if (this.info.storage === 'server') this.#requireBridge();
      const local = await idb.readTree(this.info.projectDir);
      return {
        files: [...local.entries()]
          .filter(([p]) => !p.startsWith('.godot/') && p.startsWith(prefix))
          .map(([path, f]) => ({ path, size: f.contents.length })),
      };
    });

    this.#on('read_file', async ({ path }) => {
      const p = this.#path(path);
      let bytes;
      if (this.bridge.ready) {
        const r = await this.bridge.call('read_file', { path: p, encoding: 'base64' });
        bytes = base64ToBytes(r.content);
      } else {
        if (this.info.storage === 'server') this.#requireBridge();
        const f = (await idb.readTree(this.info.projectDir)).get(p);
        if (!f) throw new ToolError(`파일이 없습니다: ${p}`);
        bytes = f.contents;
      }
      return looksLikeText(bytes)
        ? { path: p, encoding: 'utf8', content: utf8Decode(bytes) }
        : { path: p, encoding: 'base64', size: bytes.length, content: bytesToBase64(bytes) };
    });

    this.#on('write_files', async ({ files, commit_message }) => {
      this.#requireBridge();
      if (!Array.isArray(files) || !files.length) throw new ToolError('files 배열이 비어 있습니다');
      const payload = files.map((f) => ({ path: this.#path(f.path), content: String(f.content ?? ''), encoding: f.encoding === 'base64' ? 'base64' : 'utf8' }));
      const res = await this.bridge.call('write_files', { files: payload }, 60000);
      if (commit_message) this.sync.addNote(commit_message);
      this.sync.refreshStatus();
      return res;
    });

    this.#on('delete_files', async ({ paths, commit_message }) => {
      this.#requireBridge();
      if (!Array.isArray(paths) || !paths.length) throw new ToolError('paths 배열이 비어 있습니다');
      const res = await this.bridge.call('delete_files', { paths: paths.map((p) => this.#path(p)) });
      if (commit_message) this.sync.addNote(commit_message);
      this.sync.refreshStatus();
      return res;
    });

    this.#on('get_editor_state', async () => {
      this.#requireBridge();
      return this.bridge.call('get_state');
    });

    this.#on('open_scene', async ({ path }) => {
      this.#requireBridge();
      await this.bridge.call('open_scene', { path: this.#path(path) });
      return { opened: this.#path(path) };
    });

    this.#on('set_main_screen', async ({ name }) => {
      this.#requireBridge();
      await this.bridge.call('set_main_screen', { name });
      return { main_screen: name };
    });

    this.#on('screenshot', async ({ max_width }) => {
      this.#requireBridge();
      const r = await this.bridge.call('screenshot', { max_width: max_width ?? 1024 });
      return { type: 'image', mimeType: r.mime_type, width: r.width, height: r.height, data: r.data };
    });

    this.#on('run_project', async ({ scene }) => {
      this.#requireBridge();
      const arg = !scene ? '' : scene === 'current' ? 'current' : this.#path(scene);
      await this.bridge.call('play', { scene: arg });
      return { started: arg || 'main scene' };
    });

    this.#on('stop_project', async () => {
      if (!this.host.persistentPaths.length) this.host.stopGame();
      if (this.bridge.ready) await this.bridge.call('stop').catch(() => {});
      this.host.stopGame();
      return { stopped: true };
    });

    this.#on('get_logs', async ({ since, level, limit }) => {
      const lines = this.logs.query({ since: since ?? 0, level: level ?? null, limit: limit ?? 200 });
      return { lines: lines.map((l) => `[${l.source}${l.level === 'error' ? ' ERROR' : ''}] ${l.text}`), last_seq: lines.at(-1)?.seq ?? since ?? 0 };
    });

    this.#on('run_tests', async ({ filter, request_id }) => {
      if (request_id) throw new ToolError('request_id는 GitHub Actions 실행 결과용입니다. 웹 에디터가 열려 있으면 request_id 없이 다시 호출하세요.');
      return this.#runRunner('test', filter ?? '');
    });
    this.#on('check_scripts', async () => this.#runRunner('check', ''));

    this.#on('sync_now', async ({ message }) => {
      if (this.info.storage === 'server') {
        this.#requireBridge();
        await this.bridge.call('save_all');
        return this.sync.push(message);
      }
      if (this.bridge.ready) await this.bridge.call('save_all').catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      let res;
      try {
        res = await this.sync.push(message);
      } catch (e) {
        if (e instanceof MassDeleteError) {
          // AI나 자동 저장은 대량 삭제를 올리지 않는다. 사람이 에디터의 '지금 저장'에서 확인해야 한다
          return { commit: null, blocked: true, deletes: e.paths.length, paths: e.paths.slice(0, 30), message: e.message };
        }
        throw e;
      }
      return res.commit ? { commit: res.commit, short: shortSha(res.commit), files: res.files } : { commit: null, message: '올릴 변경이 없습니다' };
    });

    this.#on('pull_remote', async () => this.sync.pull());
  }
}
