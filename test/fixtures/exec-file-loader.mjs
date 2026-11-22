// The signal tests run the raw TS source in a standalone Node child, not in Vite.
export function resolve(specifier, context, next) {
  return next(
    specifier === "./helper-path.js" && context.parentURL?.endsWith("/src/exec-file.ts")
      ? "./helper-path.ts"
      : specifier,
    context,
  );
}
