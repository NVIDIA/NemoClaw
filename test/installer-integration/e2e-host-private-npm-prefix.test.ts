// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.
// All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { HostCliClient } from "../e2e/fixtures/clients/host.ts";
import type { CommandRunner } from "../e2e/fixtures/clients/command.ts";

const INSTALLER = path.join(import.meta.dirname, "../../scripts/install.sh");
const LINK = 'source "$1" >/dev/null 2>&1; link_nemoclaw_cli "$2"';

const runner: CommandRunner = {
  async run(command, options = {}) {
    const result = spawnSync(command.command, command.args, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      timeout: 30_000,
    });
    return {
      command: [command.command, ...command.args],
      exitCode: result.status,
      signal: result.signal,
      timedOut: result.error?.message.includes("ETIMEDOUT") ?? false,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error?.message ?? "",
      artifacts: { stdout: "", stderr: "", result: "" },
    };
  },
};

function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "e2e-npm-prefix-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const source = path.join(root, "source");
  const shared = path.join(root, "shared-prefix");
  for (const directory of [home, source, shared]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(shared, 0o775);
  fs.writeFileSync(path.join(source, ".npmrc"), `prefix=${shared}\n`);
  fs.writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "nemoclaw-e2e-private-prefix-probe",
      version: "1.0.0",
      bin: { "private-prefix-probe": "probe.sh" },
    }),
  );
  fs.writeFileSync(path.join(source, "probe.sh"), "#!/bin/sh\nprintf 'private-prefix-ok\\n'\n", {
    mode: 0o755,
  });
  const globalConfig = path.join(root, "empty-global.npmrc");
  fs.writeFileSync(globalConfig, "");
  const env = {
    HOME: home,
    PATH: [path.join(home, ".npm-global", "bin"), process.env.PATH].join(path.delimiter),
    NPM_CONFIG_USERCONFIG: path.join(home, ".npmrc"),
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  };
  return { home, source, shared, env, host: new HostCliClient(runner) };
}

it.skipIf(process.platform === "win32")(
  "links and executes the E2E CLI privately when the configured npm prefix is shared",
  async () => {
    const f = fixture();
    const baseline = spawnSync("bash", ["-c", LINK, "bash", INSTALLER, f.source], {
      cwd: f.source,
      env: f.env,
      encoding: "utf8",
    });
    expect(baseline.status).toBe(1);
    expect(baseline.stderr).toContain("Unsafe npm executable directory");

    const linked = await f.host.command("bash", ["-c", LINK, "bash", INSTALLER, f.source], {
      cwd: f.source,
      env: f.env,
    });
    expect(linked.exitCode, linked.stdout + linked.stderr).toBe(0);
    const privatePrefix = path.join(f.home, ".npm-global");
    expect(fs.statSync(privatePrefix).mode & 0o022).toBe(0);
    expect(
      fs.lstatSync(path.join(privatePrefix, "bin", "private-prefix-probe")).isSymbolicLink(),
    ).toBe(true);
    const probe = await f.host.command("private-prefix-probe", [], { env: f.env });
    expect(probe.exitCode, probe.stderr).toBe(0);
    expect(probe.stdout.trim()).toBe("private-prefix-ok");
    expect(fs.statSync(f.shared).mode & 0o777).toBe(0o775);
    expect(fs.readdirSync(f.shared)).toEqual([]);
    expect(f.env).not.toHaveProperty("NPM_CONFIG_PREFIX");
  },
);

it.skipIf(process.platform === "win32").each(["NPM_CONFIG_PREFIX", "npm_config_prefix"])(
  "preserves an explicit %s and the installer's unsafe-prefix rejection",
  async (key) => {
    const f = fixture();
    const result = await f.host.command("bash", ["-c", LINK, "bash", INSTALLER, f.source], {
      cwd: f.source,
      env: { ...f.env, [key]: f.shared },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Unsafe npm executable directory");
    expect(fs.statSync(f.shared).mode & 0o777).toBe(0o775);
    expect(fs.readdirSync(f.shared)).toEqual([]);
    expect(fs.existsSync(path.join(f.home, ".npm-global"))).toBe(false);
  },
);
