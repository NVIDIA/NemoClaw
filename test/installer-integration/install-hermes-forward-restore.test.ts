// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  INSTALLER_PAYLOAD,
  TEST_SYSTEM_PATH,
  writeExecutable,
} from "../helpers/installer-sourced-env";

const REPO_ROOT = path.join(import.meta.dirname, "../..");

function restore(env: Record<string, string | undefined>) {
  return spawnSync(
    "bash",
    ["-c", `source "${INSTALLER_PAYLOAD}" 2>/dev/null; restore_onboard_forward_after_post_checks`],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { HOME: os.tmpdir(), PATH: TEST_SYSTEM_PATH, ...env },
    },
  );
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemohermes-forward-recover-"));
  const bin = path.join(root, "bin");
  const state = path.join(root, ".nemoclaw");
  const cliLog = path.join(root, "cli.log");
  const openshellLog = path.join(root, "openshell.log");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  fs.writeFileSync(
    path.join(state, "onboard-session.json"),
    JSON.stringify({ sandboxName: "created-by-onboard", agent: "hermes" }),
  );
  fs.writeFileSync(
    path.join(state, "sandboxes.json"),
    JSON.stringify({ sandboxes: { "created-by-onboard": { hermesApiPort: 8647 } } }),
  );
  writeExecutable(
    path.join(bin, "nemoclaw"),
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$CLI_LOG\"\nexit \"${CLI_STATUS:-0}\"\n",
  );
  fs.symlinkSync(path.join(bin, "nemoclaw"), path.join(bin, "nemohermes"));
  writeExecutable(
    path.join(bin, "openshell"),
    "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$OPENSHELL_LOG\"\nexit 0\n",
  );
  writeExecutable(path.join(bin, "curl"), "#!/usr/bin/env bash\nexit \"${CURL_STATUS:-0}\"\n");
  const env = {
    HOME: root,
    PATH: `${bin}:${TEST_SYSTEM_PATH}`,
    CLI_LOG: cliLog,
    OPENSHELL_LOG: openshellLog,
  };
  return { bin, cliLog, env, openshellLog, root, state };
}

function seedLegacyWatcher(
  h: ReturnType<typeof fixture>,
  sandboxArgument = "created-by-onboard",
): { pid: number; pidFile: string; watcherScript: string } {
  const runtimeState = path.join(h.state, "state");
  const pidFile = path.join(runtimeState, "hermes-created-by-onboard-8647.forward.pid");
  const watcherScript = `${pidFile}.js`;
  const node = path.join(h.bin, "node");
  const openshell = path.join(h.bin, "openshell");
  fs.mkdirSync(runtimeState, { recursive: true });
  fs.writeFileSync(watcherScript, "setInterval(() => undefined, 1000);\n");
  const started = spawnSync(
    "bash",
    [
      "-c",
      'nohup "$1" "$2" "$3" "$4" "$5" >/dev/null 2>&1 & printf "%s" "$!"',
      "legacy-forward-watcher",
      node,
      watcherScript,
      openshell,
      "8647",
      sandboxArgument,
    ],
    { encoding: "utf8", env: h.env },
  );
  const pid = Number(started.stdout);
  expect(started.status, started.stderr).toBe(0);
  expect(Number.isSafeInteger(pid)).toBe(true);
  fs.writeFileSync(pidFile, `${String(pid)}\n`);
  return { pid, pidFile, watcherScript };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForProcessExit(pid: number): boolean {
  const deadline = Date.now() + 5_000;
  while (processExists(pid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return !processExists(pid);
}

function stopFixtureProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already stopped by the migration path.
  }
}

function expectRecovery(h: ReturnType<typeof fixture>): void {
  const result = restore(h.env);
  expect(result.status, result.stderr).toBe(0);
  expect(fs.readFileSync(h.cliLog, "utf8").trim()).toBe("created-by-onboard recover");
  expect(fs.existsSync(h.openshellLog)).toBe(false);
}

describe("Hermes installer forward restore", () => {
  it("always invokes identity-bound recovery before accepting healthy transport", () => {
    const h = fixture();
    try {
      expectRecovery(h);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("retires only an exact legacy watcher before ForwardTcp recovery", () => {
    const h = fixture();
    const watcher = seedLegacyWatcher(h);
    try {
      expectRecovery(h);
      expect(waitForProcessExit(watcher.pid)).toBe(true);
      expect(fs.existsSync(watcher.pidFile)).toBe(false);
      expect(fs.existsSync(watcher.watcherScript)).toBe(false);
    } finally {
      stopFixtureProcess(watcher.pid);
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("leaves an argument-mismatched legacy watcher and its evidence untouched", () => {
    const h = fixture();
    const watcher = seedLegacyWatcher(h, "different-sandbox");
    try {
      const result = restore(h.env);
      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("leaving it untouched");
      expect(processExists(watcher.pid)).toBe(true);
      expect(fs.existsSync(watcher.pidFile)).toBe(true);
      expect(fs.existsSync(watcher.watcherScript)).toBe(true);
      expect(fs.existsSync(h.cliLog)).toBe(false);
    } finally {
      stopFixtureProcess(watcher.pid);
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed before recovery when the registered Hermes port is unavailable", () => {
    const h = fixture();
    try {
      fs.writeFileSync(path.join(h.state, "sandboxes.json"), JSON.stringify({ sandboxes: {} }));
      const result = restore(h.env);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("registered API port");
      expect(fs.existsSync(h.cliLog)).toBe(false);
    } finally {
      fs.rmSync(h.root, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails when recovery fails or its post-recovery health probe is unhealthy", () => {
    const recoveryFailure = fixture();
    const healthFailure = fixture();
    try {
      expect(restore({ ...recoveryFailure.env, CLI_STATUS: "1" }).status).toBe(1);
      const unhealthy = restore({ ...healthFailure.env, CURL_STATUS: "1" });
      expect(unhealthy.status).toBe(1);
      expect(`${unhealthy.stdout}\n${unhealthy.stderr}`).toContain("created-by-onboard status");
    } finally {
      fs.rmSync(recoveryFailure.root, { recursive: true, force: true });
      fs.rmSync(healthFailure.root, { recursive: true, force: true });
    }
  }, 45_000);
});
