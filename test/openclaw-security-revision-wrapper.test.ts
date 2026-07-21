// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const wrapperSource = fs.readFileSync(
  path.join(repositoryRoot, "scripts", "openclaw-security-revision-wrapper.sh"),
  "utf8",
);
const invocationParser = path.join(
  repositoryRoot,
  "scripts",
  "openclaw-security-revision-invocation.mts",
);
const npmRemediation = path.join(repositoryRoot, "scripts", "npm-tar-security-revision.mts");
const tempDirectories: string[] = [];

function writeJson(file: string, value: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function treeSnapshot(root: string): object[] {
  if (!fs.existsSync(root)) return [];
  const entries: object[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const pathname = path.join(directory, name);
      const relative = path.relative(root, pathname);
      const metadata = fs.lstatSync(pathname);
      if (metadata.isDirectory()) {
        entries.push({ mode: metadata.mode & 0o7777, path: relative, type: "directory" });
        visit(pathname);
      } else {
        entries.push({
          contents: fs.readFileSync(pathname).toString("base64"),
          mode: metadata.mode & 0o7777,
          path: relative,
          type: "file",
        });
      }
    }
  };
  visit(root);
  return entries;
}

function writeFixedNemoClaw(root: string): void {
  writeJson(path.join(root, "package.json"), {
    name: "nemoclaw",
    version: "0.1.0",
    dependencies: { tar: "7.5.19" },
  });
  writeJson(path.join(root, "package-lock.json"), {
    name: "nemoclaw",
    version: "0.1.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "nemoclaw", version: "0.1.0", dependencies: { tar: "7.5.19" } },
      "node_modules/tar": {
        version: "7.5.19",
        resolved: "https://registry.npmjs.org/tar/-/tar-7.5.19.tgz",
        integrity:
          "sha512-4LeEWl96twnS2Q7Bz4MGqgazLqO+hJN63GZxXoIqh1T3VweYD997gbU1ItNsQafqqXTXd5WFyFdReLtwvRBNiw==",
      },
    },
  });
  writeJson(path.join(root, "node_modules", "tar", "package.json"), {
    name: "tar",
    version: "7.5.19",
  });
}

function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-wrapper-")),
  );
  tempDirectories.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const originalOpenClaw = path.join(bin, "openclaw-original.mjs");
  const axiosRemediation = path.join(bin, "axios-remediation.mjs");
  const wrapper = path.join(root, "openclaw-wrapper.sh");
  const invocationLog = path.join(root, "openclaw-invocation.json");
  const remediationLog = path.join(root, "remediation-log.jsonl");
  const nemoclawRoot = path.join(root, "nemoclaw");
  const replacementRoot = path.join(root, "replacement");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home);
  fs.mkdirSync(replacementRoot);
  writeFixedNemoClaw(nemoclawRoot);

  fs.writeFileSync(
    originalOpenClaw,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_INVOCATION_LOG, JSON.stringify(args));
const state = process.env.FAKE_STATE_DIRECTORY;
if (process.env.FAKE_MUTATE_STATE === "1") {
  fs.rmSync(state, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "new-state.txt"), "new\\n");
}
if (process.env.FAKE_INSTALL_NEMOCLAW === "1") {
  const extension = path.join(state, "extensions", "nemoclaw");
  fs.mkdirSync(path.dirname(extension), { recursive: true });
  fs.cpSync(process.env.FAKE_NEMOCLAW_ROOT, extension, { recursive: true });
}
process.exit(Number(process.env.FAKE_OPENCLAW_EXIT || 0));
`,
  );
  fs.chmodSync(originalOpenClaw, 0o755);

  fs.writeFileSync(
    axiosRemediation,
    `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
if (args.includes("--classify-install-target")) {
  const target = value("--classify-install-target");
  const normalized = target.startsWith("npm:") ? target.slice(4) : target;
  const reviewed = new Set([
    "@openclaw/slack@2026.5.22",
    "@openclaw/msteams@2026.5.22",
    "@openclaw/slack@2026.5.27",
    "@openclaw/msteams@2026.5.27",
    "@openclaw/slack@2026.6.10",
    "@openclaw/msteams@2026.6.10",
  ]);
  if (reviewed.has(normalized)) process.stdout.write(normalized);
  else if (target.endsWith("reviewed-slack.tgz")) process.stdout.write("@openclaw/slack@2026.6.10");
} else if (args.includes("--materialize-install-target")) {
  const target = value("--materialize-install-target");
  fs.appendFileSync(process.env.FAKE_REMEDIATION_LOG, JSON.stringify({ mode: "materialize", target: value("--materialize-install-target") }) + "\\n");
  process.stdout.write("npm-pack:" + (target.endsWith(".tgz") ? path.resolve(target) : target));
} else {
  const state = value("--state-directory");
  fs.appendFileSync(process.env.FAKE_REMEDIATION_LOG, JSON.stringify({ mode: "patch", spec: value("--expected-package-spec"), state }) + "\\n");
  if (process.env.FAKE_REMEDIATION_EXIT) process.exit(Number(process.env.FAKE_REMEDIATION_EXIT));
  fs.writeFileSync(path.join(state, "axios-remediated.txt"), "fixed\\n");
}
`,
  );

  const fakeMv = path.join(bin, "mv");
  fs.writeFileSync(
    fakeMv,
    `#!/usr/bin/env bash
