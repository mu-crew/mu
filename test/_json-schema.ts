// A JSON Schema checker for the subset schemas/plugin-protocol-v1.json uses
// (no dependency): type, const, enum, properties, required,
// additionalProperties, items, oneOf, $ref into $defs, minimum, minLength,
// maxLength. An unknown keyword fails loudly, so the schema cannot drift past
// what this checks.

type Schema = Record<string, unknown>;

const KNOWN = new Set([
  "$schema",
  "$id",
  "$defs",
  "$ref",
  "title",
  "description",
  "type",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "oneOf",
  "minimum",
  "minLength",
  "maxLength",
]);

function typeOf(x: unknown): string {
  if (x === null) return "null";
  if (Array.isArray(x)) return "array";
  if (typeof x === "number") return Number.isInteger(x) ? "integer" : "number";
  return typeof x;
}

/** Whether `value` is valid against `#/$defs/<def>` of `root`. */
export function validates(root: Schema, def: string, value: unknown): boolean {
  const defs = root.$defs as Record<string, Schema>;
  const check = (s: Schema, x: unknown): boolean => {
    for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error(`unsupported keyword ${k}`);
    if (typeof s.$ref === "string") {
      const name = /^#\/\$defs\/(.+)$/.exec(s.$ref)?.[1];
      const target = name === undefined ? undefined : defs[name];
      if (target === undefined) throw new Error(`bad $ref ${s.$ref}`);
      if (!check(target, x)) return false;
    }
    const t = typeOf(x);
    if (typeof s.type === "string" && !(s.type === t || (s.type === "number" && t === "integer")))
      return false;
    if ("const" in s && JSON.stringify(s.const) !== JSON.stringify(x)) return false;
    if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(x)))
      return false;
    if (Array.isArray(s.oneOf) && s.oneOf.filter((o) => check(o as Schema, x)).length !== 1)
      return false;
    if (t === "string") {
      const str = x as string;
      if (typeof s.minLength === "number" && str.length < s.minLength) return false;
      if (typeof s.maxLength === "number" && str.length > s.maxLength) return false;
    }
    if (
      (t === "integer" || t === "number") &&
      typeof s.minimum === "number" &&
      (x as number) < s.minimum
    ) {
      return false;
    }
    if (
      t === "array" &&
      s.items !== undefined &&
      !(x as unknown[]).every((i) => check(s.items as Schema, i))
    ) {
      return false;
    }
    if (t === "object") {
      const o = x as Record<string, unknown>;
      const props = (s.properties ?? {}) as Record<string, Schema>;
      if (Array.isArray(s.required) && !s.required.every((r) => r in o)) return false;
      for (const [k, v] of Object.entries(o)) {
        const p = props[k];
        if (p !== undefined) {
          if (!check(p, v)) return false;
        } else if (s.additionalProperties === false) {
          return false;
        }
      }
    }
    return true;
  };
  const target = defs[def];
  if (target === undefined) throw new Error(`no $defs/${def}`);
  return check(target, value);
}
