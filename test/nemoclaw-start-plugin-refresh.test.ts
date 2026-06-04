// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

function extractShellFunction(src: string, name: string): string {
  const header = `${name}() {`;
  const start = src.indexOf(header);
  if (start === -1) {
    throw new Error(`Expected ${name} in scripts/nemoclaw-start.sh`);
  }
  const bodyStart = start + header.length;
  const lines = src.slice(bodyStart).split(/(?<=\n)/);
  let offset = 0;
  for (const line of lines) {
    if (line.replace(/\r?\n$/, "") === "}") {
      return `${name}() {${src.slice(bodyStart, bodyStart + offset)}\n}`;
    }
    offset += line.length;
  }
  throw new Error(`Expected closing brace for ${name} in scripts/nemoclaw-start.sh`);
}

// Extract the post-gateway-start plugin-refresh block from the production
// entrypoint, including the SANDBOX_CHILD_PIDS tracking so the test can
// verify PLUGIN_REFRESH_PID is appended for SIGTERM cleanup. These anchors
// span the full workaround block for #2021 / openclaw/openclaw#89606.
function extractRefreshBlock(): string {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const start = src.indexOf("\nstart_auto_pair\n");
  const end = src.indexOf("SANDBOX_WAIT_PID=", start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      "Expected plugin-refresh + PID-tracking block between start_auto_pair and SANDBOX_WAIT_PID in scripts/nemoclaw-start.sh",
    );
  }
  return [extractShellFunction(src, "start_plugin_registry_refresh"), src.slice(start, end)].join(
    "\n",
  );
}

