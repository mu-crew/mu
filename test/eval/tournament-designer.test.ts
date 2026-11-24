// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { privateStores } from "../../tools/eval/rig-private.ts";
import { rhoFromB5 } from "../../tools/eval/tournament.ts";
import {
  auditSession,
  binLinkDirs,
  briefRefusals,
  type DenyContext,
  defaultDenyContext,
  denyHits,
  designerArgs,
  designerEnv,
  homePaths,
  installDirs,
  nodeInstallDir,
  packTokens,
  scrubPack,
} from "../../tools/eval/tournament-design.ts";

import { fakeCase, GEMINI, HAIKU, SONNET } from "./_tournament-rows.ts";

// ---- statistics of the round --------------------------------------------------------------------

// ---- isolation ----------------------------------------------------------------------------------

const museums = (c: DenyContext): string[] =>
  c.stores.filter((s) => s.rule === "museum").map((s) => s.dir);

describe("designer isolation", () => {
  const ctx: DenyContext = {
    home: "/home/u",
    repo: "/home/u/src/mu",
    surfaces: "/home/u/.cache/mu/eval/surfaces",
    packs: "/home/u/.cache/mu/eval/packs",
    stores: privateStores("/home/u", "/home/u/src/museum"),
    ownPack: "/home/u/.cache/mu/eval/designers/c1_wait/opus/pack",
    ownDdir: "/home/u/.cache/mu/eval/designers/c1_wait/opus",
    allow: ["/home/u/.nvm/versions/node/v22.1.0"],
    caseIds: ["wait_result_read", "dead_once"],
  };
  const rules = (t: string): string[] => denyHits(t, ctx).map((h) => h.rule);

  it("flags every denied term and path", () => {
    expect(rules("cat tools/eval/nextstep-cases.ts")).toEqual(
      expect.arrayContaining(["nextstep", "tools/eval"]),
    );
    expect(rules("grep -r wait_result_read")).toContain("case id");
    expect(rules("x test/eval/y")).toContain("test/eval");
    expect(rules("ls docs/eval")).toContain("docs/eval");
    expect(rules("read cold-intents")).toContain("cold-intents");
    expect(rules("hill-r2-tournament.md")).toContain("hill-r2-tournament");
    expect(rules("cat /home/u/src/mu/src/a.ts")).toContain("main checkout");
    expect(rules("ls ~/.local/state/mu-next/worktrees/crew-hill2/w-b3b")).toContain(
      "crew worktrees",
    );
    expect(rules("ls /home/u/.cache/mu/eval/surfaces/hill2-base")).toContain("built surfaces");
    expect(rules("ls $HOME/.cache/mu/eval/packs/c2_close")).toContain("another pack");
    expect(rules(`cat ${"$"}{HOME}/.local/state/mu-next/eval-transcripts/x`)).toContain(
      "eval transcripts",
    );
    expect(rules("ls ~/.local/state/mu5/worktrees/crew-x/w1")).toContain("crew worktrees");
    expect(rules("cat /home/u/.local/state/mu5/eval-transcripts/x")).toContain("eval transcripts");
    expect(rules("sqlite3 ~/.local/state/mu5/mu.db .tables")).toContain("mu state");
    expect(rules("ls ~/.pi/agent/sessions")).toContain("pi sessions");
    expect(rules("ls /home/u/.claude/projects/x")).toContain("claude projects");
    expect(rules("ls ~/.codex/sessions")).toContain("codex sessions");
    expect(rules("ls /home/u/museum/db")).toContain("museum");
    expect(rules("cat /x/skills/museum/SKILL.md")).toContain("museum skill");
    expect(rules('{"command":"museum search wait"}')).toContain("museum command");
    expect(rules('{"command":"cd x && /opt/bin/museum find y"}')).toContain("museum command");
    // a file that names the museum hook is not a call (mu's own init tests do)
    expect(rules('{"content":"command: \\"museum hook claude\\""}')).toEqual([]);
    expect(rules('{"command":"grep museum test/mu-init.test.ts"}')).toEqual([]);
    expect(rules("mu task notes hill2 -w crew-hill2")).toContain("task notes");
    expect(rules("mu task notes b3b_tournament_driver")).toContain("task notes");
    expect(rules("mu task notes b5_baseline -w crew-hill2")).toContain("task notes");
    // a designer's own scratch task named b in its empty DB is not a phase B unit
    expect(rules("$M task notes b -w t1 --report")).not.toContain("task notes");
    expect(rules("mu task notes blog-draft -w t1")).not.toContain("task notes");
    expect(rules("mu task notes delegate_friction-orch_b97e7056 -w scratch")).toContain(
      "task notes",
    );
  });

  it("with `exists`, a catch-all path in a top dir below HOME this host lacks is no hit", () => {
    const only = new Set(["/home/u/.ssh", "/home/u/src"]);
    const c: DenyContext = { ...ctx, exists: (p) => only.has(p) };
    const r = (t: string): string[] => denyHits(t, c, "/home/u/x").map((h) => h.rule);
    // a pane footer typed into a test string: ~/repo does not exist
    expect(r("cat > t.ts <<E\nconst s = `~/repo/wt/worker-1 (mu/worker-1)`;\nE")).toEqual([]);
    expect(r("ls /home/u/code/mu")).toEqual([]);
    // a top dir that exists still hits, at any depth, and HOME itself always does
    expect(r("cat ~/.ssh/nothing-here")).toEqual(["under the real HOME"]);
    expect(r("ls /home/u")).toEqual(["under the real HOME"]);
    // named stores are not the catch-all: an absent museum store still hits
    expect(r("ls /home/u/museum/db")).toContain("museum");
    // without `exists` (the default context) nothing is excused
    expect(rules("ls /home/u/code/mu")).toEqual(["under the real HOME"]);
  });

  it("the catch-all denies any other path under the real HOME, but lets node's install dir through", () => {
    expect(rules("cat /home/u/.ssh/config")).toEqual(["under the real HOME"]);
    expect(rules("cat ~/notes.txt")).toEqual(["under the real HOME"]);
    expect(rules("ls /home/u")).toEqual(["under the real HOME"]);
    // a bare $HOME is the designer's own empty HOME
    expect(rules('{"command":"echo $HOME"}')).toEqual([]);
    expect(
      rules("at /home/u/.nvm/versions/node/v22.1.0/lib/node_modules/npm/lib/cli.js:12"),
    ).toEqual([]);
    expect(rules("cd /home/u/.cache/mu/eval/designers/c1_wait/opus/pack && npm run build")).toEqual(
      [],
    );
    expect(rules("mu task notes t1 -w auth; ls error-nextsteps.test.ts")).toEqual([]);
    expect(homePaths("a ~/x b $HOME/y c /home/u/z.", "/home/u").map((p) => p.path)).toEqual([
      "/home/u/x",
      "/home/u/y",
      "/home/u/z",
    ]);
  });

  it("denies a museum checkout found on disk, wherever it lives, with no configured path", () => {
    tmp = mkdtempSync(join(tmpdir(), "mu-museum-"));
    const checkout = join(tmp, "src", "museum");
    mkdirSync(join(checkout, "skills", "museum"), { recursive: true });
    mkdirSync(join(tmp, "other", "museum"), { recursive: true });
    const c = defaultDenyContext({
      repo: "/no/repo",
      ownPack: "/no/pack",
      ownDdir: "/no/ddir",
      caseIds: [],
      home: "/home/u",
      museumDir: "",
    });
    expect(museums(c)).toEqual(["/home/u/museum"]);
    expect(denyHits(`cat ${checkout}/src/db.ts`, c).map((h) => h.rule)).toEqual([
      "museum checkout",
    ]);
    expect(denyHits(`ls ${checkout}`, c).map((h) => h.rule)).toEqual(["museum checkout"]);
    // a dir named museum without the skill is no checkout
    expect(denyHits(`ls ${join(tmp, "other", "museum")}`, c)).toEqual([]);
    // EVAL_MUSEUM_DIR names the checkout explicitly
    const named = defaultDenyContext({
      repo: "/no/repo",
      ownPack: "/no/pack",
      ownDdir: "/no/ddir",
      caseIds: [],
      home: "/home/u",
      museumDir: "/opt/museum",
    });
    expect(museums(named)).toEqual(["/home/u/museum", "/opt/museum"]);
    expect(denyHits("cat /opt/museum/README.md", named).map((h) => h.rule)).toContain("museum");
  });

  it("the default context lets node's own install dir through the catch-all", () => {
    const node = nodeInstallDir();
    const c = defaultDenyContext({
      repo: "/r",
      ownPack: "/p",
      ownDdir: "/d",
      caseIds: [],
      // two levels below HOME: a top-level child of HOME is never allowed (installDirs)
      home: dirname(dirname(node)),
    });
    expect(denyHits(`    at Module._compile (${node}/lib/node_modules/x.js:1:1)`, c)).toEqual([]);
    expect(denyHits(`cat ${dirname(node)}/elsewhere`, c).map((h) => h.rule)).toEqual([
      "under the real HOME",
    ]);
  });

  it("lets the install dir its own bin links name through, literal and resolved", () => {
    // c5: npm linked from another node install than the rig's node; `ls -l bin` printed it
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "mu-binlink-")));
    const home = join(tmp, "home");
    const real = join(home, "mise", "node", "26.13.0");
    mkdirSync(join(real, "bin"), { recursive: true });
    writeFileSync(join(real, "bin", "npm"), "");
    symlinkSync("./26.13.0", join(home, "mise", "node", "26"));
    const ddir = join(home, ".cache", "d");
    mkdirSync(join(ddir, "bin"), { recursive: true });
    symlinkSync(join(home, "mise", "node", "26", "bin", "npm"), join(ddir, "bin", "npm"));
    const c = defaultDenyContext({
      repo: "/no/such/repo",
      ownPack: "/no/such/pack",
      ownDdir: ddir,
      caseIds: [],
      home,
    });
    const ls = `${join(ddir, "bin", "npm")} -> ${join(home, "mise", "node", "26", "bin", "npm")}`;
    expect(denyHits(ls, c)).toEqual([]);
    expect(denyHits(`cat ${join(real, "bin", "npm")}`, c)).toEqual([]);
    expect(denyHits(`cat ${join(home, "mise", "other")}`, c).map((h) => h.rule)).toEqual([
      "under the real HOME",
    ]);
  });

  it("a bin link into ~/bin allows no store: HOME, its ancestors and its top-level children are never allowed", () => {
    // rv-hmark: npm -> ~/bin/npm makes the install prefix HOME itself
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "mu-binlink-")));
    const home = join(tmp, "home");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "npm"), "");
    const ddir = join(home, ".cache", "d");
    mkdirSync(join(ddir, "bin"), { recursive: true });
    symlinkSync(join(home, "bin", "npm"), join(ddir, "bin", "npm"));
    expect(binLinkDirs(join(ddir, "bin"))).toContain(home);
    const c = defaultDenyContext({
      repo: "/no/such/repo",
      ownPack: "/no/such/pack",
      ownDdir: ddir,
      caseIds: [],
      home,
    });
    expect(c.allow).not.toContain(home);
    expect(denyHits(`cat ${join(home, ".ssh", "config")}`, c).map((h) => h.rule)).toEqual([
      "under the real HOME",
    ]);
    expect(
      installDirs([home, tmp, join(home, ".local"), join(home, ".nvm", "v", "n")], home),
    ).toEqual([join(home, ".nvm", "v", "n")]);
  });

  it("audits what the designer did strictly, and excuses what the pack itself shows it", () => {
    tmp = mkdtempSync(join(tmpdir(), "mu-audit-"));
    const pack = join(tmp, "pack");
    mkdirSync(join(pack, "docs"), { recursive: true });
    writeFileSync(join(pack, "docs", "state.md"), "State lives in ~/.local/state/mu-next/mu.db.\n");
    const excused = packTokens(pack, ctx);
    expect([...excused]).toEqual(["~/.local/state/mu-next/mu.db"]);
    const call = (name: string, args: Record<string, unknown>) =>
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] },
      });
    const result = (text: string) =>
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", content: [{ type: "text", text }] },
      });
    const said = (text: string) =>
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    const audit = (lines: string[]): string[] => {
      const sd = join(tmp, `s${Math.random()}`);
      mkdirSync(sd);
      writeFileSync(join(sd, "x.jsonl"), lines.join("\n"));
      return auditSession(sd, ctx, excused).map((h) => h.rule);
    };
    // reading the pack's doc that names the state dir, and talking about it: clean
    expect(
      audit([
        call("read", { path: `${ctx.ownPack}/docs/state.md` }),
        result("State lives in ~/.local/state/mu-next/mu.db."),
        said("mu keeps ~/.local/state/mu-next/mu.db"),
        call("edit", {
          path: `${ctx.ownPack}/src/a.ts`,
          newText: "see ~/.local/state/mu-next/mu.db",
        }),
      ]),
    ).toEqual([]);
    // opening that path is not
    expect(
      audit([call("bash", { command: "sqlite3 ~/.local/state/mu-next/mu.db .tables" })]),
    ).toEqual(["mu state"]);
    expect(audit([call("bash", { command: "sqlite3 ~/.local/state/mu5/mu.db .tables" })])).toEqual([
      "mu state",
    ]);
    // a result showing what the pack does not carry is a leak
    expect(audit([result("/home/u/.ssh/id_rsa")])).toEqual(["under the real HOME"]);
    expect(audit([call("write", { path: "/home/u/notes.md", content: "x" })])).toEqual([
      "under the real HOME",
    ]);
    expect(audit(["not json /home/u/.ssh"])).toEqual(["under the real HOME"]);
    // writing to a path the pack names is still an act outside the pack
    expect(audit([call("write", { path: "~/.local/state/mu-next/mu.db", content: "x" })])).toEqual([
      "mu state",
    ]);
  });

  it("resolves relative paths in what the designer did against the session's cwd", () => {
    tmp = mkdtempSync(join(tmpdir(), "mu-audit-"));
    const header = JSON.stringify({ type: "session", version: 3, id: "s", cwd: ctx.ownPack });
    const call = (name: string, args: Record<string, unknown>) =>
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] },
      });
    const result = (text: string) =>
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", content: [{ type: "text", text }] },
      });
    const audit = (lines: string[]): string[] => {
      const sd = join(tmp, `s${Math.random()}`);
      mkdirSync(sd);
      writeFileSync(join(sd, "x.jsonl"), lines.join("\n"));
      return auditSession(sd, ctx).map((h) => h.rule);
    };
    const up7 = "../../../../../../..";
    expect(audit([header, call("bash", { command: `cat ${up7}/.pi/agent/sessions/x` })])).toEqual([
      "strict term",
      "pi sessions",
    ]);
    expect(audit([header, call("read", { path: `${up7}/.ssh/config` })])).toEqual([
      "under the real HOME",
    ]);
    expect(
      audit([header, call("write", { path: `src/../${up7}/notes.md`, content: "x" })]),
    ).toEqual(["under the real HOME"]);
    // the cwd comes from the header: from another cwd the same climb lands elsewhere
    const deep = JSON.stringify({ type: "session", cwd: `${ctx.ownPack}/src/cli` });
    expect(audit([deep, call("bash", { command: `cat ${up7}/.ssh/config` })])).toEqual([
      "under the real HOME",
    ]);
    // climbing inside its own dirs is clean; a result or prose naming `..` is not resolved
    expect(audit([header, call("bash", { command: "cd .. && ls pack/../pack/src" })])).toEqual([]);
    expect(audit([header, result(`see ${up7}/.ssh/config`)])).toEqual([]);
  });

  describe("bash commands in strict parts (review probes)", () => {
    const header = JSON.stringify({ type: "session", version: 3, id: "s", cwd: ctx.ownPack });
    const audit = (command: string): string[] => {
      tmp = mkdtempSync(join(tmpdir(), "mu-audit-"));
      const call = JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "bash", arguments: { command } }],
        },
      });
      writeFileSync(join(tmp, "x.jsonl"), [header, call].join("\n"));
      return auditSession(tmp, ctx).map((h) => h.rule);
    };
    const up7 = "../../../../../../..";

    it("a cd chain to the real HOME is a term hit and a path hit", () => {
      const hits = audit(`${"cd ..; ".repeat(7)}cat .pi/agent/sessions/x`);
      expect(hits).toContain("strict term");
      expect(hits).toContain("pi sessions");
      // a cd the audit cannot follow is still caught by the terms
      expect(audit("cd $OLDPWD && cat .claude/projects/x")).toEqual(["strict term"]);
      for (const t of [
        ".codex/sessions",
        "agent-transcripts",
        "x/museum",
        "mu-next/worktrees",
        "mu5/worktrees",
      ])
        expect(audit(`ls ${t}`)).toContain("strict term");
    });

    it("tracks cd and $PWD within one command", () => {
      expect(audit(`cat $PWD/${up7}/.pi/agent/sessions/x`)).toContain("pi sessions");
      expect(audit(`cat \${PWD}/${up7}/.ssh/config`)).toEqual(["under the real HOME"]);
      expect(audit(`cat $(pwd)/${up7}/.ssh/config`)).toEqual(["under the real HOME"]);
      expect(audit(`cat \`pwd\`/${up7}/.ssh/config`)).toEqual(["under the real HOME"]);
      expect(audit(`${"cd ..; ".repeat(7)}cat .ssh/config`)).toContain("under the real HOME");
      expect(audit("cd .. && cd .. || cd ../../../..\ncd ../.. && cat .ssh/config")).toContain(
        "under the real HOME",
      );
      expect(audit("cd /home/u && cat .netrc")).toContain("under the real HOME");
    });

    it("a variable assigned a climb makes its token an unresolvable climb", () => {
      expect(audit(`D=..; cat $D/$D/$D/$D/$D/$D/$D/.ssh/config`)).toEqual(["unresolvable climb"]);
      expect(audit("cd ~ && cat ../../x")).toEqual(["unresolvable climb"]);
    });

    it("benign in-pack commands are clean", () => {
      expect(audit("cd src && cat x.ts")).toEqual([]);
      expect(audit("cat ./README.md")).toEqual([]);
      expect(audit("ls ..")).toEqual([]);
      expect(audit("cd src/cli && cat ../../package.json | head -n 3 2>&1")).toEqual([]);
      expect(audit("cd /tmp && ls")).toEqual([]);
      expect(audit("cat $PWD/src/a.ts && ls $(pwd)/..")).toEqual([]);
      for (const c of [
        "ls /tmp",
        "cat /usr/include/x.h",
        "which node",
        "echo $HOME",
        "ls /opt/homebrew && find /usr/lib -name x",
        "cd /tmp && grep -r x . | tr / _",
        "python3 - <<'EOF'\ns = 1  # x\n// a TS comment in a heredoc\nEOF",
        "ls /home/u/.nvm/versions/node/v22.1.0/bin",
      ])
        expect(audit(c), c).toEqual([]);
    });

    it("a search from a dir above HOME is a hit (review probes)", () => {
      for (const c of [
        "find / -name '*.jsonl' -path '*sessions*'",
        "grep -r VERDICT /home",
        "ls /home",
        "rg -l VERDICT /",
        "rg -l VERDICT //",
        "fd jsonl /home/",
        "ls -R /home/u/..",
        "cd / && find . -name x",
        `${"cd ..; ".repeat(8)}rg VERDICT`,
        // rv-b3b4: a wrapper before the search, a glob above HOME
        "sudo find / -name '*.jsonl'",
        "sudo -u root rg -l VERDICT /",
        "env A=1 timeout 5 find / -name x",
        "du -sh /home/*",
      ])
        expect(audit(c), c).toContain("search above HOME");
      for (const c of ["ls /tmp/*", "sudo ls /usr/lib", "du -sh /tmp/x*", "sudo tr / _"])
        expect(audit(c), c).toEqual([]);
      expect(audit("grep -r VERDICT ~/..")).not.toEqual([]);
      const mac = { ...ctx, home: "/Users/u" };
      expect(denyHits('{"command":"ls /Users"}', mac, ctx.ownPack).map((h) => h.rule)).toEqual([
        "search above HOME",
      ]);
      expect(
        denyHits('{"command":"du -sh /Users/*"}', mac, ctx.ownPack).map((h) => h.rule),
      ).toEqual(["search above HOME"]);
      // a read or ls tool's path is checked too
      expect(denyHits('{"path":"/home"}', ctx, ctx.ownPack).map((h) => h.rule)).toEqual([
        "search above HOME",
      ]);
    });

    it("after a cd, only words that look like paths are resolved", () => {
      tmp = mkdtempSync(join(tmpdir(), "mu-audit-"));
      const call = JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "bash",
              arguments: { command: `cd ${up7} && cat .netrc && cd x` },
            },
          ],
        },
      });
      writeFileSync(join(tmp, "x.jsonl"), [header, call].join("\n"));
      const hits = auditSession(tmp, ctx);
      expect(hits.map((h) => h.match)).toEqual(["/home/u", "/home/u/.netrc"]);
    });
  });

  it("node's install dir is the prefix above bin/node", () => {
    expect(nodeInstallDir("/no/such/.nvm/versions/node/v22/bin/node")).toBe(
      "/no/such/.nvm/versions/node/v22",
    );
    expect(nodeInstallDir("/no/such/mise/dist-package/node")).toBe("/no/such/mise/dist-package");
  });

  let tmp = "";
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  });

  it("launches the designer with an empty HOME, the provider extension only, and no mu or museum on PATH", () => {
    tmp = mkdtempSync(join(tmpdir(), "mu-designer-"));
    const sys = join(tmp, "sys");
    const userBin = join(tmp, "userbin");
    for (const d of [sys, userBin]) mkdirSync(d);
    for (const [d, n] of [
      [userBin, "mu"],
      [userBin, "museum"],
      [sys, "git"],
    ] as const) {
      writeFileSync(join(d, n), "#!/bin/sh\n");
      chmodSync(join(d, n), 0o755);
    }
    const ddir = join(tmp, "ddir");
    const env = designerEnv({
      ddir,
      pack: join(ddir, "pack"),
      pathEnv: process.env.PATH,
      systemDirs: [userBin, sys],
      base: {},
    });
    expect(env.HOME).toBe(join(ddir, "home"));
    expect(env.PI_CODING_AGENT_DIR).toBe(env.HOME);
    expect(readFileSync(join(ddir, "home", "settings.json"), "utf8")).toContain("retry");
    expect(env.MU_SYNC_DIR).toBe("");
    expect(env.MU_DB_PATH?.startsWith(ddir)).toBe(true);
    expect(Object.keys(env).sort()).toEqual(
      [
        "HOME",
        "MU_DB_PATH",
        "MU_STATE_DIR",
        "MU_SYNC_DIR",
        "PATH",
        "PI_CODING_AGENT_DIR",
        "TERM",
      ].sort(),
    );
    const dirs = (env.PATH ?? "").split(":");
    expect(dirs).not.toContain(userBin);
    expect(dirs).toContain(sys);
    for (const d of dirs) {
      expect(existsSync(join(d, "mu"))).toBe(false);
      expect(existsSync(join(d, "museum"))).toBe(false);
    }
    expect(existsSync(join(ddir, "bin", "node"))).toBe(true);
    const args = designerArgs({ ddir, model: "m", providerExt: "/p/ext.ts", prompt: "go" });
    expect(args).toEqual(
      expect.arrayContaining(["--no-extensions", "--no-skills", "--no-context-files", "--no-mcp"]),
    );
    expect(args.filter((a) => a === "-e")).toHaveLength(1);
    expect(args[args.indexOf("-e") + 1]).toBe("/p/ext.ts");
    expect(args[args.indexOf("--session-dir") + 1]).toBe(join(ddir, "sessions"));
  });

  it("designerEnv: EVAL_LAUNCHER_ENV cannot change the designer's HOME, PATH or MU_*", () => {
    tmp = mkdtempSync(join(tmpdir(), "mu-designer-"));
    const ddir = join(tmp, "ddir");
    const env = designerEnv({
      ddir,
      pack: join(ddir, "pack"),
      pathEnv: "/usr/bin",
      systemDirs: [],
      base: { EVAL_LAUNCHER_ENV: "HOME=/x PATH=/x MU_DB_PATH=/x MU_SYNC_DIR=/x KEEP_OUTER=1" },
    });
    expect(env.HOME).toBe(join(ddir, "home"));
    expect(env.PATH).not.toBe("/x");
    expect(env.MU_DB_PATH).toBe(join(ddir, "state", "mu.db"));
    expect(env.MU_SYNC_DIR).toBe("");
    expect(env.KEEP_OUTER).toBe("1");
  });

  it("scrubs denied text out of the pack's remaining files", () => {
    tmp = mkdtempSync(join(tmpdir(), "mu-pack-"));
    writeFileSync(
      join(tmp, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck: "tsc && tsc -p tools/eval/tsconfig.json",
          eval: "node tools/eval/main.ts",
          build: "tsup",
        },
      }),
    );
    writeFileSync(join(tmp, "README.md"), "keep\nchecked by (`tools/eval`).\nkeep too\n");
    writeFileSync(join(tmp, "a.ts"), "// see tools/eval\nconst x = 1;\n");
    expect(scrubPack(tmp, { caseIds: [] })).toEqual([]);
    expect(JSON.parse(readFileSync(join(tmp, "package.json"), "utf8")).scripts).toEqual({
      typecheck: "tsc",
      build: "tsup",
    });
    expect(readFileSync(join(tmp, "README.md"), "utf8")).toBe("keep\nkeep too\n");
    writeFileSync(join(tmp, "b.ts"), 'const p = "tools/eval";\n');
    expect(scrubPack(tmp, { caseIds: [] })).toEqual(['b.ts: const p = "tools/eval";']);
  });

  it("drops a config list entry that names the rig (tsconfig include) and reports any other", () => {
    tmp = mkdtempSync(join(tmpdir(), "mu-pack-"));
    writeFileSync(
      join(tmp, "tsconfig.test.json"),
      JSON.stringify({ include: ["src/**/*", "tools/eval/pi-ai.d.ts"], strict: true }),
    );
    expect(scrubPack(tmp, { caseIds: [] })).toEqual([]);
    expect(JSON.parse(readFileSync(join(tmp, "tsconfig.test.json"), "utf8"))).toEqual({
      include: ["src/**/*"],
      strict: true,
    });
    writeFileSync(join(tmp, "c.json"), JSON.stringify({ path: "tools/eval" }));
    expect(scrubPack(tmp, { caseIds: [] })).toEqual(['c.json: "path": "tools/eval"']);
  });
});

