const paths = {
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
  play: 'M8 5v14l11-7L8 5Z',
  edit: 'M4 20h4L20 8l-4-4L4 16v4Z',
  key: 'M15.5 8.5a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM11 12l9 9m-3-3 2-2m-5 5 2-2',
  trash: 'M4 7h16M9 7V5h6v2m-8 0 1 13h8l1-13M10 11v5M14 11v5',
  power: 'M12 3v9M6.9 6.9a7.5 7.5 0 1 0 10.2 0',
  download: 'M12 4v10m-4-4 4 4 4-4M5 19h14',
  upload: 'M12 20V10m-4 4 4-4 4 4M5 5h14',
  refresh: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
  filter: 'M4 6h16l-6 7v5l-4 2v-7L4 6Z',
  package: 'M12 3 3 8v8l9 5 9-5V8l-9-5Zm0 0v18M3 8l9 5 9-5',
} as const;
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