// Drive the refresh block end-to-end with stubs for `openclaw` and the
// step-down prefix. Returns the temp dir so the caller can inspect the
// stub log and the refresh status sentinel.
function runRefreshBlock(
  opts: { gatewayReadyAfter: number; rootMode?: boolean } = { gatewayReadyAfter: 1, rootMode: true },
): {
  result: ReturnType<typeof spawnSync>;
  refreshLog: string;
  envLog: string;
  callLog: string;
  preRefreshState: string;
  registryState: string;
  tmpDir: string;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-plugin-refresh-"));

  const stubBin = path.join(tmpDir, "openclaw");
  const callLog = path.join(tmpDir, "calls.log");
  const envLog = path.join(tmpDir, "env.log");
  const refreshLog = path.join(tmpDir, "refresh.txt");
  const preRefreshState = path.join(tmpDir, "registry-state.pre.txt");
  const registryState = path.join(tmpDir, "registry-state.txt");
  const readyCounter = path.join(tmpDir, "ready-counter");
  fs.writeFileSync(
    registryState,
    [
      "installRecords:nemoclaw,stale-plugin",
      "plugins:",
      "slash:",
      "allowedSlash:/nemoclaw",
      "staleSlash:",
      "",
    ].join("\n"),
  );

  // Stub `openclaw`: counts `gateway status` calls and only succeeds after
  // `gatewayReadyAfter` invocations. Gateway readiness deliberately requires
  // HOME=/sandbox, matching the sandbox config location and preventing the
  // root-entrypoint regression where readiness probes inherited HOME=/root and
  // skipped the refresh even though the gateway was running.
  fs.writeFileSync(
    stubBin,
    [
      "#!/usr/bin/env bash",
      `echo "$@" >> ${JSON.stringify(callLog)}`,
      `if [ "$1" = "gateway" ] && [ "$2" = "status" ]; then`,
      `  printf 'CALL=gateway status HOME=%s STEP_DOWN_USER=%s USER=%s\\n' "$HOME" "\${STEP_DOWN_USER:-}" "$(id -un)" >> ${JSON.stringify(envLog)}`,
      `  [ "$HOME" = "/sandbox" ] || exit 1`,
      `  count=$(cat ${JSON.stringify(readyCounter)} 2>/dev/null || echo 0)`,
      `  count=$((count + 1))`,
      `  printf '%s' "$count" > ${JSON.stringify(readyCounter)}`,
      `  if [ "$count" -ge ${opts.gatewayReadyAfter} ]; then exit 0; else exit 1; fi`,
      "fi",
      `if [ "$1" = "plugins" ] && [ "$2" = "registry" ] && [ "$3" = "--refresh" ]; then`,
      `  printf 'CALL=plugins registry --refresh HOME=%s STEP_DOWN_USER=%s USER=%s\\n' "$HOME" "\${STEP_DOWN_USER:-}" "$(id -un)" >> ${JSON.stringify(envLog)}`,
      `  cp ${JSON.stringify(registryState)} ${JSON.stringify(preRefreshState)}`,
      `  cat > ${JSON.stringify(registryState)} <<'REGISTRY_STATE'`,
      "installRecords:nemoclaw,stale-plugin",
      "plugins:nemoclaw",
      "slash:/nemoclaw",
      "allowedSlash:/nemoclaw",
      "staleSlash:",
      "REGISTRY_STATE",
      `  printf 'refreshed' > ${JSON.stringify(refreshLog)}`,
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );

  const block = extractRefreshBlock();

  // Wrap the block with a sandbox-shaped harness:
  //   - OPENCLAW=<stub path> so the block invokes our stub
  //   - STEP_DOWN_PREFIX_SANDBOX marks the privilege-drop boundary in root-mode tests
  //   - After spawning, the script PRINTS PLUGIN_REFRESH_PID then waits on it,
  //     so the test can verify both that PLUGIN_REFRESH_PID is set AND that
  //     the backgrounded refresh actually fired.
  const wrapper = [
    "#!/usr/bin/env bash",
    // -e/-u stripped: the production script is invoked by Docker entrypoint with
    // a fully populated env where ${empty_arr[@]} is safe on Linux bash 5; macOS
    // bash 3.2 (CI darwin runner) treats ${empty_arr[@]} as unbound. We want to
    // test the block's behavior, not bash-version env strictness quirks.
    "set -o pipefail",
    `OPENCLAW=${JSON.stringify(stubBin)}`,
    `PLUGIN_REFRESH_LOG=${JSON.stringify(path.join(tmpDir, "production-log.log"))}`,
    opts.rootMode !== false
      ? 'id() { if [ "${1:-}" = "-u" ]; then printf "0"; else command id "$@"; fi; }'
      : 'id() { if [ "${1:-}" = "-u" ]; then printf "1000"; else command id "$@"; fi; }',
    "sleep() { :; }",
    "STEP_DOWN_PREFIX_SANDBOX=(env STEP_DOWN_USER=sandbox)",
    // Stubs for variables the extracted block references that are set
    // earlier in the production script.
    "AUTO_PAIR_PID=",
    "GATEWAY_LOG_TAIL_PID=",
    "GATEWAY_LOG_PERSIST_PID=",
    "GATEWAY_PID=0",
    block,
    "# Surface PLUGIN_REFRESH_PID + tracked SANDBOX_CHILD_PIDS for the test",
    'printf "PLUGIN_REFRESH_PID=%s\\n" "$PLUGIN_REFRESH_PID"',
    'printf "SANDBOX_CHILD_PIDS=%s\\n" "${SANDBOX_CHILD_PIDS[*]}"',
    "# Wait for the backgrounded subshell to complete before exiting",
    'wait "$PLUGIN_REFRESH_PID" 2>/dev/null || true',
  ].join("\n");

  const script = path.join(tmpDir, "run.sh");
  fs.writeFileSync(script, wrapper, { mode: 0o755 });

  const result = spawnSync("bash", [script], {
    encoding: "utf-8",
    timeout: 30000,
    env: { ...process.env, HOME: "/root", USER: "root" }, // adversarial: parent has wrong HOME
  });

  return { result, refreshLog, envLog, callLog, preRefreshState, registryState, tmpDir };
}

describe("plugin refresh log preparation", () => {
  it("rejects a preexisting symlink without truncating its target", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-plugin-refresh-log-"));
    try {
      const refreshLog = path.join(tmpDir, "refresh.log");
      const sensitiveTarget = path.join(tmpDir, "sensitive.txt");
      fs.writeFileSync(sensitiveTarget, "do not truncate");
      fs.symlinkSync(sensitiveTarget, refreshLog);

      const script = path.join(tmpDir, "run.sh");
      fs.writeFileSync(
        script,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `PLUGIN_REFRESH_LOG=${JSON.stringify(refreshLog)}`,
          extractShellFunction(fs.readFileSync(START_SCRIPT, "utf-8"), "prepare_plugin_refresh_log"),
          "prepare_plugin_refresh_log",
        ].join("\n"),
        { mode: 0o755 },
      );

      const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("refusing to use symlinked plugin-refresh log");
      expect(fs.readFileSync(sensitiveTarget, "utf-8")).toBe("do not truncate");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects a preexisting non-regular path", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-plugin-refresh-log-"));
    try {
      const refreshLog = path.join(tmpDir, "refresh.log");
      fs.mkdirSync(refreshLog);

      const script = path.join(tmpDir, "run.sh");
      fs.writeFileSync(
        script,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `PLUGIN_REFRESH_LOG=${JSON.stringify(refreshLog)}`,
          extractShellFunction(fs.readFileSync(START_SCRIPT, "utf-8"), "prepare_plugin_refresh_log"),
          "prepare_plugin_refresh_log",
        ].join("\n"),
        { mode: 0o755 },
      );

      const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("refusing to use non-regular plugin-refresh log");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("replaces a raced-in symlink atomically without touching the target", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-plugin-refresh-log-"));
    try {
      const refreshLog = path.join(tmpDir, "refresh.log");
      const sensitiveTarget = path.join(tmpDir, "sensitive.txt");
      fs.writeFileSync(sensitiveTarget, "do not truncate");

      const script = path.join(tmpDir, "run.sh");
      fs.writeFileSync(
        script,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `PLUGIN_REFRESH_LOG=${JSON.stringify(refreshLog)}`,
          `RACE_TARGET=${JSON.stringify(sensitiveTarget)}`,
          'id() { if [ "${1:-}" = "-u" ]; then printf "0"; else command id "$@"; fi; }',
          'chown() { ln -sfn "$RACE_TARGET" "$PLUGIN_REFRESH_LOG"; return 0; }',
          extractShellFunction(fs.readFileSync(START_SCRIPT, "utf-8"), "prepare_plugin_refresh_log"),
          "prepare_plugin_refresh_log",
        ].join("\n"),
        { mode: 0o755 },
      );

      const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fs.lstatSync(refreshLog).isSymbolicLink()).toBe(false);
      expect((fs.statSync(refreshLog).mode & 0o777).toString(8)).toBe("600");
      expect(fs.readFileSync(sensitiveTarget, "utf-8")).toBe("do not truncate");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("plugin registry refresh workaround (#2021, openclaw/openclaw#89606)", () => {
  it("invokes `openclaw plugins registry --refresh` once the gateway reports ready", () => {
    const { result, refreshLog, callLog, tmpDir } = runRefreshBlock();
    try {
      expect(result.status, `script failed: ${result.stderr}`).toBe(0);
      expect(fs.readFileSync(refreshLog, "utf-8")).toBe("refreshed");
      const calls = fs.readFileSync(callLog, "utf-8");
      expect(calls).toMatch(/^gateway status$/m);
      expect(calls).toMatch(/^plugins registry --refresh$/m);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("forces HOME=/sandbox even when parent env has HOME=/root", () => {
    // The bug class this protects against: running as root with HOME=/root
    // reads /root/.openclaw for gateway readiness and installs/refreshes under
    // /root, which skips the refresh or fails to repopulate runtime plugins[].
    // Both the readiness probe and refresh must override the inherited HOME.
    const { result, envLog, tmpDir } = runRefreshBlock();
    try {
      expect(result.status).toBe(0);
      const envCapture = fs.readFileSync(envLog, "utf-8");
      expect(envCapture).toMatch(/CALL=gateway status HOME=\/sandbox/m);
      expect(envCapture).toMatch(/CALL=plugins registry --refresh HOME=\/sandbox/m);
      expect(envCapture).not.toContain("HOME=/root");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses the sandbox step-down prefix when launched from the root entrypoint path", () => {
    const { result, envLog, tmpDir } = runRefreshBlock();
    try {
      expect(result.status).toBe(0);
      const envCapture = fs.readFileSync(envLog, "utf-8");
      expect(envCapture).toContain("STEP_DOWN_USER=sandbox");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("heals the installRecords-present/plugins-missing slash-router shape without enabling stale records", () => {
    // Regression contract for #2021: the invalid OpenClaw state has persisted
    // installRecords while the runtime plugins/slash-router view forgets the
    // path-origin NemoClaw plugin after policy-changed regeneration. The real
    // registry implementation is upstream; this harness captures the state
    // boundary NemoClaw relies on and proves this startup hook runs the refresh
    // that restores /nemoclaw without treating unrelated stale records as newly
    // allowed slash commands.
    const { result, preRefreshState, registryState, tmpDir } = runRefreshBlock();
    try {
      expect(result.status).toBe(0);
      const before = fs.readFileSync(preRefreshState, "utf-8");
      expect(before).toContain("installRecords:nemoclaw,stale-plugin");
      expect(before).toMatch(/^plugins:$/m);
      expect(before).toMatch(/^slash:$/m);

      const after = fs.readFileSync(registryState, "utf-8");
      expect(after).toContain("plugins:nemoclaw");
      expect(after).toContain("slash:/nemoclaw");
      expect(after).toContain("allowedSlash:/nemoclaw");
      expect(after).toMatch(/^staleSlash:$/m);
      expect(after).not.toContain("/stale-plugin");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips the refresh when the gateway never reports ready", () => {
    const { result, refreshLog, callLog, tmpDir } = runRefreshBlock({ gatewayReadyAfter: 99 });
    try {
      expect(result.status).toBe(0);
      expect(fs.existsSync(refreshLog)).toBe(false);
      const calls = fs.readFileSync(callLog, "utf-8");
      const probeCount = calls.split("\n").filter((l) => l === "gateway status").length;
      expect(probeCount).toBe(10);
      expect(calls).not.toMatch(/^plugins registry --refresh$/m);
      expect(result.stderr).toContain("gateway did not become ready");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("captures PLUGIN_REFRESH_PID and appends it to SANDBOX_CHILD_PIDS", () => {
    // SIGTERM cleanup walks SANDBOX_CHILD_PIDS; the refresh subshell must
    // be reaped or it can outlive the sandbox container by ~10s.
    const { result, tmpDir } = runRefreshBlock();
    try {
      expect(result.status).toBe(0);
      const stdout =
        typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8");
      const pid = stdout.match(/^PLUGIN_REFRESH_PID=(\d+)$/m)?.[1];
      expect(pid).toBeDefined();
      expect(Number(pid)).toBeGreaterThan(0);
      const tracked = stdout.match(/^SANDBOX_CHILD_PIDS=(.+)$/m)?.[1] ?? "";
      expect(tracked.split(/\s+/)).toContain(pid);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("waits for the gateway through several `gateway status` failures before refreshing", () => {
    // Simulates the real cold-start condition where the gateway needs a few
    // seconds to start serving. The loop must keep trying, then refresh once
    // ready. Setting readiness at the 3rd probe checks the loop is actually
    // looping rather than refreshing on the first iteration regardless.
    const { result, refreshLog, callLog, tmpDir } = runRefreshBlock({ gatewayReadyAfter: 3 });
    try {
      expect(result.status).toBe(0);
      expect(fs.readFileSync(refreshLog, "utf-8")).toBe("refreshed");
      const calls = fs.readFileSync(callLog, "utf-8");
      const probeCount = calls.split("\n").filter((l) => l === "gateway status").length;
      expect(probeCount).toBeGreaterThanOrEqual(3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
