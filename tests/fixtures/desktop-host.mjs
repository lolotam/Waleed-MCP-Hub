import { startDesktop } from '../../scripts/desktop-runtime.mjs';
import { fileURLToPath } from 'node:url';
const desktop = await startDesktop({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  directory: process.env.HUB_DATA_DIR,
  port: 4196,
  background: process.env.HUB_TEST_BACKGROUND === '1',
  preferencesChanged(value) {
    if (process.env.HUB_TEST_BACKGROUND === '1')
      process.send?.({ preferences: value });
  },
  environment: { ...process.env, HUB_DISCOVERY_MODE: 'disabled' },
  openWindow(launchUrl) {
    process.send?.({ launchUrl, pid: desktop.pid });
  },
});
if (desktop.reused) {
  process.send?.({ reused: true });
  process.disconnect?.();
} else {
  if (process.env.HUB_TEST_BACKGROUND === '1')
    process.send?.({ background: true, pid: desktop.pid });
  process.on('message', (message) => {
    if (message === 'shutdown') desktop.stop();
    if (message === 'open') void desktop.open();
    if (message === 'health') desktop.checkHealth();
  });
  await desktop.closed;
  process.disconnect?.();
}
