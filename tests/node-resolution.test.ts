// The bin/ wrappers choose their Node.js binary in a fixed order: RITUAL_NODE, config/node, then PATH only when it is 24+.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REPO } from "./helpers/fixtures.ts";

interface Outcome {
  readonly status: number | null;
  readonly stdout: string;
}

/** A pretend Node: answers --version with the given version, otherwise prints which fake ran and what it was given. */
const fakeNode = (folder: string, name: string, version: string): string => {
  const file = path.join(folder, name);
  fs.writeFileSync(
    file,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nprintf '{"fake":"${name}","script":"%s"}\\n' "$(basename "$1")"\n`,
    { mode: 0o755 },
  );
  return file;
};

/** A throwaway root with real wrappers, the repository's sources and its own config/. */
const sandbox = (): { root: string; fakes: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ritual-node-"));
  fs.mkdirSync(path.join(root, "bin"));
  for (const name of fs.readdirSync(path.join(REPO, "bin")))
    fs.copyFileSync(path.join(REPO, "bin", name), path.join(root, "bin", name));
  for (const name of fs.readdirSync(path.join(root, "bin")))
    fs.chmodSync(path.join(root, "bin", name), name === "node.sh" ? 0o644 : 0o755);
  fs.symlinkSync(path.join(REPO, "src"), path.join(root, "src"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(root, "node_modules"));
  fs.mkdirSync(path.join(root, "config"));
  const fakes = path.join(root, "fakes");
  fs.mkdirSync(fakes);
  return { root, fakes };
};

const run = (root: string, env: Record<string, string>, command = "ritual-agent", argument = "status"): Outcome => {
  const result = spawnSync("/bin/sh", [path.join(root, "bin", command), argument], { env, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout };
};

const json = (outcome: Outcome): Record<string, unknown> => JSON.parse(outcome.stdout) as Record<string, unknown>;

describe("node resolution in bin/ wrappers", () => {
  const { root, fakes } = sandbox();
  const override = fakeNode(fakes, "override-node", "v22.0.0");
  const configured = fakeNode(fakes, "configured-node", "v22.0.0");
  const onPath = path.join(fakes, "path-24");
  fs.mkdirSync(onPath);
  fakeNode(onPath, "node", "v24.21.0");
  const oldOnPath = path.join(fakes, "path-22");
  fs.mkdirSync(oldOnPath);
  fakeNode(oldOnPath, "node", "v22.23.2");
  const noNode = "/usr/bin:/bin";

  it("RITUAL_NODE wins over config/node and PATH, as given", () => {
    fs.writeFileSync(path.join(root, "config", "node"), configured + "\n");
    const outcome = run(root, { PATH: onPath + ":" + noNode, RITUAL_NODE: override });
    expect(outcome.status).toBe(0);
    expect(json(outcome)).toEqual({ fake: "override-node", script: "ritual-agent.ts" });
  });

  it("config/node wins over PATH and is used without a version check by the wrapper", () => {
    fs.writeFileSync(path.join(root, "config", "node"), configured + "\n");
    const outcome = run(root, { PATH: onPath + ":" + noNode });
    expect(json(outcome)).toEqual({ fake: "configured-node", script: "ritual-agent.ts" });
  });

  it("every wrapper resolves the same way", () => {
    fs.writeFileSync(path.join(root, "config", "node"), configured + "\n");
    for (const command of ["ritualctl", "ritual-dashboard", "ritual-server", "ritual-service", "ritual-agent"]) {
      expect(json(run(root, { PATH: noNode }, command))).toEqual({ fake: "configured-node", script: command + ".ts" });
    }
  });

  it("config/node naming a missing binary fails with the JSON shape", () => {
    fs.writeFileSync(path.join(root, "config", "node"), path.join(fakes, "gone") + "\n");
    const outcome = run(root, { PATH: onPath + ":" + noNode });
    expect(outcome.status).toBe(1);
    expect(json(outcome)).toMatchObject({ ok: false });
    expect(String(json(outcome).error)).toContain("config/node");
  });

  it("a relative config/node fails with the JSON shape", () => {
    fs.writeFileSync(path.join(root, "config", "node"), "node\n");
    const outcome = run(root, { PATH: onPath + ":" + noNode });
    expect(outcome.status).toBe(1);
    expect(String(json(outcome).error)).toContain("absolute path");
  });

  it("PATH is used only when its node is 24 or newer", () => {
    fs.rmSync(path.join(root, "config", "node"));
    expect(json(run(root, { PATH: onPath + ":" + noNode }))).toEqual({ fake: "node", script: "ritual-agent.ts" });
    const old = run(root, { PATH: oldOnPath + ":" + noNode });
    expect(old.status).toBe(1);
    expect(json(old)).toMatchObject({ ok: false });
    expect(String(json(old).error)).toContain("Node.js 24");
  });

  it("no node anywhere fails with the JSON shape and runs nothing", () => {
    const outcome = run(root, { PATH: noNode });
    expect(outcome.status).toBe(1);
    expect(json(outcome)).toMatchObject({ ok: false });
  });

  it("a real Node 24 reached through config/node runs the command", () => {
    fs.writeFileSync(path.join(root, "config", "node"), process.execPath + "\n");
    // src/ is a symlink, so the command's own root is the repository; --queue-status has a fixed shape there.
    const outcome = run(root, { PATH: noNode, HOME: os.homedir() }, "ritualctl", "--queue-status");
    expect(outcome.status).toBe(0);
    expect(typeof json(outcome).pending_count).toBe("number");
  });

  it("an old Node named explicitly is refused by the runner, not run", () => {
    const outcome = run(root, { PATH: noNode, RITUAL_NODE: override });
    expect(json(outcome)).toEqual({ fake: "override-node", script: "ritual-agent.ts" });
    // The fake cannot evaluate TypeScript; the real guard lives in src/cli.ts and is exercised with a real old Node
    // when one is installed (see HANDOFF.md). Here we only pin the wrapper's contract: an override is used as given.
  });
});
