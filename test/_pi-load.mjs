// Subprocess helper for pi-package.integration.test.ts: resolve the mu
// package through pi's own DefaultPackageManager and load the resolved
// extensions through pi's own loader. Prints one JSON line.
// argv: <pi dist/index.js> <package dir> <project dir> <agent dir>
const [piIndex, pkgDir, cwd, agentDir] = process.argv.slice(2);
const { DefaultPackageManager, SettingsManager, discoverAndLoadExtensions } = await import(piIndex);
const settingsManager = SettingsManager.create(cwd, agentDir);
const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager });
pm.addSourceToSettings(pkgDir);
const r = await pm.resolve();
const paths = r.extensions.filter((e) => e.enabled).map((e) => e.path);
const loaded = await discoverAndLoadExtensions(paths, cwd, agentDir);
console.log(
  JSON.stringify({
    extensions: r.extensions.length,
    skills: r.skills.length,
    prompts: r.prompts.length,
    factories: loaded.extensions.map((e) => ({ path: e.path, tools: [...e.tools.keys()] })),
    errors: loaded.errors,
  }),
);
