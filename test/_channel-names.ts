// The channel-name scan behind test/channel-names.test.ts (plugins spec D9,
// P4): every place outside src/channels/ that decides by a channel's NAME
// rather than its capabilities. Parsed with the TypeScript compiler, so a
// comment, a string in a message, or a property that merely holds a name
// (`transport: "ctl"`) is not a hit; a comparison, a `case`, an
// `[...].includes(...)`, an identity test against a channel singleton, and a
// call of a channel-choosing helper are, also through an alias (an
// `import { ctlChannel as c }`, a `const e = expectsCtl`) or a constant that
// holds a name (`const CTL = "ctl"`). A net, not a proof: the guarantee is the
// registry and the capabilities, and liveness by construction (`withJobLiveness`).

import ts from "typescript";

/** The built-in channel names, and the StateSource that names one (`ctl`). */
export const CHANNEL_NAME_LITERALS: ReadonlySet<string> = new Set(["ctl", "hooks", "mux"]);
const SINGLETONS: ReadonlySet<string> = new Set(["ctlChannel", "hooksChannel", "muxChannel"]);
/** Helpers that answer "is this agent on <a named channel>" (src/channels/select.ts). */
const NAME_HELPERS: ReadonlySet<string> = new Set(["expectsCtl", "piOnHooks", "servesCtl"]);
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

/** `n` without the wrappers that keep its value: parentheses, `as`, `satisfies`, `!`. */
function unwrap(n: ts.Node): ts.Node {
  let e = n;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** The channel name a string literal is. */
function literalName(n: ts.Node): string | undefined {
  const e = unwrap(n);
  return (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) &&
    CHANNEL_NAME_LITERALS.has(e.text)
    ? e.text
    : undefined;
}

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

/**
 * The file's aliases: local names bound to a channel singleton or a name
 * helper (by import or by `const`), mapped to the original; and constants
 * that hold a channel name, mapped to it. Scope-blind: a net.
 */
function aliasesIn(sf: ts.SourceFile): { refs: Map<string, string>; held: Map<string, string> } {
  const refs = new Map<string, string>();
  const held = new Map<string, string>();
  for (const name of [...SINGLETONS, ...NAME_HELPERS]) refs.set(name, name);
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node)) {
      const original = refs.get((node.propertyName ?? node.name).text);
      if (original !== undefined) refs.set(node.name.text, original);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const init = unwrap(node.initializer);
      const name = literalName(init);
      const original = ts.isIdentifier(init) ? refs.get(init.text) : undefined;
      if (name !== undefined) held.set(node.name.text, name);
      else if (original !== undefined) refs.set(node.name.text, original);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { refs, held };
}

/** Every name decision in one source file. */
export function channelNameHits(fileName: string, text: string): NameHit[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const hits: NameHit[] = [];
  const { refs, held } = aliasesIn(sf);
  const hit = (node: ts.Node, form: string): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    hits.push({ where: enclosing(node), form, line });
  };
  /** The channel name `n` is or holds: a literal, or a constant bound to one. */
  const nameOf = (n: ts.Node): string | undefined => {
    const e = unwrap(n);
    return literalName(e) ?? (ts.isIdentifier(e) ? held.get(e.text) : undefined);
  };
  /** The original a reference names, when it is in `set` (directly or by alias). */
  const refTo = (n: ts.Node, set: ReadonlySet<string>): string | undefined => {
    const e = unwrap(n);
    const original = ts.isIdentifier(e) ? refs.get(e.text) : undefined;
    return original !== undefined && set.has(original) ? original : undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      const op = node.operatorToken.getText(sf);
      const lit = nameOf(node.left) ?? nameOf(node.right);
      if (lit !== undefined) hit(node, `${op} "${lit}"`);
      for (const side of [node.left, node.right]) {
        const singleton = refTo(side, SINGLETONS);
        if (singleton !== undefined) hit(node, `${op} ${singleton}`);
      }
    } else if (ts.isCaseClause(node)) {
      const lit = nameOf(node.expression);
      if (lit !== undefined) hit(node, `case "${lit}"`);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const helper = refTo(callee, NAME_HELPERS);
      if (helper !== undefined) hit(node, `${helper}()`);
      if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "includes" &&
        ts.isArrayLiteralExpression(callee.expression)
      ) {
        for (const el of callee.expression.elements) {
          const lit = nameOf(el);
          if (lit !== undefined) hit(node, `includes "${lit}"`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/**
 * Liveness set in place: an `alive` property in an object literal (whatever
 * its value), an assignment to `.alive`, a call of `unknownReading` (which
 * sets one), or an observation's `status: null` (dead). A channel or ctl module reports turn state only; liveness is
 * the job's (`withJobLiveness`, src/jobs/kinds.ts).
 */
export function livenessSetHits(fileName: string, text: string): NameHit[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const hits: NameHit[] = [];
  const hit = (node: ts.Node, form: string): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    hits.push({ where: enclosing(node), form, line });
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "alive"
    ) {
      hit(node, "alive:");
    } else if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "status" &&
      node.initializer.kind === ts.SyntaxKind.NullKeyword
    ) {
      hit(node, "status: null");
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "alive"
    ) {
      hit(node, ".alive =");
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "unknownReading"
    ) {
      hit(node, "unknownReading()");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}
