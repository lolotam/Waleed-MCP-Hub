// Synthetic data only. Never copy the existing pilot source into import tests.
export const importSecret = ['SYNTHETIC', 'IMPORT', 'PRIVATE', 'VALUE'].join(
  '-',
);
export const mixedImport = {
  mcpServers: {
    'Remote service': {
      url: 'https://example.test/mcp',
      headers: { Authorization: `Bearer ${importSecret}` },
    },
    'Native service': {
      command: [
        'npx',
        '-y',
        'synthetic-package@1.2.3',
        '--CaseSensitive',
        'A B',
        '$(never-run); & not-a-shell',
      ],
      env: { API_KEY: importSecret },
    },
    'Image service': {
      type: 'image',
      image: 'synthetic-image:1.2.3',
      command: ['fixture-entrypoint'],
      args: ['--CaseSensitive'],
      env: { PASSWORD: importSecret },
    },
  },
};
