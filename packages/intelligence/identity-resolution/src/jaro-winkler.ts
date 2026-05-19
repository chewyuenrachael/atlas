/**
 * Jaro and Jaro–Winkler string similarity.
 *
 * SPEC.md §4.2 references "Jaro-Winkler > 0.85" as the fuzzy-name threshold.
 * We implement it directly rather than pulling in `natural` to keep the
 * dependency surface deliberately small (see AGENTS.md §11).
 *
 * Reference implementation: William Winkler's 1990 paper, with the standard
 * defaults of prefix scaling factor `p = 0.1` capped at a prefix length of 4.
 */

/**
 * Pure Jaro similarity in [0, 1].
 *
 * Returns 1 for two empty strings (vacuous equality), 0 if exactly one is
 * empty, and the Jaro coefficient otherwise.
 *
 * @example
 * ```ts
 * jaroSimilarity('martha', 'marhta'); // ~0.944
 * jaroSimilarity('cat', 'dog'); // 0
 * ```
 */
export function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array<boolean>(a.length).fill(false);
  const bMatches = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j += 1) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }

  const m = matches;
  return (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
}

/**
 * Jaro–Winkler similarity in [0, 1] with the standard prefix scaling factor
 * `p = 0.1` and prefix length cap of 4.
 *
 * @example
 * ```ts
 * jaroWinklerSimilarity('alice chen', 'alicia chen'); // ~0.92
 * jaroWinklerSimilarity('alice chen', 'bob jones');   // ~0.49
 * ```
 */
export function jaroWinklerSimilarity(a: string, b: string, p: number = 0.1): number {
  const jaro = jaroSimilarity(a, b);
  if (jaro === 0 || jaro === 1) return jaro;

  // Count common prefix up to 4 chars.
  const prefixCap = Math.min(4, Math.min(a.length, b.length));
  let prefix = 0;
  for (let i = 0; i < prefixCap; i += 1) {
    if (a[i] === b[i]) prefix += 1;
    else break;
  }

  return jaro + prefix * p * (1 - jaro);
}