source_path="\${1:-}"
if [[ "$source_path" == -- ]]; then
  source_path="\${2:-}"
fi
if [[ "\${FAKE_ROLLBACK_MV_FAILURE:-}" == 1 && "$source_path" == */prior-state ]]; then
  exit 55
fi
exec /bin/mv "$@"
`,
  );
  fs.chmodSync(fakeMv, 0o755);

  fs.writeFileSync(
    wrapper,
    wrapperSource
      .replace("/usr/local/bin/openclaw.nemoclaw-original", originalOpenClaw)
      .replace(
        "/usr/local/lib/nemoclaw/openclaw-security-revision-invocation.mts",
        invocationParser,
      )
      .replace(
        "/usr/local/lib/nemoclaw/openclaw-plugin-axios-security-revision.mts",
        axiosRemediation,
      )
      .replace("/usr/local/lib/nemoclaw/npm-tar-security-revision.mts", npmRemediation)
      .replace("/usr/local/share/nemoclaw/openclaw-plugin-axios-1.18.0", replacementRoot)
      .replaceAll("/opt/nemoclaw", nemoclawRoot),
  );
  return {
    home,
    invocationLog,
    nemoclawRoot,
    remediationLog,
    root,
    wrapper,
  };
}

function run(
  target: ReturnType<typeof fixture>,
  args: string[],
  options: { env?: Record<string, string>; stateDirectory?: string } = {},
) {
  const stateDirectory = options.stateDirectory ?? path.join(target.home, ".openclaw");
  return spawnSync("bash", [target.wrapper, ...args], {
    cwd: target.root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: target.home,
      OPENCLAW_PROFILE: "",
      OPENCLAW_STATE_DIR: "",
      PATH: `${path.join(target.root, "bin")}:${process.env.PATH}`,
      FAKE_INVOCATION_LOG: target.invocationLog,
      FAKE_NEMOCLAW_ROOT: target.nemoclawRoot,
      FAKE_REMEDIATION_LOG: target.remediationLog,
      FAKE_STATE_DIRECTORY: stateDirectory,
      ...options.env,
    },
  });
}

function originalArguments(target: ReturnType<typeof fixture>): string[] {
  return JSON.parse(fs.readFileSync(target.invocationLog, "utf8"));
}

function remediationEvents(target: ReturnType<typeof fixture>): object[] {
  if (!fs.existsSync(target.remediationLog)) return [];
  return fs
    .readFileSync(target.remediationLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenClaw security revision wrapper (#7272)", () => {
  it.each([
    ["unrelated command", ["status", "--json"]],
    ["install help", ["plugins", "install", "--help"]],
    ["unreviewed plugin", ["plugins", "install", "@openclaw/slack@2026.7.1"]],
  ])("delegates %s unchanged without remediation", (_label, args) => {
    const target = fixture();
    const result = run(target, args);
    expect(result.status).toBe(0);
    expect(originalArguments(target)).toEqual(args);
    expect(remediationEvents(target)).toEqual([]);
    expect(fs.existsSync(path.join(target.home, ".openclaw"))).toBe(false);
  });

  it.each([
    {
      args: ["--profile", "review", "plugins", "install", "@openclaw/slack@2026.6.10", "--verbose"],
      state: ".openclaw-review",
    },
    {
      args: ["plugins", "install", "@openclaw/msteams@2026.5.27", "--profile=review"],
      state: ".openclaw-review",
    },
    {
      args: ["plugins", "install", "@openclaw/slack@2026.5.22", "--dev"],
      state: ".openclaw-dev",
    },
  ])("remediates reviewed installs in the selected profile state", ({ args, state }) => {
    const target = fixture();
    const stateDirectory = path.join(target.home, state);
    const result = run(target, args, {
      env: { FAKE_MUTATE_STATE: "1" },
      stateDirectory,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const expectedArguments = [...args];
    const specIndex = expectedArguments.findIndex((argument) => argument.startsWith("@openclaw/"));
    expectedArguments[specIndex] = `npm-pack:${expectedArguments[specIndex]}`;
    expect(originalArguments(target)).toEqual(expectedArguments);
    expect(remediationEvents(target).at(-1)).toMatchObject({
      mode: "patch",
      state: stateDirectory,
    });
    expect(fs.readFileSync(path.join(stateDirectory, "axios-remediated.txt"), "utf8")).toBe(
      "fixed\n",
    );
  });

  it("lets OPENCLAW_STATE_DIR override a suffix profile", () => {
    const target = fixture();
    const stateDirectory = path.join(target.root, "explicit-state");
    const args = ["plugins", "install", "@openclaw/slack@2026.6.10", "--profile=ignored"];
    const result = run(target, args, {
      env: { FAKE_MUTATE_STATE: "1", OPENCLAW_STATE_DIR: stateDirectory },
      stateDirectory,
    });
    expect(result.status).toBe(0);
    expect(remediationEvents(target).at(-1)).toMatchObject({ state: stateDirectory });
  });

  it("retains reviewed local archive installation and target-index support", () => {
    const target = fixture();
    const archive = path.join(target.root, "reviewed-slack.tgz");
    fs.writeFileSync(archive, "reviewed fixture\n");
    const stateDirectory = path.join(target.home, ".openclaw-archive");
    const args = ["--profile", "archive", "plugins", "install", archive, "--verbose"];
    const result = run(target, args, {
      env: { FAKE_MUTATE_STATE: "1" },
      stateDirectory,
    });
    expect(result.status).toBe(0);
    const expected = [...args];
    expected[4] = `npm-pack:${archive}`;
    expect(originalArguments(target)).toEqual(expected);
    expect(remediationEvents(target).at(-1)).toMatchObject({
      mode: "patch",
      spec: "@openclaw/slack@2026.6.10",
      state: stateDirectory,
    });
  });

  it("restores the exact prior state and original status when OpenClaw fails", () => {
    const target = fixture();
    const stateDirectory = path.join(target.home, ".openclaw");
    fs.mkdirSync(path.join(stateDirectory, "nested"), { recursive: true });
    fs.writeFileSync(path.join(stateDirectory, "nested", "prior.txt"), "prior\n", { mode: 0o640 });
    const before = treeSnapshot(stateDirectory);
    const result = run(target, ["plugins", "install", "@openclaw/slack@2026.6.10"], {
      env: { FAKE_MUTATE_STATE: "1", FAKE_OPENCLAW_EXIT: "23" },
      stateDirectory,
    });
    expect(result.status).toBe(23);
    expect(treeSnapshot(stateDirectory)).toEqual(before);
  });

  it("restores the exact prior state when post-install remediation fails", () => {
    const target = fixture();
    const stateDirectory = path.join(target.home, ".openclaw");
    fs.mkdirSync(stateDirectory);
    fs.writeFileSync(path.join(stateDirectory, "prior.txt"), "prior\n");
    const before = treeSnapshot(stateDirectory);
    const result = run(target, ["plugins", "install", "@openclaw/msteams@2026.6.10"], {
      env: { FAKE_MUTATE_STATE: "1", FAKE_REMEDIATION_EXIT: "31" },
      stateDirectory,
    });
    expect(result.status).toBe(31);
    expect(treeSnapshot(stateDirectory)).toEqual(before);
  });

  it("removes a fresh state tree when post-install remediation fails", () => {
    const target = fixture();
    const stateDirectory = path.join(target.home, ".openclaw");
    const result = run(target, ["plugins", "install", "@openclaw/slack@2026.6.10"], {
      env: { FAKE_MUTATE_STATE: "1", FAKE_REMEDIATION_EXIT: "31" },
      stateDirectory,
    });
    expect(result.status).toBe(31);
    expect(fs.existsSync(stateDirectory)).toBe(false);
  });

  it("retains the prior snapshot and returns 70 when rollback itself fails", () => {
    const target = fixture();
    const stateDirectory = path.join(target.home, ".openclaw");
    fs.mkdirSync(stateDirectory);
    fs.writeFileSync(path.join(stateDirectory, "prior.txt"), "prior\n");
    const result = run(target, ["plugins", "install", "@openclaw/slack@2026.6.10"], {
      env: {
        FAKE_MUTATE_STATE: "1",
        FAKE_OPENCLAW_EXIT: "23",
        FAKE_ROLLBACK_MV_FAILURE: "1",
      },
      stateDirectory,
    });
    expect(result.status).toBe(70);
    const snapshots = fs
      .readdirSync(target.home)
      .filter((entry) => entry.startsWith(".nemoclaw-openclaw-state-rollback."));
    expect(snapshots).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(target.home, snapshots[0], "prior-state", "prior.txt"), "utf8"),
    ).toBe("prior\n");
    expect(result.stderr).toContain(path.join(target.home, snapshots[0]));
  });

  it("keeps the historical NemoClaw target and verifies source and installed tar", () => {
    const target = fixture();
    const stateDirectory = path.join(target.home, ".openclaw");
    const args = ["--profile=default", "plugins", "install", target.nemoclawRoot, "--verbose"];
    const result = run(target, args, {
      env: { FAKE_INSTALL_NEMOCLAW: "1", FAKE_MUTATE_STATE: "1" },
      stateDirectory,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(originalArguments(target)).toEqual(args);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            stateDirectory,
            "extensions",
            "nemoclaw",
            "node_modules",
            "tar",
            "package.json",
          ),
          "utf8",
        ),
      ).version,
    ).toBe("7.5.19");
  });
});
