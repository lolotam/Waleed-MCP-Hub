import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const usage =
  'Usage: node scripts/inspect-session.mjs --session <ses_ID> [--bin <opencode executable>] [--limit <1-100>] [--include-content]';
try {
  const { values } = parseArgs({
    options: {
      session: { type: 'string' },
      bin: { type: 'string' },
      limit: { type: 'string', default: '4' },
      'include-content': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) console.info(usage);
  else {
    const limit = Number(values.limit);
    if (
      !/^ses_[A-Za-z0-9]+$/.test(values.session ?? '') ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error();
    const response = JSON.parse(
      execFileSync(
        values.bin ?? process.env.OPENCODE_BIN ?? 'opencode',
        ['api', 'get', `/api/session/${values.session}/message`],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30000,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        },
      ),
    );
    if (!Array.isArray(response.data)) throw new Error();
    for (const message of response.data.slice(0, limit)) {
      // Content (including tool inputs/results) is opt-in; default output is metadata only.
      const summary = {
        id: message.id,
        type: message.type,
        finish: message.finish,
      };
      console.info(
        JSON.stringify(
          values['include-content']
            ? { ...summary, text: message.text, content: message.content }
            : summary,
        ),
      );
    }
  }
} catch {
  console.error(
    `Session inspection failed. Check inputs and CLI access.\n${usage}`,
  );
  process.exitCode = 1;
}
