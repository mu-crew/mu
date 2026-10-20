// Code-unit string order for sorting names and paths.
//
// mu used `localeCompare` for these; the first call initialises ICU
// (~4.5 ms per process, on nearly every list verb) and the resulting order
// depends on the locale. Ids and paths want a stable, locale-free order.

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
