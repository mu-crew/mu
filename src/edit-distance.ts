// mu — Levenshtein distance, shared by the did-you-mean hints (unknown verb, wrong column, unknown workstream).
// Leaf module: imports nothing.

/** Levenshtein distance between `a` and `b`. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row.push(
        Math.min(
          (prev[j] as number) + 1,
          (row[j - 1] as number) + 1,
          (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      );
    }
    prev = row;
  }
  return prev[b.length] as number;
}
