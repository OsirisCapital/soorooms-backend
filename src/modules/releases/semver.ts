/** Versions « x.y.z » (trois nombres) : on ne gère rien d'autre, pour ne jamais comparer de travers. */
export const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export function parseVersion(version: string): [number, number, number] | null {
  if (!VERSION_PATTERN.test(version)) return null;
  const [a, b, c] = version.split('.').map(Number);
  return [a, b, c];
}

/** Négatif si a < b, 0 si égales, positif si a > b. Une version illisible compte comme la plus basse. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [-1, -1, -1];
  const pb = parseVersion(b) ?? [-1, -1, -1];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
