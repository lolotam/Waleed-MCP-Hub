import { execFileSync } from 'node:child_process';

const exe = 'E:\\Dev\\Runtimes\\npm-global\\node_modules\\@opencode\\cli\\bin\\opencode.exe';

const prompt = `All tests, launcher builds, and portable package verifications have passed 100% green!

Now finalize Task 20 by creating the clean Git commits:
1. Stage all remaining modified and untracked files:
   - Stage the updated docs (docs/ROADMAP.md, docs/STATUS.md, docs/DECISIONS.md, README.md, .gitignore)
   - Stage the generalized scripts (scripts/desktop-integrity.mjs, scripts/desktop-integrity.d.mts, scripts/verify-desktop-package.mjs, scripts/package-desktop.mjs, scripts/dispatch.mjs, scripts/inspect-session.mjs, scripts/send-prompt.ps1, scripts/verify-packaged-containment.mjs)
   - Stage tests/desktop-integrity.test.ts, apps/server/src/app.ts, tests/integration/server.test.ts
2. Create well-structured, clean Git commits covering the roadmap implementations (Tasks 1-19, launcher and desktop packaging, developer tooling).
3. Verify 'git status --short' is completely clean.
4. Output your final completion summary.`;

try {
  console.log('Dispatching commit prompt to OpenCode session ses_e7a498b47ffe7xlM8ccDuQJajR...');
  const res = execFileSync(exe, [
    'api',
    'post',
    '/api/session/ses_e7a498b47ffe7xlM8ccDuQJajR/prompt',
    '--data',
    JSON.stringify({ text: prompt })
  ], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  console.log('Dispatch response:', res.slice(0, 300));
} catch (err) {
  console.error('Dispatch failed:', err.message);
  process.exit(1);
}
