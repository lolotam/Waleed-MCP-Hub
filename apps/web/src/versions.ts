// SemVer 2.0 precedence of two exact versions: above zero when a is newer.
// Build metadata never counts.
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [main = '', ...rest] = value.split('+')[0]!.split('-');
    return {
      core: main.split('.').map(Number),
      pre: rest.length ? rest.join('-').split('.') : [],
    };
  };
  const left = parse(a),
    right = parse(b);
  for (let index = 0; index < 3; index++) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (difference) return difference;
  }
  // A release is newer than any of its prereleases.
  if (!left.pre.length || !right.pre.length)
    return right.pre.length - left.pre.length;
  const numeric = /^\d+$/;
  for (let index = 0; ; index++) {
    const x = left.pre[index],
      y = right.pre[index];
    if (x === undefined || y === undefined)
      return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    if (numeric.test(x) && numeric.test(y)) return Number(x) - Number(y);
    if (numeric.test(x)) return -1;
    if (numeric.test(y)) return 1;
    return x < y ? -1 : 1;
  }
}
