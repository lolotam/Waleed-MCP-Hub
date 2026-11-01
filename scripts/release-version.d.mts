export function releaseVersion(
  baseVersion: string,
  releases: Array<{
    tag_name: string;
    target_commitish: string;
    draft: boolean;
    prerelease: boolean;
    body?: string;
  }>,
  sha: string,
): { version: string; tag: string; skip: boolean };
