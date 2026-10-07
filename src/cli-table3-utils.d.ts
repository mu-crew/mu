// cli-table3 ships no types for its internal utils. renderBoxTable
// (src/output.ts) calls them so non-plain cells measure and close their
// SGR state exactly as cli-table3 does.
declare module "cli-table3/src/utils.js" {
  const utils: {
    strlen(str: string): number;
    colorizeLines(lines: string[]): string[];
  };
  export default utils;
}
