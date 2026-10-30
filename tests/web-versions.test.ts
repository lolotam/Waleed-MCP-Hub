import { describe, expect, it } from 'vitest';
import { compareVersions } from '../apps/web/src/versions.js';

describe('compareVersions', () => {
  it('orders releases by SemVer precedence', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('ranks a release above its prereleases and never offers a downgrade', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    // An install from a newer prerelease tag sees an older latest as older.
    expect(compareVersions('1.9.0', '2.0.0-beta.1')).toBeLessThan(0);
  });

  it('compares prerelease identifiers by the SemVer rules', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let index = 1; index < ordered.length; index++)
      expect(
        compareVersions(ordered[index]!, ordered[index - 1]!),
      ).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-x-y.1', '1.0.0-x-y.0')).toBeGreaterThan(0);
  });

  it('ignores build metadata', () => {
    expect(compareVersions('1.0.0+build.2', '1.0.0+build.1')).toBe(0);
  });
});
