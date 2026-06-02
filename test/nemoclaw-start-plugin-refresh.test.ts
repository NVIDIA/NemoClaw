// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

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
  return src.slice(start, end);
}

// Drive the refresh block end-to-end with stubs for `openclaw` and the
// step-down prefix. Returns the temp dir so the caller can inspect the
// stub log and the refresh status sentinel.
function runRefreshBlock(opts: { gatewayReadyAfter: number } = { gatewayReadyAfter: 1 }): {
  result: ReturnType<typeof spawnSync>;
  refreshLog: string;
  envLog: string;
  callLog: string;
  tmpDir: string;
} {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-plugin-refresh-"));

  const stubBin = path.join(tmpDir, "openclaw");
  const callLog = path.join(tmpDir, "calls.log");
  const envLog = path.join(tmpDir, "env.log");
  const refreshLog = path.join(tmpDir, "refresh.txt");
  const readyCounter = path.join(tmpDir, "ready-counter");

  // Stub `openclaw`: counts `gateway status` calls and only succeeds after
  // `gatewayReadyAfter` invocations. Records every other invocation +
  // critical env vars (HOME, USER) so the test can verify them.
  fs.writeFileSync(
    stubBin,
    [
      "#!/usr/bin/env bash",
      `echo "$@" >> ${JSON.stringify(callLog)}`,
      `if [ "$1" = "gateway" ] && [ "$2" = "status" ]; then`,
      `  count=$(cat ${JSON.stringify(readyCounter)} 2>/dev/null || echo 0)`,
      `  count=$((count + 1))`,
      `  printf '%s' "$count" > ${JSON.stringify(readyCounter)}`,
      `  if [ "$count" -ge ${opts.gatewayReadyAfter} ]; then exit 0; else exit 1; fi`,
      "fi",
      `if [ "$1" = "plugins" ] && [ "$2" = "registry" ] && [ "$3" = "--refresh" ]; then`,
      `  printf 'HOME=%s\\nUSER=%s\\n' "$HOME" "$(id -un)" > ${JSON.stringify(envLog)}`,
      `  printf 'refreshed' > ${JSON.stringify(refreshLog)}`,
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );

  const block = extractRefreshBlock().replace(
    "/tmp/nemoclaw-plugin-refresh.log",
    path.join(tmpDir, "production-log.log"),
  );

  // Wrap the block with a sandbox-shaped harness:
  //   - OPENCLAW=<stub path> so the block invokes our stub
  //   - STEP_DOWN_PREFIX_SANDBOX=() empty array (no privilege drop in tests)
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
    "STEP_DOWN_PREFIX_SANDBOX=()",
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

  return { result, refreshLog, envLog, callLog, tmpDir };
}

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
    // installs to /root/.openclaw/extensions and does NOT repopulate the
    // runtime plugins[]. The block must override the inherited HOME.
    const { result, envLog, tmpDir } = runRefreshBlock();
    try {
      expect(result.status).toBe(0);
      const envCapture = fs.readFileSync(envLog, "utf-8");
      expect(envCapture).toContain("HOME=/sandbox");
      expect(envCapture).not.toContain("HOME=/root");
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
      const pid = result.stdout.match(/^PLUGIN_REFRESH_PID=(\d+)$/m)?.[1];
      expect(pid).toBeDefined();
      expect(Number(pid)).toBeGreaterThan(0);
      const tracked = result.stdout.match(/^SANDBOX_CHILD_PIDS=(.+)$/m)?.[1] ?? "";
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
