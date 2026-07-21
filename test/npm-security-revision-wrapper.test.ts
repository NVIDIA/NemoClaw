// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const wrapperSource = fs.readFileSync(
  path.join(root, "scripts", "npm-security-revision-wrapper.sh"),
  "utf8",
);
const helper = path.join(root, "scripts", "npm-tar-security-revision.mts");
const mcporterHelper = path.join(root, "scripts", "mcporter-hono-security-revision.mts");
const tempDirectories: string[] = [];
const vulnerableIntegrity =
  "sha512-ChjMH33/KetonMTAtpYdgUFr0tbz69Fp2v7zWxQfYZX4g5ZN2nOBXm1R2xyA+lMIKrLKIoKAwFj93jE/avX9cQ==";

function writeJson(file: string, value: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-npm-wrapper-")),
  );
  tempDirectories.push(fixtureRoot);
  const nemoclawRoot = path.join(fixtureRoot, "nemoclaw");
  const fakeBin = path.join(fixtureRoot, "bin");
  const originalNpm = path.join(fakeBin, "npm-original");
  const mcporterRoot = path.join(fixtureRoot, "mcporter-runtime");
  const invocationLog = path.join(fixtureRoot, "arguments.json");
  fs.mkdirSync(fakeBin);
  writeJson(path.join(nemoclawRoot, "package.json"), {
    name: "nemoclaw",
    version: "0.1.0",
    dependencies: { tar: "^7.0.0" },
  });
  writeJson(path.join(nemoclawRoot, "package-lock.json"), {
    name: "nemoclaw",
    version: "0.1.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "nemoclaw", version: "0.1.0", dependencies: { tar: "^7.0.0" } },
      "node_modules/tar": {
        version: "7.5.11",
        resolved: "https://registry.npmjs.org/tar/-/tar-7.5.11.tgz",
        integrity: vulnerableIntegrity,
      },
    },
  });
  writeJson(path.join(mcporterRoot, "package.json"), {
    name: "nemoclaw-mcporter-runtime",
    version: "0.0.0",
    dependencies: { mcporter: "0.7.3" },
  });
  writeJson(path.join(mcporterRoot, "package-lock.json"), {
    name: "nemoclaw-mcporter-runtime",
    version: "0.0.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "nemoclaw-mcporter-runtime",
        version: "0.0.0",
        dependencies: { mcporter: "0.7.3" },
      },
      "node_modules/@hono/node-server": {
        version: "1.19.14",
        resolved: "https://registry.npmjs.org/@hono/node-server/-/node-server-1.19.14.tgz",
        integrity:
          "sha512-GwtvgtXxnWsucXvbQXkRgqksiH2Qed37H9xHZocE5sA3N8O8O8/8FA3uclQXxXVzc9XBZuEOMK7+r02FmSpHtw==",
        engines: { node: ">=18.14.1" },
      },
      "node_modules/@modelcontextprotocol/sdk": {
        version: "1.29.0",
        dependencies: { "@hono/node-server": "^1.19.9" },
      },
      "node_modules/mcporter": { version: "0.7.3" },
    },
  });
  fs.writeFileSync(
    originalNpm,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(process.env.INVOCATION_LOG, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_NPM_INSTALL === "1") {
  const target = path.join(process.env.FAKE_NPM_ROOT, "node_modules", "tar");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "tar", version: "7.5.19" }));
}
if (process.env.FAKE_MCPORTER_INSTALL === "1") {
  const target = path.join(process.env.FAKE_MCPORTER_ROOT, "node_modules", "@hono", "node-server");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "@hono/node-server", version: "2.0.10" }));
}
process.exit(Number(process.env.FAKE_NPM_EXIT || 0));
`,
  );
  fs.chmodSync(originalNpm, 0o755);
  const fakeStat = path.join(fakeBin, "stat");
  fs.writeFileSync(fakeStat, "#!/bin/sh\necho 0\n");
  fs.chmodSync(fakeStat, 0o755);
  const wrapper = path.join(fixtureRoot, "npm-wrapper.sh");
  fs.writeFileSync(
    wrapper,
    wrapperSource
      .replace("/usr/local/bin/npm.nemoclaw-original", originalNpm)
      .replace("/usr/local/lib/nemoclaw/npm-tar-security-revision.mts", helper)
      .replace("/usr/local/lib/nemoclaw/mcporter-hono-security-revision.mts", mcporterHelper)
      .replaceAll("/usr/local/lib/nemoclaw/mcporter-runtime", mcporterRoot)
      .replace(
        "/usr/local/lib/nemoclaw/.mcporter-hono-security-revision.XXXXXX",
        `${fixtureRoot}/mcporter-backup.XXXXXX`,
      )
      .replaceAll("/opt/nemoclaw", nemoclawRoot)
      .replace("/opt/.nemoclaw-npm-security-revision.XXXXXX", `${fixtureRoot}/backup.XXXXXX`)
      .replaceAll('"${EUID}" -eq 0', '"0" -eq 0'),
  );
  return { fakeBin, fixtureRoot, invocationLog, mcporterRoot, nemoclawRoot, wrapper };
}

function run(target: ReturnType<typeof fixture>, args: string[], extraEnv: object = {}) {
  return spawnSync("bash", [target.wrapper, ...args], {
    cwd: target.nemoclawRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${target.fakeBin}:${process.env.PATH}`,
      INVOCATION_LOG: target.invocationLog,
      FAKE_NPM_ROOT: target.nemoclawRoot,
      FAKE_MCPORTER_ROOT: target.mcporterRoot,
      ...extraEnv,
    },
  });
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("npm security revision wrapper (#7272)", () => {
  it("delegates non-ci invocations with every argument unchanged", () => {
    const target = fixture();
    const result = run(target, ["--silent", "ci", "argument with spaces"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(target.invocationLog, "utf8"))).toEqual([
      "--silent",
      "ci",
      "argument with spaces",
    ]);
    expect(
      JSON.parse(fs.readFileSync(path.join(target.nemoclawRoot, "package.json"), "utf8"))
        .dependencies.tar,
    ).toBe("^7.0.0");
  });

  it("patches before exact npm ci and verifies the resulting install", () => {
    const target = fixture();
    const result = run(target, ["ci", "--omit=dev", "argument with spaces"], {
      FAKE_NPM_INSTALL: "1",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(target.invocationLog, "utf8"))).toEqual([
      "ci",
      "--omit=dev",
      "argument with spaces",
    ]);
    expect(
      JSON.parse(fs.readFileSync(path.join(target.nemoclawRoot, "package.json"), "utf8"))
        .dependencies.tar,
    ).toBe("7.5.19");
  });

  it("returns the original npm failure and restores historical metadata", () => {
    const target = fixture();
    const result = run(target, ["ci", "--omit=dev"], { FAKE_NPM_EXIT: "23" });
    expect(result.status).toBe(23);
    expect(
      JSON.parse(fs.readFileSync(path.join(target.nemoclawRoot, "package.json"), "utf8"))
        .dependencies.tar,
    ).toBe("^7.0.0");
    expect(
      JSON.parse(fs.readFileSync(path.join(target.nemoclawRoot, "package-lock.json"), "utf8"))
        .packages["node_modules/tar"].version,
    ).toBe("7.5.11");
  });

  it("revises the exact historical mcporter npm ci and verifies its installed Hono", () => {
    const target = fixture();
    const result = run(target, ["--prefix", target.mcporterRoot, "ci", "--omit=dev"], {
      FAKE_MCPORTER_INSTALL: "1",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(target.invocationLog, "utf8"))).toEqual([
      "--prefix",
      target.mcporterRoot,
      "ci",
      "--omit=dev",
    ]);
    expect(
      JSON.parse(fs.readFileSync(path.join(target.mcporterRoot, "package.json"), "utf8")).overrides,
    ).toEqual({ "@hono/node-server": "2.0.10" });
    expect(
      JSON.parse(fs.readFileSync(path.join(target.mcporterRoot, "package-lock.json"), "utf8"))
        .packages["node_modules/@hono/node-server"].version,
    ).toBe("2.0.10");
  });

  it("restores historical mcporter metadata when its npm ci fails", () => {
    const target = fixture();
    const result = run(target, ["--prefix", target.mcporterRoot, "ci", "--omit=dev"], {
      FAKE_NPM_EXIT: "23",
    });
    expect(result.status).toBe(23);
    expect(
      JSON.parse(fs.readFileSync(path.join(target.mcporterRoot, "package.json"), "utf8")).overrides,
    ).toBeUndefined();
    expect(
      JSON.parse(fs.readFileSync(path.join(target.mcporterRoot, "package-lock.json"), "utf8"))
        .packages["node_modules/@hono/node-server"].version,
    ).toBe("1.19.14");
  });
});
