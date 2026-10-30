import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  helpGuides,
  helpTopics,
  searchHelp,
  guideSections,
  guideLink,
} from '../apps/web/src/help/guides.js';
import { GuideContent } from '../apps/web/src/help/GuideContent.js';
it('bundles the actual guides with unique searchable topics and valid source paths', async () => {
  expect(new Set(helpTopics.map((topic) => topic.id)).size).toBe(
    helpTopics.length,
  );
  expect(helpGuides.map((guide) => guide.category)).toEqual([
    'Connecting Agents',
    'Adding MCPs',
    'Security & Privacy',
    'Troubleshooting',
  ]);
  for (const guide of helpGuides) {
    const source = await readFile(`docs/guides/${guide.file}`, 'utf8');
    expect(guide.markdown.replaceAll('\r\n', '\n')).toBe(
      source.replaceAll('\r\n', '\n'),
    );
    expect(guide.markdown).toMatch(/^# /);
    expect(
      helpTopics.some(
        (topic) => topic.guideId === guide.id && topic.id === guide.id,
      ),
    ).toBe(true);
    expect(guide.markdown.length).toBeLessThan(64 * 1024);
  }
});
it.each([
  'Claude Desktop',
  'Cursor',
  'VS Code',
  'Codex',
  'OpenCode',
  'OAuth',
  'npx',
  'uvx',
  'Docker',
  'bundle',
  'DPAPI',
  'JobObject',
  'loopback',
  'white',
  'exit code -1',
  'Needs Re-auth',
])('finds the documented topic for %s', (query) => {
  expect(searchHelp(query).length).toBeGreaterThan(0);
});
it('categorizes and normalizes searches without returning unrelated topics', () => {
  expect(
    searchHelp('CURSOR', 'Connecting Agents').every(
      (topic) => topic.category === 'Connecting Agents',
    ),
  ).toBe(true);
  expect(searchHelp('Ｓｅｃｕｒｉｔｙ').length).toBeGreaterThan(0);
  expect(searchHelp('no_such_topic_xyz')).toEqual([]);
  expect(searchHelp('OAuth', 'Security & Privacy').length).toBeGreaterThan(0);
});
it('does not interpret headings inside code or duplicate guide sources as independent content', () => {
  const sections = guideSections(
    '# Title\n## Real\n```md\n## Not a section\n```\n## Next\ntext',
  );
  expect(sections.map((section) => section.title)).toEqual(['Real', 'Next']);
  expect(sections[0]!.content).toContain('## Not a section');
});
it.each([
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'file:///C:/private',
  '//foreign.test/x',
  '../../private.txt',
  'https://user:password@example.test',
  'https://example.test/\nprivate',
])('rejects unsafe guide link %s', (href) =>
  expect(guideLink(href, 'adding')).toBeNull(),
);
it('resolves only known local guides and HTTPS links, with no arbitrary file-serving seam', () => {
  expect(guideLink('connecting-agents.md#claude-desktop', 'adding')).toEqual({
    guideId: 'connecting',
    anchor: 'claude-desktop',
  });
  expect(guideLink('#remote-http', 'adding')).toEqual({
    guideId: 'adding',
    anchor: 'remote-http',
  });
  expect(guideLink('https://example.test/help', 'adding')).toEqual({
    external: 'https://example.test/help',
  });
});
it('renders Markdown as escaped text with safe links, not arbitrary HTML, image loads or scripts', () => {
  const content =
    '# Safety\n<script>window.INJECTED=1</script>\n\n<img src=x onerror=alert(1)>\n\n[execute](javascript:alert(1))\n\n[provider](https://example.test/help)\n\n```html\n<iframe src="file:///private"></iframe>\n```\n\n| Key | Value |\n| --- | --- |\n| **Safe** | `literal` |';
  const html = renderToStaticMarkup(
    createElement(GuideContent, {
      content,
      guideId: 'security',
      navigate: () => {},
    }),
  );
  expect(html).not.toMatch(/<(?:script|img|iframe)\b/);
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('<table>');
  expect(html).toContain('<strong>Safe</strong>');
});
