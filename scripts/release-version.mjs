import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const parse = (value) => {
  if (typeof value !== 'string' || !/^v?\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(value))
    throw new Error('Expected a stable semantic version.');
  return value.replace(/^v/, '').split('.').map(Number);
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
export function releaseVersion(baseVersion, releases, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !Array.isArray(releases))
    throw new Error('Invalid verified release input.');
  const existing = releases.find(
    (release) =>
      release.target_commitish === sha &&
      !release.prerelease &&
      (!release.draft || release.body?.includes(`<!-- wmh-release:${sha} -->`)),
  );
  if (existing) {
    parse(existing.tag_name);
    return {
      version: existing.tag_name.replace(/^v/, ''),
      tag: existing.tag_name,
      skip: !existing.draft,
    };
  }
  let latest = parse(baseVersion);
  for (const release of releases) {
    if (
      release.prerelease ||
      !/^v?\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(release.tag_name ?? '')
    )
      continue;
    const candidate = parse(release.tag_name);
    if (compare(candidate, latest) > 0) latest = candidate;
  }
  latest[2]++;
  const version = latest.join('.');
  parse(version);
  return { version, tag: `v${version}`, skip: false };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [file, sha] = process.argv.slice(2);
  const { version: base } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const result = releaseVersion(
    base,
    JSON.parse(await readFile(file, 'utf8')),
    sha,
  );
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(result)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(''),
    );
  else process.stdout.write(JSON.stringify(result) + '\n');
}
