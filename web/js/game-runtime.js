export class GameFrame {
  constructor({ canvas, onPrint, onPrintError, onExit }) {
    this.onExit = onExit;
    this.frame = document.createElement('iframe');
    this.frame.title = 'Godot 游戏';
    this.frame.style.cssText = 'width:100%;height:100%;border:0';
    canvas.hidden = true;
    canvas.parentElement.append(this.frame);
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.handle = (event) => {
      if (event.origin !== location.origin || event.source !== this.frame.contentWindow) return;
      const { type, data } = event.data;
      if (type === 'ready') this.send({ type: 'initialize' });
      else if (type === 'initialized') this.resolveReady();
      else if (type === 'started') this.resolveStarted?.();
      else if (type === 'log') (data.level === 'error' ? onPrintError : onPrint)(data.text);
      else if (type === 'exit') this.finish(data);
      else if (type === 'error') {
        this.rejectReady(new Error(data));
        this.rejectStarted?.(new Error(data));
        onPrintError(data);
        this.finish(1);
      }
    };
    window.addEventListener('message', this.handle);
    this.frame.src = 'game.html';
  }

  send(message, transfer = []) { this.frame.contentWindow.postMessage(message, location.origin, transfer); }
  init() { return this.ready; }
  copyToFS(path, bytes) {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.send({ type: 'file', path, bytes: buffer }, [buffer]);
  }
  start({ args }) {
    return new Promise((resolve, reject) => {
      this.resolveStarted = resolve;
      this.rejectStarted = reject;
      this.send({ type: 'start', args });
    });
  }
  requestQuit() { this.finish(0); }
  finish(code) {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener('message', this.handle);
    this.frame.remove();
    this.onExit(code);
  }
}
