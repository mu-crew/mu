// The channel-name scan behind test/channel-names.test.ts (plugins spec D9,
// P4): every place outside src/channels/ that decides by a channel's NAME
// rather than its capabilities. Parsed with the TypeScript compiler, so a
// comment, a string in a message, or a property that merely holds a name
// (`transport: "ctl"`) is not a hit; a comparison, a `case`, an
// `[...].includes(...)`, an identity test against a channel singleton, and a
// call of a channel-choosing helper are.

import ts from "typescript";

/** The built-in channel names, and the StateSource that names one (`ctl`). */
export const CHANNEL_NAME_LITERALS: ReadonlySet<string> = new Set(["ctl", "hooks", "mux"]);
const SINGLETONS = new Set(["ctlChannel", "hooksChannel", "muxChannel"]);
/** Helpers that answer "is this agent on <a named channel>" (src/channels/select.ts). */
const NAME_HELPERS = new Set(["expectsCtl", "piOnHooks", "servesCtl"]);
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

export interface NameHit {
  /** The enclosing function (or variable, property, method) name; `<module>` at top level. */
  where: string;
  /** What decided by name: `=== "hooks"`, `case "ctl"`, `includes "mux"`, `ctlChannel`, `expectsCtl()`. */
  form: string;
  line: number;
}

const nameLiteral = (n: ts.Node): string | undefined =>
  (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
  CHANNEL_NAME_LITERALS.has(n.text)
    ? n.text
    : undefined;

/** A function's own name: declared, or the variable or property an anonymous one is bound to. */
function functionName(n: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name !== undefined) {
    return ts.isIdentifier(n.name) ? n.name.text : undefined;
  }
  if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) {
    const p = n.parent;
    if ((ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && ts.isIdentifier(p.name)) {
      return p.name.text;
    }
  }
  return undefined;
}

/** The nearest named function around `node` (anonymous callbacks are skipped); `<module>` at top level. */
function enclosing(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    const name = functionName(n);
    if (name !== undefined) return name;
  }
  return "<module>";
}

/** The `alive` properties under `node` set to a `true`/`false` literal: a liveness decided in place. */
export function literalLivenessHits(fileName: string, text: string): NameHit[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const hits: NameHit[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "alive" &&
      (node.initializer.kind === ts.SyntaxKind.TrueKeyword ||
        node.initializer.kind === ts.SyntaxKind.FalseKeyword)
    ) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      hits.push({ where: enclosing(node), form: `alive: ${node.initializer.getText(sf)}`, line });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** Every name decision in one source file. */
export function channelNameHits(fileName: string, text: string): NameHit[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const hits: NameHit[] = [];
  const hit = (node: ts.Node, form: string): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    hits.push({ where: enclosing(node), form, line });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      const op = node.operatorToken.getText(sf);
      const lit = nameLiteral(node.left) ?? nameLiteral(node.right);
      if (lit !== undefined) hit(node, `${op} "${lit}"`);
      for (const side of [node.left, node.right]) {
        if (ts.isIdentifier(side) && SINGLETONS.has(side.text)) hit(node, `${op} ${side.text}`);
      }
    } else if (ts.isCaseClause(node)) {
      const lit = nameLiteral(node.expression);
      if (lit !== undefined) hit(node, `case "${lit}"`);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && NAME_HELPERS.has(callee.text)) hit(node, `${callee.text}()`);
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "includes" &&
        ts.isArrayLiteralExpression(callee.expression)
      ) {
        for (const el of callee.expression.elements) {
          const lit = nameLiteral(el);
          if (lit !== undefined) hit(node, `includes "${lit}"`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}
