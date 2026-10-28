// The lease transport's profile (mu_lease_profile): transport/stop validation, the placeholder
// scopes the lexer enforces per field, `host init --mule`, and the CLI surface. mu stays
// ssh-free and mule-agnostic: every template here is a fake run through /bin/sh.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import {
  addHost,
  expandHostTemplate,
  getHost,
  HostProfileError,
  HostTemplateError,
  hostMuleStarter,
  listHosts,
  placeholderUses,
  validateHostTemplate,
} from "../src/hosts.js";
import { rmFixtureDir } from "./_fs.js";
import { runCli, runCliJson } from "./_runCli.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mu-lease-prof-"));
  dbPath = join(dir, "mu.db");
  db = openDb({ path: dbPath });
});
afterEach(() => {
  db.close();
  rmFixtureDir(dir);
});

const LEASE_SHELL =
  "carrier --job-file {job_file} -L {local_sock}:{remote_sock} -- env {env} sh -c {cmd}";
const lease = (over: Record<string, unknown> = {}) => ({
  name: "dev",
  shell: LEASE_SHELL,
  exec: "x sh -c {cmd}",
  fetch: "git fetch {cwd}",
  repo: null,
  max_sessions: null,
  transport: "lease" as const,
  stop: "x rm {job}",
  ...over,
});
const session = (over: Record<string, unknown> = {}) => ({
  name: "dev",
  shell: "ssh -L {local_sock}:{remote_sock} h {cmd}",
  exec: "x sh -c {cmd}",
  fetch: "f",
  repo: null,
  max_sessions: null,
  ...over,
});

describe("profile validation matrix", () => {
  it("a lease profile round-trips transport and stop", () => {
    const h = addHost(db, lease());
    expect(h).toMatchObject({ transport: "lease", stop: "x rm {job}" });
    expect(getHost(db, "dev")).toEqual(h);
  });

  it("a profile with no transport is a session profile with no stop", () => {
    expect(addHost(db, session())).toMatchObject({ transport: "session", stop: null });
  });

  it.each([
    ["an unknown transport", lease({ transport: "tunnel" }), /--transport/],
    ["a lease without --stop", lease({ stop: null }), /--stop is required/],
    ["a session with --stop", session({ stop: "x rm {job}" }), /--stop is only for/],
    ["a stop without {job}", lease({ stop: "x rm everything" }), /--stop: .*must contain \{job\}/],
    ["a stop with {env}", lease({ stop: "x rm {job} {env}" }), /--stop: \{env\} is not valid/],
    ["a stop with {cmd}", lease({ stop: "x rm {job} {cmd}" }), /--stop: \{cmd\} is not valid/],
    ["a stop with {local_sock}", lease({ stop: "x {job} {local_sock}" }), /--stop: \{local_sock\}/],
    ["a stop with {job_file}", lease({ stop: "x {job} {job_file}" }), /--stop: \{job_file\}/],
    [
      "a lease shell with no {job_file}",
      lease({ shell: "c -L {local_sock}:{remote_sock}" }),
      /exactly once \(found 0\)/,
    ],
    [
      "a lease shell with {job_file} twice",
      lease({ shell: `${LEASE_SHELL} {job_file}` }),
      /exactly once \(found 2\)/,
    ],
    [
      "a lease shell with no {local_sock}",
      lease({ shell: "c {job_file} {remote_sock}" }),
      /must contain \{local_sock\}/,
    ],
    [
      "a lease shell with no {remote_sock}",
      lease({ shell: "c {job_file} {local_sock}" }),
      /must contain \{remote_sock\}/,
    ],
    [
      "a lease shell with {job}",
      lease({ shell: `${LEASE_SHELL} {job}` }),
      /--shell: \{job\} is not valid/,
    ],
    [
      "a session shell with {job_file}",
      session({ shell: "ssh {job_file} {local_sock}:{remote_sock}" }),
      /--shell: \{job_file\} is not valid in the session shell/,
    ],
    ["an exec with {job_file}", lease({ exec: "x {job_file}" }), /--exec: \{job_file\}/],
    ["a fetch with {job}", lease({ fetch: "x {job}" }), /--fetch: \{job\}/],
    ["a stop with a stray brace", lease({ stop: "x {job} {" }), /--stop: stray/],
  ])("refuses %s and stores nothing", (_what, p, re) => {
    expect(() => addHost(db, p as never)).toThrow(re);
    expect(listHosts(db)).toEqual([]);
  });

  it("the refusals are HostProfileError (exit 2): usage, nothing stored", () => {
    expect(() => addHost(db, lease({ stop: null }))).toThrow(HostProfileError);
    expect(() => addHost(db, lease({ stop: "x" }))).toThrow(HostTemplateError);
  });

  it("a stop template permits {job} and {cwd}", () => {
    expect(() => addHost(db, lease({ stop: "cd {cwd} && x rm {job}" }))).not.toThrow();
  });
});

