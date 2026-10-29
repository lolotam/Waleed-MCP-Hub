import { StateSchema, type HubState } from '@waleed/contracts';

export interface StateStore {
  read(): Promise<HubState>;
  write(expectedRevision: number, next: HubState): Promise<void>;
  close(): Promise<void>;
}

export function emptyState(): HubState {
  return StateSchema.parse({
    schemaVersion: 1,
    revision: 0,
    connectors: [],
    profiles: [],
    secretReferences: [],
    activity: [],
  });
}
