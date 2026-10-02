// Checks every relative markdown link and #anchor in the repo's docs.
// Usage: node scripts/check-doc-links.mjs [root]
// Prints one `file:line: target (reason)` per broken link; exits 1 if any.
// Anchors follow GitHub's slug rules: lowercase, drop punctuation except
// `-` and `_`, spaces become `-`, repeated headings get `-1`, `-2`, ...
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, ".."));
const ROOT_FILES = ["README.md", "AGENTS.md", "CHANGELOG.md", "scripts/README.md"];
const TREES = ["docs", "skills"];
// The operator's untracked file; never checked, never touched.
const EXCLUDED = new Set(["docs/ORCHESTRATOR_TREES.md"]);

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.name === "node_modules") return [];
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith(".md") ? [p] : [];
  });
}

function docFiles() {
  const files = [
    ...ROOT_FILES.map((f) => join(ROOT, f)).filter((f) => existsSync(f)),
    ...TREES.flatMap((t) => walk(join(ROOT, t))),
  ];
  return files.filter((f) => !EXCLUDED.has(rel(f))).sort();
}

const rel = (f) => relative(ROOT, f).split("\\").join("/");

/** Lines outside fenced code blocks (fenced lines become ""). With
 *  `blankInline`, inline code spans are blanked too, so a `[x](y)` inside
 *  backticks is not a link; headings keep theirs, since code text is part
 *  of the slug. */
function proseLines(text, blankInline = true) {
  let fence = null;
  return text.split("\n").map((line) => {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (m) {
      const marker = m[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return "";
    }
    if (fence !== null) return "";
    if (!blankInline) return line;
    return line.replace(/(`+)[^`]*?\1/g, (s) => " ".repeat(s.length));
  });
}

function slug(heading) {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

const anchorCache = new Map();
function anchorsOf(file) {
  const cached = anchorCache.get(file);
  if (cached) return cached;
  const anchors = new Set();
  const seen = new Map();
  for (const line of proseLines(readFileSync(file, "utf8"), false)) {
    const h = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) {
      const base = slug(h[1] ?? "");
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const a of line.matchAll(/<a\s+(?:name|id)=["']([^"']+)["']/g)) anchors.add(a[1]);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

function linkTargets(line) {
  const out = [];
  for (const m of line.matchAll(/\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+["'(][^)]*)?\)/g)) out.push(m[1]);
  const def = line.match(/^\s{0,3}\[[^\]]+\]:\s*(\S+)/);
  if (def) out.push(def[1]);
  return out.map((t) => t.replace(/^<|>$/g, ""));
}

function check(file) {
  const problems = [];
  proseLines(readFileSync(file, "utf8")).forEach((line, i) => {
    for (const target of linkTargets(line)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("/")) continue;
      const [pathPart = "", anchor] = target.split("#", 2);
      const dest = pathPart === "" ? file : resolve(dirname(file), decodeURIComponent(pathPart));
      const where = `${rel(file)}:${i + 1}: ${target}`;
      if (!existsSync(dest)) {
        problems.push(`${where} (missing file)`);
        continue;
      }
      if (anchor === undefined || anchor === "") continue;
      if (!dest.endsWith(".md") || statSync(dest).isDirectory()) continue;
      if (!anchorsOf(dest).has(decodeURIComponent(anchor).toLowerCase())) {
        problems.push(`${where} (missing anchor)`);
      }
    }
  });
  return problems;
}

const files = docFiles();
const problems = files.flatMap(check);
for (const p of problems) console.log(p);
console.error(`checked ${files.length} files: ${problems.length} broken link(s)`);
process.exit(problems.length > 0 ? 1 : 0);
