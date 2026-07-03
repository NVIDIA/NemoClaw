// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const START_SCRIPT = path.resolve(import.meta.dirname, "../scripts/nemoclaw-start.sh");

function runtimeShellEnvBlock(source: string): string {
  const start = source.indexOf("write_runtime_shell_env() {");
  const end = source.indexOf("# cleanup_on_signal", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function installRuntimeShellEnv(tmpDir: string): { proxyEnv: string; fakeBin: string } {
  const fakeBin = path.join(tmpDir, "bin");
  const proxyEnv = path.join(tmpDir, "proxy-env.sh");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "openclaw"),
    `#!/usr/bin/env bash
printf '%s:%s:%s\n' "\${OPENCLAW_GATEWAY_URL:-unset}" "\${OPENCLAW_GATEWAY_PORT:-unset}" "\${OPENCLAW_GATEWAY_TOKEN:-unset}" > "\${APPROVAL_ENV_LOG}"
printf 'gateway-result\n'
exit "\${APPROVAL_EXIT_CODE:-0}"
`,
    { mode: 0o755 },
  );

  const source = fs.readFileSync(START_SCRIPT, "utf8");
  const block = `${runtimeShellEnvBlock(source)}\nwrite_runtime_shell_env`.replaceAll(
    "/tmp/nemoclaw-proxy-env.sh",
    proxyEnv,
  );
  const writer = path.join(tmpDir, "write-env.sh");
  fs.writeFileSync(
    writer,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
      'PROXY_HOST="10.200.0.1"',
      'PROXY_PORT="3128"',
      '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
      '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
      '_SANDBOX_SAFETY_NET="/tmp/safety-net.js"',
      '_PROXY_FIX_SCRIPT="/tmp/http-proxy-fix.js"',
      '_NEMOTRON_FIX_SCRIPT="/tmp/nemotron-fix.js"',
      '_SECCOMP_GUARD_SCRIPT="/tmp/seccomp-guard.js"',
      '_CIAO_GUARD_SCRIPT="/tmp/ciao-guard.js"',
      "emit_messaging_connect_runtime_preload_exports() { :; }",
      'export OPENCLAW_GATEWAY_URL="ws://127.0.0.1:18789"',
      'export OPENCLAW_GATEWAY_PORT="18789"',
      'export OPENCLAW_GATEWAY_TOKEN="test-gateway-token"',
      "_TOOL_REDIRECTS=()",
      "set +u",
      block,
    ].join("\n"),
    { mode: 0o700 },
  );
  const result = spawnSync("bash", [writer], { encoding: "utf8", timeout: 5_000 });
  expect(result.status, result.stderr).toBe(0);
  return { proxyEnv, fakeBin };
}

describe("nemoclaw-start device approval wrapper (#4462)", () => {
  it.each([
    ["success", 0],
    ["failure", 17],
  ])("returns the gateway CLI %s status without touching device state", (_label, exitCode) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-approval-wrapper-"));
    try {
      const { proxyEnv, fakeBin } = installRuntimeShellEnv(tmpDir);
      const devicesDir = path.join(tmpDir, "state", "devices");
      fs.mkdirSync(devicesDir, { recursive: true });
      const pendingFile = path.join(devicesDir, "pending.json");
      const pairedFile = path.join(devicesDir, "paired.json");
      const pendingBefore = '{"request":{"requestId":"request-1"}}\n';
      const pairedBefore = '{"device":{"tokens":{"operator":{"token":"keep-me"}}}}\n';
      fs.writeFileSync(pendingFile, pendingBefore);
      fs.writeFileSync(pairedFile, pairedBefore);
      const envLog = path.join(tmpDir, "approval-env.log");

      const result = spawnSync(
        "bash",
        [
          "--noprofile",
          "--norc",
          "-c",
          `source ${JSON.stringify(proxyEnv)}; openclaw devices approve request-1 --json`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            OPENCLAW_STATE_DIR: path.join(tmpDir, "state"),
            APPROVAL_ENV_LOG: envLog,
            APPROVAL_EXIT_CODE: String(exitCode),
          },
          timeout: 5_000,
        },
      );

      expect(result.status).toBe(exitCode);
      expect(result.stdout).toContain("gateway-result");
      expect(fs.readFileSync(envLog, "utf8").trim()).toBe("unset:unset:unset");
      expect(fs.readFileSync(pendingFile, "utf8")).toBe(pendingBefore);
      expect(fs.readFileSync(pairedFile, "utf8")).toBe(pairedBefore);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
