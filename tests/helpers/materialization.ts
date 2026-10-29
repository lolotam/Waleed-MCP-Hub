import {
  createMaterializer,
  type ManagedFiles,
  type DockerProfiles,
} from '@waleed/hub-core';
import { hashBytes } from '../../packages/hub-core/src/runtime/registry.js';

export function managedFixture() {
  const disk = new Map<string, string>();
  const profiles = new Map<string, string>();
  const files: ManagedFiles = {
    path(scope, name) {
      return `C:\\Synthetic\\${scope}\\${name}`;
    },
    async read(scope, name) {
      return disk.get(`${scope}:${name}`) ?? null;
    },
    async write(scope, name, expected, contents) {
      const key = `${scope}:${name}`;
      const current = disk.get(key) ?? null;
      if ((current === null ? null : hashBytes(current)) !== expected)
        throw new Error('Synthetic CAS mismatch.');
      if (contents === null) disk.delete(key);
      else disk.set(key, contents);
    },
  };
  const docker: DockerProfiles = {
    async read(id) {
      return profiles.get(id) ?? null;
    },
    async import(id, json) {
      profiles.set(id, json);
    },
    async remove(id) {
      profiles.delete(id);
    },
  };
  return {
    files,
    docker,
    disk,
    profiles,
    materializer: createMaterializer({
      files,
      docker,
      nodeExecutable: 'C:\\Synthetic\\node.exe',
      launcherModuleUrl: 'file:///C:/Synthetic/dist/runtime/launcher.js',
      registryPath: 'C:\\Synthetic\\state.json',
    }),
  };
}
