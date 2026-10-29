import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TestTls {
  key: string;
  cert: string;
  ca: string;
  dispose(): Promise<void>;
}

export function findOpenSsl(): string {
  const pathEnv = process.env.PATH ?? '';
  const pathDirs = pathEnv.split(delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const full = join(dir, `openssl${ext}`);
      try {
        if (statSync(full).isFile()) {
          return full;
        }
      } catch {
        // Continue searching
      }
    }
  }

  const fallbacks = [
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL\\bin\\openssl.exe',
  ];
  for (const candidate of fallbacks) {
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Continue searching
    }
  }

  // If git is on PATH, check its companion usr/bin/openssl.exe
  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const gitPath = join(dir, `git${ext}`);
      try {
        if (statSync(gitPath).isFile()) {
          const companion = resolve(dir, '..', 'usr', 'bin', 'openssl.exe');
          if (statSync(companion).isFile()) {
            return companion;
          }
        }
      } catch {
        // Continue searching
      }
    }
  }

  throw new Error('OpenSSL executable not found on PATH or fallback locations');
}

export async function createTestTls(): Promise<TestTls> {
  const openssl = findOpenSsl();
  const dir = await mkdtemp(join(tmpdir(), 'wmh-tls-'));

  try {
    const caKeyPath = join(dir, 'ca.key');
    const caCrtPath = join(dir, 'ca.crt');
    const serverKeyPath = join(dir, 'server.key');
    const serverCsrPath = join(dir, 'server.csr');
    const serverExtPath = join(dir, 'server.ext');
    const serverCrtPath = join(dir, 'server.crt');

    await execFileAsync(
      openssl,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        caKeyPath,
        '-out',
        caCrtPath,
        '-days',
        '1',
        '-subj',
        '/CN=Test CA',
      ],
      { shell: false },
    );

    await execFileAsync(
      openssl,
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        serverKeyPath,
        '-out',
        serverCsrPath,
        '-subj',
        '/CN=localhost',
      ],
      { shell: false },
    );

    await writeFile(
      serverExtPath,
      'subjectAltName = DNS:localhost, IP:127.0.0.1\n',
      'utf8',
    );

    await execFileAsync(
      openssl,
      [
        'x509',
        '-req',
        '-in',
        serverCsrPath,
        '-CA',
        caCrtPath,
        '-CAkey',
        caKeyPath,
        '-CAcreateserial',
        '-out',
        serverCrtPath,
        '-days',
        '1',
        '-extfile',
        serverExtPath,
      ],
      { shell: false },
    );

    const key = await readFile(serverKeyPath, 'utf8');
    const cert = await readFile(serverCrtPath, 'utf8');
    const ca = await readFile(caCrtPath, 'utf8');

    return {
      key,
      cert,
      ca,
      dispose: async () => {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
