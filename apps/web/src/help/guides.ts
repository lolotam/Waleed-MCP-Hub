import adding from '../../../../docs/guides/adding-mcps.md?raw';
import connecting from '../../../../docs/guides/connecting-agents.md?raw';
import troubleshooting from '../../../../docs/guides/troubleshooting.md?raw';
import security from '../../../../docs/guides/security-privacy.md?raw';

export const helpGuides = [
  {
    id: 'connecting',
    file: 'connecting-agents.md',
    category: 'Connecting Agents',
    title: 'Connecting Agents',
    markdown: connecting,
  },
  {
    id: 'adding',
    file: 'adding-mcps.md',
    category: 'Adding MCPs',
    title: 'Adding MCPs',
    markdown: adding,
  },
  {
    id: 'security',
    file: 'security-privacy.md',
    category: 'Security & Privacy',
    title: 'Security & Privacy',
    markdown: security,
  },
  {
    id: 'troubleshooting',
    file: 'troubleshooting.md',
    category: 'Troubleshooting',
    title: 'Troubleshooting',
    markdown: troubleshooting,
  },
] as const;
export type HelpGuideId = (typeof helpGuides)[number]['id'];
export const guideSlug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
export interface HelpTopic {
  id: string;
  guideId: HelpGuideId;
  title: string;
  category: string;
  content: string;
}
// Derive sections from the shipped sources so documentation edits cannot leave a
// separately maintained in-app copy behind. Fenced code is never a heading.
export function guideSections(markdown: string) {
  const result: Array<{ title: string; content: string }> = [];
  let title = '',
    lines: string[] = [],
    fenced = false;
  for (const line of markdown.replaceAll('\r\n', '\n').split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const heading = !fenced ? /^## (.+)$/.exec(line) : null;
    if (heading) {
      if (title) result.push({ title, content: lines.join('\n') });
      title = heading[1]!;
      lines = [line];
    } else if (title) lines.push(line);
  }
  if (title) result.push({ title, content: lines.join('\n') });
  return result;
}
export const helpTopics: HelpTopic[] = helpGuides.flatMap((guide) => [
  {
    id: guide.id,
    guideId: guide.id,
    title: `${guide.title} — full guide`,
    category: guide.category,
    content: guide.markdown,
  },
  ...guideSections(guide.markdown).map((section) => ({
    id: `${guide.id}/${guideSlug(section.title)}`,
    guideId: guide.id,
    category: guide.category,
    ...section,
  })),
]);
export function searchHelp(query: string, category = 'All topics') {
  const tokens = query
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 16);
  return helpTopics.filter(
    (topic) =>
      (category === 'All topics' || topic.category === category) &&
      tokens.every((token) =>
        `${topic.title} ${topic.category} ${topic.content}`
          .normalize('NFKC')
          .toLowerCase()
          .includes(token),
      ),
  );
}
export function guideLink(
  href: string,
  current: HelpGuideId,
): { guideId: HelpGuideId; anchor: string } | { external: string } | null {
  if (
    href.length > 2048 ||
    /[\s\\]/.test(href) ||
    [...href].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return null;
  if (href.startsWith('#')) return { guideId: current, anchor: href.slice(1) };
  const [file, anchor = ''] = href.replace(/^\.\//, '').split('#');
  const guide = helpGuides.find((item) => item.file === file);
  if (guide) return { guideId: guide.id, anchor };
  try {
    const url = new URL(href);
    if (url.protocol === 'https:' && !url.username && !url.password)
      return { external: url.href };
  } catch {
    /* Unknown local paths and executable schemes stay plain text. */
  }
  return null;
}