describe("template grammar: the lexer decides, never a substring", () => {
  it("{{job_file}} is a literal, so a session shell may carry it", () => {
    expect(() =>
      addHost(db, session({ shell: "ssh -L {local_sock}:{remote_sock} h echo {{job_file}}" })),
    ).not.toThrow();
  });

  it("{{job}} in a stop is a literal and does not satisfy the {job} requirement", () => {
    expect(() => addHost(db, lease({ stop: "x rm {{job}}" }))).toThrow(/must contain \{job\}/);
    expect(() => addHost(db, lease({ stop: "x rm {{job}} {job}" }))).not.toThrow();
  });

  it("{{job_file}} does not count as a use; the real one still must appear once", () => {
    expect(() =>
      addHost(db, lease({ shell: `${LEASE_SHELL.replace("{job_file}", "{{job_file}}")}` })),
    ).toThrow(/found 0/);
    expect(placeholderUses("{{job_file}} {job_file:sh}", "lease-shell").job_file).toBe(1);
  });

  it("{job_file:sh} and {job:sh} count as uses; a quoted use counts too", () => {
    expect(() =>
      addHost(
        db,
        lease({ shell: "c --jf '{job_file}' {local_sock} {remote_sock}", stop: "x rm {job:sh}" }),
      ),
    ).not.toThrow();
    expect(() =>
      addHost(db, lease({ shell: 'c {job_file:sh} "{job_file}" {local_sock} {remote_sock}' })),
    ).toThrow(/found 2/);
  });

  it("a {env:sh} stays refused wherever it appears", () => {
    expect(() => validateHostTemplate("x {env:sh}", "lease-shell")).toThrow(/env:sh/);
  });

  it("a name outside a field's scope is refused when expanding, too", () => {
    expect(() => expandHostTemplate("x {job_file}", { job_file: "/j" }, "exec")).toThrow(
      /not valid in the exec template/,
    );
    expect(expandHostTemplate("x rm {job} {cwd}", { job: "j-1", cwd: "." }, "stop")).toBe(
      "x rm 'j-1' '.'",
    );
  });

  it("expansion without a scope still takes any known name (the pane's shell is filled by its caller)", () => {
    expect(expandHostTemplate("c {job_file}", { job_file: "/s/carrier/w/a.job" })).toBe(
      "c '/s/carrier/w/a.job'",
    );
  });
});

