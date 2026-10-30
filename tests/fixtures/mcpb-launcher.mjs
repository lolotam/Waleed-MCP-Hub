// Synthetic regression driver: approved native launchers must verify bundles too.
import { pathToFileURL } from 'node:url';
import { runNativeLauncher } from '../../packages/hub-core/src/runtime/launcher.ts';
await runNativeLauncher(pathToFileURL(process.argv[2]), process.argv[3]);
