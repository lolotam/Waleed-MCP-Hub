import type { Connector } from '@waleed/contracts';

export const syntheticConnector: Connector = {
  id: 'synthetic',
  name: 'Synthetic MCP',
  description: '<img src=x onerror=alert(1)>',
  executionMode: 'native',
  transport: 'stdio',
  executable: 'C:\\Synthetic Path\\fixture.exe',
  arguments: ['--label', 'Case Sensitive', '$(never-run)', 'Unicode-أهلا'],
  secretBindings: {},
  headerBindings: {},
  trustApproval: null,
  enabled: true,
  revision: 1,
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:00.000Z',
};