describe("BRIEF.md refusals", () => {
  const cases = [
    fakeCase("wait_result_read", {
      paraphrases: [
        { id: "p1", leadIn: "a", goal: "What did worker-1 report? Show me its result line." },
      ],
    }),
  ];
  const judgeFiles = ["nextstep-cases.ts", "poll_wave.ts"];
  const refuse = (t: string): string[] => briefRefusals(t, { cases, judgeFiles });

  it("lets a problem statement with counts through", () => {
    expect(
      refuse(
        "Most orchestrator waits were filtered through a JSON tool, 304 of 430, and the filter dropped the result.",
      ),
    ).toEqual([]);
  });

  it("refuses code, commands, cases, goals, judge files and deleted paths", () => {
    expect(refuse("x\n```sh\nmu wait\n```\n")).toContain("a fenced code block");
    expect(refuse("$ mu wait x\n")).toContain("a line starting with `$ `");
    expect(refuse("they ran mu wait agent:auth/worker-1@3 --json | jq -c .data a lot")[0]).toMatch(
      /lead-in command/,
    );
    expect(
      refuse("they piped --json | jq -c .data often").some((r) => r.startsWith("16 characters")),
    ).toBe(true);
    expect(refuse("see wait_result_read")).toContain("case id wait_result_read");
    expect(
      refuse("users ask what did worker-1 report, show me often").some((r) =>
        r.startsWith("5 words"),
      ),
    ).toBe(true);
    expect(refuse("Show me its result line.").some((r) => r.startsWith("5 words"))).toBe(true);
    expect(refuse("judged in poll_wave.ts")).toContain("judge file poll_wave.ts");
    expect(refuse("as docs/history says")).toContain("deleted path docs/history");
  });
});

