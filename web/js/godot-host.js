// Godot 웹 에디터 엔진 실행 관리 (공식 godot.editor.html의 시작 로직을 정리한 것)
/* global Engine */

import { GameFrame } from './game-runtime.js';

export class GodotHost extends EventTarget {
  editor = null;
  game = null;

  constructor({ editorCanvas, gameCanvas, gameLayer, logs, persistentPaths = ['/home/web_user'], prepareGame = async () => {}, prepareEditor = async () => {} }) {
    super();
    this.persistentPaths = persistentPaths;
    this.prepareGame = prepareGame;
    this.prepareEditor = prepareEditor;
    this.editorCanvas = editorCanvas;
    this.gameCanvas = gameCanvas;
    this.gameLayer = gameLayer;
    this.logs = logs;
    this.editorArgs = null;
    this._onEditorExit = null;
  }

  static missingFeatures() {
    const missing = Engine.getMissingFeatures({ threads: true });
    if (!Engine.isWebGLAvailable()) missing.push('WebGL 2');
    return missing;
  }

  #replaceCanvas(canvas) {
    const out = document.createElement('canvas');
    out.id = canvas.id;
    out.className = canvas.className;
    out.tabIndex = canvas.tabIndex;
    canvas.parentNode.replaceChild(out, canvas);
    return out;
  }

  #resizeLoop() {
    let last = '';
    const tick = () => {
      const c = this.editorCanvas;
      const box = c.parentElement.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const key = `${box.width}x${box.height}@${scale}`;
      if (key !== last) {
        c.width = Math.max(1, Math.floor(box.width * scale));
        c.height = Math.max(1, Math.floor(box.height * scale));
        c.style.width = `${box.width}px`;
        c.style.height = `${box.height}px`;
        last = key;
      }
      if (this.game) this.#fitGameCanvas();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** 게임 화면을 비율을 유지한 채 영역에 맞춘다 (프로젝트 해상도보다 크게 늘리지는 않음) */
  #fitGameCanvas() {
    const c = this.gameCanvas;
    if (!c.width || !c.height) return;
    const box = c.parentElement.getBoundingClientRect();
    const scale = Math.min(box.width / c.width, box.height / c.height, 1);
    const w = `${Math.floor(c.width * scale)}px`;
    const h = `${Math.floor(c.height * scale)}px`;
    if (c.style.width !== w) c.style.width = w;
    if (c.style.height !== h) c.style.height = h;
  }

  #gameConfig() {
    return {
      persistentPaths: this.persistentPaths,
      unloadAfterInit: false,
      canvas: this.gameCanvas,
      canvasResizePolicy: 1,
      onPrint: (...a) => this.logs.push('game', 'info', a.join(' ')),
      onPrintError: (...a) => this.logs.push('game', 'error', a.join(' ')),
      onExit: (code) => {
        this.gameCanvas = this.#replaceCanvas(this.gameCanvas);
        this.gameLayer.hidden = true;
        this.game = null;
        this.editorCanvas.focus();
        this.dispatchEvent(new CustomEvent('game-exit', { detail: { code } }));
      },
    };
  }

  /** 에디터가 다른 프로세스 실행을 요청할 때 (게임 실행, 에디터 재시작) */
  #execute(args) {
    const isEditor = args.includes('--editor') || args.includes('-e');
    const isProjectManager = args.includes('--project-manager');
    if (!isEditor && !isProjectManager) {
      if (this.game) {
        this.logs.error('게임이 이미 실행 중입니다. 먼저 종료하세요.');
        return;
      }
      this.gameLayer.hidden = false;
      this.game = this.persistentPaths.length ? new Engine(this.#gameConfig()) : new GameFrame(this.#gameConfig());
      this.game.init().then(async () => {
        await this.prepareGame(this.game);
        await this.game.start({ args, canvas: this.gameCanvas });
        this.gameCanvas.focus();
      }).catch((error) => {
        this.logs.error(error.message);
        this.dispatchEvent(new CustomEvent('game-error', { detail: error }));
      });
      this.dispatchEvent(new Event('game-start'));
      return;
    }
    // 에디터 재시작(프로젝트 다시 불러오기 등): 현재 에디터가 종료되면 같은 캔버스에서 다시 시작
    this._onEditorExit = () => {
      setTimeout(() => {
        this.editor.init().then(async () => {
          await this.prepareEditor(this.editor);
          this._onEditorExit = null;
          this.editor.start({ args, persistentDrops: isProjectManager, canvas: this.editorCanvas });
          this.dispatchEvent(new Event('editor-restart'));
        });
      }, 0);
    };
  }

  /** 엔진 파일(wasm) 로드와 파일 시스템 준비. 이후 copyToFS 사용 가능 */
  async init(onProgress) {
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const concurrency = clamp(navigator.hardwareConcurrency ?? 1, 12, 24);
    this.editor = new Engine({
      unloadAfterInit: false,
      canvas: this.editorCanvas,
      canvasResizePolicy: 0,
      persistentPaths: this.persistentPaths,
      emscriptenPoolSize: concurrency,
      godotPoolSize: Math.floor(concurrency / 3),
      onProgress,
      onPrint: (...a) => this.logs.push('editor', 'info', a.join(' ')),
      onPrintError: (...a) => this.logs.push('editor', 'error', a.join(' ')),
      onExecute: (args) => this.#execute(args),
      onExit: () => {
        this.editorCanvas = this.#replaceCanvas(this.editorCanvas);
        if (this._onEditorExit) this._onEditorExit();
        else this.dispatchEvent(new Event('editor-exit'));
      },
    });
    this.#resizeLoop();
    await this.editor.init('godot.editor');
  }

  async startEditor(projectDir) {
    this.editorArgs = ['--editor', '--path', projectDir, '--single-window'];
    await this.editor.start({ args: this.editorArgs, persistentDrops: false, canvas: this.editorCanvas });
    this.editorCanvas.focus();
  }

  stopGame() {
    if (this.game) this.game.requestQuit();
  }

  /** 게임 종료를 기다린다 (ms 안에 끝나면 true) */
  waitGameExit(ms) {
    if (!this.game) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeEventListener('game-exit', done);
        resolve(false);
      }, ms);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.addEventListener('game-exit', done, { once: true });
    });
  }

  /** 종료 요청에 응답하지 않는 게임 인스턴스를 버리고 다음 실행이 가능하게 한다 */
  discardGame() {
    if (!this.game) return;
    try {
      this.game.requestQuit();
    } catch {
      /* 이미 멈춤 */
    }
    this.gameCanvas = this.#replaceCanvas(this.gameCanvas);
    this.gameLayer.hidden = true;
    this.game = null;
    this.logs.error('게임이 종료 요청에 응답하지 않아 정리했습니다.');
    this.dispatchEvent(new CustomEvent('game-exit', { detail: { code: null, discarded: true } }));
  }
}
