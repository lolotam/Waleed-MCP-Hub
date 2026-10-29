export type ReadStatus =
  'read' | 'missing' | 'inaccessible' | 'too_large' | 'unsafe';
export type ReadResult =
  | { status: 'read'; text: string; fingerprint: string }
  | { status: Exclude<ReadStatus, 'read'> };
export interface DiscoveryPorts {
  find(names: readonly string[], signal: AbortSignal): Promise<string[]>;
  read(path: string, signal: AbortSignal): Promise<ReadResult>;
  run(
    executable: string,
    arguments_: readonly string[],
    environment: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; output: string }>;
}
export interface DiscoverySettings {
  fixture?: boolean;
  home: string;
  pilotDirectory: string;
  profileId: string;
  environment: Readonly<Record<string, string | undefined>>;
  nodeVersion: string;
  platform: string;
}
