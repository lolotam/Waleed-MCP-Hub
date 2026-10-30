import type { IntegrationAgentId } from '@waleed/contracts';
const paths = {
  terminal: 'M4 4h16v16H4V4Zm3 4 4 4-4 4m6 0h4',
  editor: 'M4 3h16v18H4V3Zm0 5h16M9 8v13',
  windsurf: 'M3 8h12a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h6',
  cline: 'M5 8h14v12H5V8Zm3 5h1m6 0h1M9 17h6M12 3v5M9 3h6',
  roo: 'M5 19 8 9l4 3 4-7 3 3-2 11H5Zm3-10-2-5m6 8-1 5',
  zed: 'M5 5h14L5 19h14M9 9h6',
  gemini: 'M12 2c0 6-4 10-10 10 6 0 10 4 10 10 0-6 4-10 10-10-6 0-10-4-10-10Z',
  goose: 'M6 20h11l2-5-4-3V6a3 3 0 0 0-6 0v7l-4 3 1 4Zm9-14h5M12 5h.01',
  jetbrains:
    'M4 4h16v16H4V4Zm3 12h5M9 7v5a2 2 0 0 1-4 0m8-5h3a2 2 0 0 1 0 4h-3V7Zm0 4h4a2 2 0 0 1 0 4h-4v-4',
  warp: 'm3 7 6 10 3-6 3 6 6-10M3 7h5m8 0h5',
  help: 'M9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 3h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  playground: 'm8 5 7 7-7 7M16 19h5',
  connectors: 'M8 3v4m8-4v4M6 7h12v4a6 6 0 0 1-12 0V7Zm6 10v4',
  agents:
    'M8 6h8a4 4 0 0 1 4 4v8H4v-8a4 4 0 0 1 4-4Zm4-4v4M8 11h.01M16 11h.01M8 15h8',
  profiles: 'M3 7V4h6l2 3h10v13H3V7Z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6',
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Zm-4 9 3 3 5-6',
  plus: 'M12 5v14M5 12h14',
  search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  clock: 'M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  lock: 'M6 10h12v11H6V10Zm3 0V6a3 3 0 0 1 6 0v4',
} as const;
export const agentPresentation: Record<
  IntegrationAgentId,
  { icon: keyof typeof paths; kind: string }
> = {
  opencode: { icon: 'terminal', kind: 'CLI' },
  codex: { icon: 'terminal', kind: 'CLI' },
  'claude-desktop': { icon: 'agents', kind: 'Desktop' },
  claude: { icon: 'terminal', kind: 'CLI' },
  antigravity: { icon: 'editor', kind: 'Editor' },
  vscode: { icon: 'editor', kind: 'Editor' },
  cursor: { icon: 'editor', kind: 'Editor' },
  kimi: { icon: 'terminal', kind: 'CLI' },
  kilo: { icon: 'terminal', kind: 'CLI' },
  windsurf: { icon: 'windsurf', kind: 'Cascade editor' },
  cline: { icon: 'cline', kind: 'VS Code extension' },
  'roo-code': { icon: 'roo', kind: 'VS Code extension' },
  zed: { icon: 'zed', kind: 'Editor' },
  'gemini-cli': { icon: 'gemini', kind: 'CLI' },
  goose: { icon: 'goose', kind: 'Desktop / CLI' },
  jetbrains: { icon: 'jetbrains', kind: 'Shared JSON scope' },
  warp: { icon: 'warp', kind: 'Terminal agent' },
};
export function Icon({
  name,
  size = 20,
}: {
  name: keyof typeof paths;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
