# Print one version's section of CHANGELOG.md, for the GitHub release body.
# Usage: python3 scripts/changelog-section.py CHANGELOG.md 1.2.3
import re, sys
path, version = sys.argv[1], sys.argv[2]
text = open(path).read()
# Headings like "## 0.6.0", "## [1.6.0] — date", "## 0.2.1 — date"
heads = [m for m in re.finditer(r"^## .*$", text, re.M)]
for i, m in enumerate(heads):
    if re.search(rf"(^|[\s\[]){re.escape(version)}(\]|\s|$)", m.group(0)[3:]):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        body = text[m.end():end].strip()
        body = re.sub(r"\n---\s*$", "", body).strip()
        print(body)
        sys.exit(0)
sys.exit(f"no section for {version} in {path}")
