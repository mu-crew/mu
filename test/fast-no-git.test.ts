import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const runner = /^(?:node:)?child_process$|^execa$/;
const launch = /^(?:exec(?:File|Command)?|spawn|execa(?:Command|Sync)?|\$)(?:Sync)?$/;
const helper =
  /(?:^|\/)(?:_git|_real-git|_git-setup|_harness-world|_judge-sandbox)(?:\.[cm]?[jt]s)?$/;
const gitCommand = /^\s*(?:[^\s]*\/)?git(?:\s|$)/;

function gitUses(path: string, text: string): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const functions = new Set<string>();
  const namespaces = new Set<string>();
  const hits: string[] = [];
  const hit = (node: ts.Node, reason: string) => {
    hits.push(
      `${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${reason}`,
    );
  };

  for (const node of file.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const mod = node.moduleSpecifier.text;
    const clause = node.importClause;
    if (clause?.isTypeOnly) continue;
    if (helper.test(mod)) hit(node, `imports ${mod}`);
    if (!runner.test(mod)) continue;
    if (clause?.name) namespaces.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else
      for (const { name, propertyName } of bindings.elements) {
        if (launch.test((propertyName ?? name).text)) functions.add(name.text);
      }
  }

  const isLaunch = (expr: ts.Expression) =>
    (ts.isIdentifier(expr) && functions.has(expr.text)) ||
    (ts.isPropertyAccessExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      namespaces.has(expr.expression.text) &&
      launch.test(expr.name.text));

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      const arg = node.arguments[0];
      if (
        arg &&
        ts.isStringLiteral(arg) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        helper.test(arg.text)
      ) {
        hit(node, `imports ${arg.text}`);
      }
      if (arg && isLaunch(node.expression) && gitCommand.test(commandHead(arg)))
        hit(node, "launches Git");
    }
    if (
      ts.isTaggedTemplateExpression(node) &&
      isLaunch(node.tag) &&
      gitCommand.test(commandHead(node.template))
    ) {
      hit(node, "launches Git");
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return hits;
}

function commandHead(node: ts.Expression): string {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return "";
}

it("fast test files do not import real Git fixtures or launch git directly", () => {
  const dir = import.meta.dirname;
  const paths = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(
      (f) => f.isFile() && f.name.endsWith(".test.ts") && !f.name.endsWith(".integration.test.ts"),
    )
    .map((f) => join(f.parentPath, f.name));
  paths.push(join(dir, "_global-teardown.ts"), join(dir, "_setup.ts"));
  const hits = paths.flatMap((p) => gitUses(p.slice(dir.length + 1), readFileSync(p, "utf8")));
  expect(hits.sort()).toEqual([]);
});
