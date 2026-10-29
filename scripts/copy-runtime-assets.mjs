import { copyFile, mkdir } from 'node:fs/promises';

const source = new URL(
  '../packages/hub-core/src/adapters/native/windows/',
  import.meta.url,
);
const destination = new URL(
  '../packages/hub-core/dist/adapters/native/windows/',
  import.meta.url,
);
await mkdir(destination, { recursive: true });
for (const name of ['host.ps1', 'ProcessHost.cs'])
  await copyFile(new URL(name, source), new URL(name, destination));
console.info(
  'Copied reviewed Windows process-host assets into the core build.',
);
const secrets = new URL(
  '../packages/hub-core/dist/adapters/secrets/',
  import.meta.url,
);
await mkdir(secrets, { recursive: true });
const integrations = new URL(
  '../packages/hub-core/dist/integrations/',
  import.meta.url,
);
await mkdir(integrations, { recursive: true });
await copyFile(
  new URL(
    '../packages/hub-core/src/integrations/private-path.ps1',
    import.meta.url,
  ),
  new URL('private-path.ps1', integrations),
);
await copyFile(
  new URL(
    '../packages/hub-core/src/adapters/secrets/dpapi.ps1',
    import.meta.url,
  ),
  new URL('dpapi.ps1', secrets),
);
