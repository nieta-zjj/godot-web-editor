const send = (type, data) => parent.postMessage({ type, data }, location.origin);
let engine;
window.addEventListener('message', async (event) => {
  if (event.source !== parent || event.origin !== location.origin) return;
  try {
    if (event.data.type === 'initialize') {
      if (engine) throw new Error('游戏实例已经初始化');
      engine = new Engine({
        persistentPaths: [], canvas: document.getElementById('game'), canvasResizePolicy: 2,
        onPrint: (...args) => send('log', { level: 'info', text: args.join(' ') }),
        onPrintError: (...args) => send('log', { level: 'error', text: args.join(' ') }),
        onExit: (code) => send('exit', code),
      });
      await engine.init('godot.editor');
      send('initialized');
    } else if (event.data.type === 'file') {
      engine.copyToFS(event.data.path, event.data.bytes);
    } else if (event.data.type === 'start') {
      await engine.start({ args: event.data.args });
      document.getElementById('game').focus();
      send('started');
    }
  } catch (error) { send('error', error.message); }
});
send('ready');
