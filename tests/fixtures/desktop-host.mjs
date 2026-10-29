import { startDesktop } from '../../scripts/desktop-runtime.mjs';
import { fileURLToPath } from 'node:url';
const desktop = await startDesktop({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  directory: process.env.HUB_DATA_DIR,
  port: 4196,
  environment: { ...process.env, HUB_DISCOVERY_MODE: 'disabled' },
  openWindow(launchUrl) {
    process.send?.({ launchUrl, pid: desktop.pid });
  },
});
if (desktop.reused) {
  process.send?.({ reused: true });
  process.disconnect?.();
} else {
  process.on('message', (message) => {
    if (message === 'shutdown') desktop.stop();
  });
  await desktop.closed;
  process.disconnect?.();
}
