import { Fragment, type ReactNode } from 'react';
import { guideLink, guideSlug, type HelpGuideId } from './guides.js';

function inline(
  text: string,
  guideId: HelpGuideId,
  navigate: (id: HelpGuideId, anchor: string) => void,
): ReactNode {
  return text
    .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g)
    .map((part, index) => {
      if (part.startsWith('`') && part.endsWith('`'))
        return <code key={index}>{part.slice(1, -1)}</code>;
      if (part.startsWith('**') && part.endsWith('**'))
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
      if (link) {
        const target = guideLink(link[2]!, guideId);
        if (target && 'guideId' in target)
          return (
            <button
              type="button"
              className="guide-link"
              key={index}
              onClick={() => navigate(target.guideId, target.anchor)}
            >
              {link[1]}
            </button>
          );
        if (target && 'external' in target)
          return (
            <a
              key={index}
              href={target.external}
              target="_blank"
              rel="noopener noreferrer"
            >
              {link[1]}
            </a>
          );
        return <Fragment key={index}>{link[1]}</Fragment>;
      }
      return <Fragment key={index}>{part}</Fragment>;
    });
}
// Deliberately small Markdown subset. Every text/code/HTML fragment goes through
// React escaping; no HTML parser, dangerous DOM sink, image loader or execution.
export function GuideContent({
  content,
  guideId,
  navigate,
}: {
  content: string;
  guideId: HelpGuideId;
  navigate: (id: HelpGuideId, anchor: string) => void;
}) {
  const lines = content.replaceAll('\r\n', '\n').split('\n'),
    blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!))
        code.push(lines[i++]!);
      i++;
      blocks.push(
        <pre key={i}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6}) (.+)$/.exec(line);
    if (heading) {
      const id = `guide-${guideId}-${guideSlug(heading[2]!)}`,
        text = inline(heading[2]!, guideId, navigate);
      blocks.push(
        heading[1]!.length <= 2 ? (
          <h3 id={id} key={i}>
            {text}
          </h3>
        ) : (
          <h4 id={id} key={i}>
            {text}
          </h4>
        ),
      );
      i++;
      continue;
    }
    if (line.trim().startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        const cells = lines[i++]!.trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((cell) => cell.trim());
        if (!cells.every((cell) => /^:?-+:?$/.test(cell))) rows.push(cells);
      }
      blocks.push(
        <div className="guide-table" key={i}>
          <table>
            <thead>
              <tr>
                {rows[0]?.map((cell, index) => (
                  <th key={index}>{inline(cell, guideId, navigate)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((row, index) => (
                <tr key={index}>
                  {row.map((cell, index) => (
                    <td key={index}>{inline(cell, guideId, navigate)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const list = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(line);
    if (list) {
      const items: ReactNode[] = [];
      const ordered = /^\s*\d+\./.test(line),
        start = Number(/^\s*(\d+)\./.exec(line)?.[1] ?? 1);
      while (i < lines.length) {
        const item = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(lines[i]!);
        if (!item) break;
        const text = [item[1]!];
        i++;
        while (
          i < lines.length &&
          lines[i]!.trim() &&
          !/^(?:\s*[-*] |\s*\d+\. |\s*```|#{1,6} |\|)/.test(lines[i]!)
        )
          text.push(lines[i++]!.trim());
        items.push(
          <li key={i}>{inline(text.join(' '), guideId, navigate)}</li>,
        );
      }
      blocks.push(
        ordered ? (
          <ol key={i} start={start}>
            {items}
          </ol>
        ) : (
          <ul key={i}>{items}</ul>
        ),
      );
      continue;
    }
    const paragraph = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(?:#{1,6} |\s*```|\s*[-*] |\s*\d+\. |\|)/.test(lines[i]!)
    )
      paragraph.push(lines[i++]!);
    blocks.push(
      <p key={i}>{inline(paragraph.join(' '), guideId, navigate)}</p>,
    );
  }
  return <>{blocks}</>;
}