describe("rhoFromB5: the planning ICC from B5's base rows", () => {
  const models = { weak: [HAIKU, GEMINI], gate: SONNET };
  // two clusters per model: one always hits, one never (ICC 1 per model and pooled)
  const rows = [HAIKU, GEMINI, SONNET].flatMap((model) =>
    [1, 2, 3, 4].flatMap((rep) =>
      ["p1", "p2"].map((paraphrase) => ({
        case: "c",
        arm: "none" as const,
        paraphrase,
        model,
        hit: paraphrase === "p1",
        rep,
      })),
    ),
  );

  it("estimates ρ̂ per (case, model) and ρ̂_pool per case, and the cold guard by intent", () => {
    const cold = [HAIKU, GEMINI, SONNET].flatMap((model) =>
      ["i1", "i2", "i3"].flatMap((intent) =>
        [1, 2, 3].map(() => ({ intent, model, hit: intent !== "i3" })),
      ),
    );
    const r = rhoFromB5(rows, cold, models);
    expect(r.rho.c).toEqual({ [HAIKU]: 1, [GEMINI]: 1, [SONNET]: 1 });
    expect(r.rhoPool.c).toBe(1);
    expect(r.rho["cold-guess"]?.[HAIKU]).toBe(1);
  });

  it("leaves model-error rows out: counted as misses they would fake a cluster effect", () => {
    // every row hits (ICC 0, floored to 0.1); two model errors on p3 per model would be an
    // all-miss cluster beside two all-hit ones
    const flat = rows.map((r) => ({ ...r, hit: true }));
    const errors = [HAIKU, GEMINI, SONNET].flatMap((model) =>
      [1, 2].map((rep) => ({
        case: "c",
        arm: "none" as const,
        paraphrase: "p3",
        model,
        hit: false,
        rep,
        modelError: "429 rate limited",
      })),
    );
    const r = rhoFromB5([...flat, ...errors], [], models);
    expect(r.rho.c?.[HAIKU]).toBe(0.1);
    expect(r.rhoPool.c).toBe(0.1);
    expect(
      rhoFromB5([], [{ intent: "i1", model: HAIKU, hit: false, modelError: "x" }], models).rho,
    ).toEqual({});
  });

  it("leaves rig-read rows out too: an invalid row is not a reading outcome", () => {
    const flat = rows.map((r) => ({ ...r, hit: true }));
    const rig = [HAIKU, GEMINI, SONNET].flatMap((model) =>
      [1, 2].map((rep) => ({
        case: "c",
        arm: "none" as const,
        paraphrase: "p3",
        model,
        hit: false,
        rep,
        rigReads: ["command 1: /rig"],
      })),
    );
    expect(rhoFromB5([...flat, ...rig], [], models).rho.c?.[HAIKU]).toBe(0.1);
  });
});
// RIG-CANARY-f8dc74a2239b: a rig file (tools/eval/rig-guard.ts); an AUT that prints this line read the rig.
