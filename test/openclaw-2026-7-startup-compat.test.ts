// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const NORMALIZER = path.join(ROOT, "scripts", "lib", "normalize_mutable_config_perms.py");
const START_SCRIPT = path.join(ROOT, "scripts", "nemoclaw-start.sh");
const temporaryRoots: string[] = [];

function temporaryConfigDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-2026-7-"));
  temporaryRoots.push(root);
  const configDir = path.join(root, ".openclaw");
  fs.mkdirSync(configDir);
  return configDir;
}

function repairUpdateCheck(configDir: string) {
  return spawnSync("python3", ["-I", NORMALIZER, "remove-legacy-update-check", configDir], {
    encoding: "utf-8",
    timeout: 5000,
  });
}

function extractShellFunction(source: string, name: string): string {
  const match = source.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  assert(match, `Expected ${name} in scripts/nemoclaw-start.sh`);
  return `${name}() {${match[1]}\n}`;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("OpenClaw 2026.7 startup compatibility", () => {
  it("removes a zero-byte legacy update-check file", () => {
    const configDir = temporaryConfigDir();
    const statePath = path.join(configDir, "update-check.json");
    fs.writeFileSync(statePath, "", { mode: 0o640 });
    const result = repairUpdateCheck(configDir);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("removes nonempty legacy update-check cache state", () => {
    const configDir = temporaryConfigDir();
    const statePath = path.join(configDir, "update-check.json");
    const content = '{"lastCheck":123}\n';
    fs.writeFileSync(statePath, content);

    const result = repairUpdateCheck(configDir);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it.skipIf(process.platform !== "linux" || (process.getuid?.() ?? -1) !== 0)(
    "retains but accepts a stable cache under the non-root shields-up topology",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-sealed-cache-"));
      temporaryRoots.push(root);
      const sandboxDir = path.join(root, "sandbox");
      const configDir = path.join(sandboxDir, ".openclaw");
      const statePath = path.join(configDir, "update-check.json");
      const sandboxGid = 65_534;
      const gatewayUid = 65_532;
      fs.chmodSync(root, 0o755);
      fs.mkdirSync(sandboxDir);
      fs.chownSync(sandboxDir, 0, sandboxGid);
      fs.chmodSync(sandboxDir, 0o1775);
      fs.mkdirSync(configDir);
      fs.chownSync(configDir, 0, 0);
      fs.chmodSync(configDir, 0o755);
      fs.writeFileSync(statePath, '{"lastCheck":123}\n', { mode: 0o644 });
      fs.chownSync(statePath, 0, 0);

      const result = spawnSync(
        "python3",
        [
          "-I",
          "-c",
          [
            "import importlib.util, os, sys, types",
            "spec = importlib.util.spec_from_file_location('normalizer', sys.argv[1])",
            "module = importlib.util.module_from_spec(spec)",
            "spec.loader.exec_module(module)",
            "sandbox_gid = int(sys.argv[3])",
            "module.grp.getgrnam = lambda _name: types.SimpleNamespace(gr_gid=sandbox_gid)",
            "os.setgroups([sandbox_gid])",
            "os.setgid(sandbox_gid)",
            "os.setuid(int(sys.argv[4]))",
            "raise SystemExit(module.remove_legacy_update_check(sys.argv[2]))",
          ].join("\n"),
          NORMALIZER,
          configDir,
          String(sandboxGid),
          String(gatewayUid),
        ],
        { encoding: "utf8", timeout: 5000 },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("Retained protected legacy");
      expect(fs.readFileSync(statePath, "utf8")).toBe('{"lastCheck":123}\n');
    },
  );

  it.each([
    "symlink",
    "directory",
    "hardlink",
  ] as const)("rejects a %s update-check path", (kind) => {
    const configDir = temporaryConfigDir();
    const statePath = path.join(configDir, "update-check.json");
    const target = path.join(path.dirname(configDir), "target.json");
    switch (kind) {
      case "symlink":
        fs.writeFileSync(target, "");
        fs.symlinkSync(target, statePath);
        break;
      case "directory":
        fs.mkdirSync(statePath);
        break;
      case "hardlink":
        fs.writeFileSync(target, "{}");
        fs.linkSync(target, statePath);
        break;
    }

    const result = repairUpdateCheck(configDir);

    expect(result.status).toBe(1);
  });

  it("starts the root-mode gateway with the sandbox home", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-home-"));
    temporaryRoots.push(root);
    const observedHome = path.join(root, "observed-home");
    const gatewayLog = path.join(root, "gateway.log");
    const gateway = path.join(root, "openclaw-fixture");
    fs.writeFileSync(
      gateway,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$HOME" >${JSON.stringify(observedHome)}\n`,
      { mode: 0o700 },
    );
    const source = fs.readFileSync(START_SCRIPT, "utf-8");
    const launch = extractShellFunction(source, "launch_openclaw_gateway").replaceAll(
      "/tmp/gateway.log",
      gatewayLog,
    );
    const runner = path.join(root, "run.sh");
    fs.writeFileSync(
      runner,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "export HOME=/root",
        "STEP_DOWN_PREFIX_GATEWAY=()",
        `OPENCLAW=${JSON.stringify(gateway)}`,
        "_DASHBOARD_PORT=18789",
        "arm_openclaw_gateway_supervisor_cleanup() { :; }",
        "mark_in_container_gateway() { :; }",
        "capture_openclaw_pid_start_identity() { printf -v \"$2\" '%s' test-identity; }",
        "record_gateway_pid() { :; }",
        launch,
        "launch_openclaw_gateway",
        'wait "$GATEWAY_PID"',
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = spawnSync("bash", [runner], { encoding: "utf-8", timeout: 5000 });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(observedHome, "utf-8").trim()).toBe("/sandbox");
  });
});
