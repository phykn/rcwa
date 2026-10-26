// Private foreground editor runner. No npm shell, installations or browser open.
import { createServer, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let server;
let stopping = false;
let startup = Promise.resolve();
let closing;
const close = () => {
  stopping = true;
  closing ??= (async () => {
    // Vite caches close(). Calling it before listen() settles can otherwise
    // leave a listener that opens afterward outside that cached close promise.
    try { await startup; } catch { /* Reported by the startup owner below. */ }
    if (server) {
      await server.close();
      // Vite closes watchers concurrently with in-flight plugin work. A late
      // addWatchFile can reopen Chokidar (vitejs/vite#18224). Close once more
      // after those plugins have drained so Node can exit naturally.
      await server.watcher.close();
    }
    process.stdin.pause();
  })();
  return closing;
};
process.stdin.on('data', () => { void close(); });
process.stdin.on('end', () => { void close(); });
process.stdin.resume();
process.on('SIGINT', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
// Ctrl+Break is console-wide on Windows; the supervisor's pipe owns stopping.
if (process.platform === 'win32') process.on('SIGBREAK', () => {});
const log = (message) => console.error(message);
const logger = {
  info: log, warn: log, warnOnce: log, error: log, clearScreen() {},
  hasWarned: false, hasErrorLogged() { return false; },
};
startup = (async () => {
  const env = loadEnv('development', root, 'VITE_');
  if (env.VITE_API_BASE_URL) {
    throw new Error('Clear VITE_API_BASE_URL in your shell and frontend .env files for local UI + API.');
  }
  server = await createServer({
    root, mode: 'development', configFile: `${root}vite.config.ts`, customLogger: logger,
    server: {
      host: '127.0.0.1', port: 5173, strictPort: true, open: false,
      proxy: { '/api': 'http://127.0.0.1:8000' },
    },
  });
  if (!stopping) await server.listen();
})();
try {
  await startup;
  if (stopping) await close();
  else process.stdout.write(`${JSON.stringify({ event: 'ready' })}\n`);
} catch (error) {
  console.error(`Editor startup failed: ${error.message}`);
  process.exitCode = 1;
  await close();
}