describe("host init --mule", () => {
  const ARGS = ["host", "init", "dev", "--mule"];
  const EXPECTED = [
    "mu host add dev --transport lease",
    "--shell 'mule run --host dev --lease --human --cwd {cwd} --job-file {job_file} --forward-unix {local_sock}:{remote_sock} -- env {env} sh -c {cmd}'",
    "--exec 'mule exec --host dev -- sh -c {cmd}'",
    "--stop 'mule rm --host dev {job}'",
    "--fetch 'git fetch ssh://dev{cwd} HEAD'",
  ].join(" \\\n  ");

  it("prints the spec's starter verbatim and runs nothing", async () => {
    const r = await runCli(ARGS, dbPath);
    expect(r.exitCode).toBeNull();
    expect(r.stdout).toContain(EXPECTED);
    expect(r.stdout).not.toContain("--max-sessions");
    expect(listHosts(db)).toEqual([]);
  });

  it("the starter is a valid lease profile as printed", () => {
    const s = hostMuleStarter("dev");
    expect(() =>
      addHost(db, { name: "dev", ...s, repo: null, max_sessions: null, transport: "lease" }),
    ).not.toThrow();
    expect(s.shell).toContain("env {env} sh -c {cmd}");
    expect(s.stop).toBe("mule rm --host dev {job}");
  });

  it("--json carries the starter fields and the command", async () => {
    const r = await runCliJson([...ARGS, "--json"], dbPath);
    expect(r.data).toMatchObject({
      host: "dev",
      transport: "lease",
      stop: "mule rm --host dev {job}",
      command: EXPECTED,
    });
  });

  it("--ssh is unchanged, and the two kinds exclude each other", async () => {
    expect((await runCli(["host", "init", "dev", "--ssh"], dbPath)).stdout).not.toContain(
      "--transport",
    );
    expect((await runCli([...ARGS, "--ssh"], dbPath)).exitCode).toBe(2);
    expect((await runCli(["host", "init", "dev"], dbPath)).exitCode).toBe(2);
    expect((await runCli(["host", "init", "dev;rm", "--mule"], dbPath)).exitCode).toBe(2);
  });
});

describe("mu host add | list | show with a transport", () => {
  const add = (extra: string[] = []) => [
    "host",
    "add",
    "dev",
    "--shell",
    LEASE_SHELL,
    "--exec",
    "x sh -c {cmd}",
    "--fetch",
    "git fetch {cwd}",
    ...extra,
  ];

  it("adds a lease profile; show and list print the transport, show prints the stop", async () => {
    const a = await runCliJson(
      [...add(["--transport", "lease", "--stop", "x rm {job}"]), "--json"],
      dbPath,
    );
    expect(a.exitCode).toBeNull();
    expect(a.data.host).toMatchObject({ transport: "lease", stop: "x rm {job}" });
    const list = await runCli(["host", "list"], dbPath);
    expect(list.stdout).toMatch(/TRANSPORT/);
    expect(list.stdout).toMatch(/dev\s+│\s+lease\s+│/);
    const show = await runCli(["host", "show", "dev"], dbPath);
    expect(show.stdout).toContain("transport lease");
    expect(show.stdout).toContain("stop   x rm {job}");
    const js = await runCliJson(["host", "show", "dev", "--json"], dbPath);
    expect(js.data.host).toMatchObject({ transport: "lease", stop: "x rm {job}" });
  });

  it("a session profile shows transport session and no stop line", async () => {
    await runCli(
      [
        "host",
        "add",
        "s1",
        "--shell",
        "ssh {local_sock}:{remote_sock} h",
        "--exec",
        "e",
        "--fetch",
        "f",
      ],
      dbPath,
    );
    const show = await runCli(["host", "show", "s1"], dbPath);
    expect(show.stdout).toContain("transport session");
    expect(show.stdout).not.toMatch(/\n\s+stop /);
  });

  it("refuses a lease without --stop, a session with --stop and a bad transport: exit 2", async () => {
    expect((await runCli(add(["--transport", "lease"]), dbPath)).exitCode).toBe(2);
    expect((await runCli(add(["--stop", "x {job}"]), dbPath)).exitCode).toBe(2);
    expect((await runCli(add(["--transport", "nope"]), dbPath)).exitCode).toBe(2);
    expect(listHosts(db)).toEqual([]);
  });
});
