// Reproduce vitejs/vite#18224 with a real watcher, after its first close.
import { fileURLToPath } from 'node:url';

export default function lateWatch() {
  const file = fileURLToPath(new URL('../../../late-watch.txt', import.meta.url));
  let firstClosed;
  const closed = new Promise((resolve) => { firstClosed = resolve; });
  let watcher;
  let added = false;
  return {
    name: 'late-watch-regression',
    configureServer(server) {
      watcher = server.watcher;
      const close = watcher.close.bind(watcher);
      watcher.close = async () => { await close(); firstClosed(); };
    },
    async closeBundle() {
      if (added) return; // Vite has both client and SSR environments.
      added = true;
      await closed;
      this.addWatchFile(file);
      const deadline = Date.now() + 3000;
      while (!Object.values(watcher.getWatched()).some((files) => files.includes('late-watch.txt'))) {
        if (Date.now() >= deadline) throw new Error('Late watcher fixture did not register');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      console.error('Late watcher registered after first close');
    },
  };
}
