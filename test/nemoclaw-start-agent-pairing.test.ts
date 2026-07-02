// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

function runtimeShellEnvBlock(src: string): string {
  const start = src.indexOf("write_runtime_shell_env() {");
  const end = src.indexOf("# cleanup_on_signal", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

function writeProxyEnvWithGuard() {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-pairing-"));
  const fakeBin = path.join(tmpDir, "bin");
  const proxyEnv = path.join(tmpDir, "proxy-env.sh");
  const commandLog = path.join(tmpDir, "openclaw.log");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, "openclaw"),
    `#!/usr/bin/env bash
printf 'ARGS=%s URL=%s PORT=%s TOKEN=%s\n' "$*" "\${OPENCLAW_GATEWAY_URL-unset}" "\${OPENCLAW_GATEWAY_PORT-unset}" "\${OPENCLAW_GATEWAY_TOKEN-unset}" >> ${JSON.stringify(commandLog)}
exit 0
`,
    { mode: 0o755 },
  );
  const wrapper = [
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
    runtimeShellEnvBlock(src).replaceAll("/tmp/nemoclaw-proxy-env.sh", proxyEnv),
    "write_runtime_shell_env",
  ].join("\n");
  const scriptPath = path.join(tmpDir, "write-env.sh");
  fs.writeFileSync(scriptPath, wrapper, { mode: 0o700 });
  const write = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
  expect(write.status, write.stderr).toBe(0);
  return { tmpDir, fakeBin, proxyEnv, commandLog };
}

function shellOpenclawCommand(args: string[]) {
  return ["openclaw", ...args.map((arg) => JSON.stringify(arg))].join(" ");
}

function runGuardedOpenclaw(setup: ReturnType<typeof writeProxyEnvWithGuard>, args: string[]) {
  return spawnSync(
    "bash",
    [
      "--noprofile",
      "--norc",
      "-c",
      `source ${JSON.stringify(setup.proxyEnv)}; ${shellOpenclawCommand(args)}`,
    ],
    {
      encoding: "utf-8",
      env: { ...process.env, PATH: `${setup.fakeBin}:${process.env.PATH || ""}` },
      timeout: 5000,
    },
  );
}

describe("nemoclaw-start OpenClaw agent pairing recovery (#5324)", () => {
  it("pre-approves allowlisted CLI pairing before agent commands", () => {
    const setup = writeProxyEnvWithGuard();
    const approvedFlag = path.join(setup.tmpDir, "approved.flag");
    fs.writeFileSync(
      path.join(setup.fakeBin, "openclaw"),
      `#!/usr/bin/env bash
printf 'ARGS=%s URL=%s PORT=%s TOKEN=%s\n' "$*" "\${OPENCLAW_GATEWAY_URL-unset}" "\${OPENCLAW_GATEWAY_PORT-unset}" "\${OPENCLAW_GATEWAY_TOKEN-unset}" >> ${JSON.stringify(setup.commandLog)}
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  if [ -f ${JSON.stringify(approvedFlag)} ]; then
    printf '{"pending":[],"paired":[{"clientMode":"cli"}]}\n'
  else
    printf '{"pending":[{"requestId":"pair-1","clientMode":"cli","scopes":["operator.pairing","operator.write"]}],"paired":[]}\n'
  fi
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  [ "\${3:-}" = "pair-1" ] || exit 9
  touch ${JSON.stringify(approvedFlag)}
  printf '{"ok":true}\n'
  exit 0
fi
if [ "\${1:-}" = "agent" ]; then
  if [ -f ${JSON.stringify(approvedFlag)} ]; then
    printf 'agent ok\n'
    exit 0
  fi
  echo 'gateway connect failed: GatewayClientRequestError: device pairing required (requestId: pair-1)' >&2
  exit 1
fi
exit 2
`,
      { mode: 0o755 },
    );

    try {
      const result = runGuardedOpenclaw(setup, ["agent", "--agent", "main", "-m", "hello"]);

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("agent ok");
      expect(result.stderr).not.toContain("device pairing required");
      const commandLog = fs.readFileSync(setup.commandLog, "utf-8");
      expect(commandLog).toContain(
        "ARGS=devices list --json URL=unset PORT=18789 TOKEN=test-gateway-token",
      );
      expect(commandLog).toContain(
        "ARGS=devices approve pair-1 --json URL=unset PORT=unset TOKEN=unset",
      );
      expect(commandLog).toContain(
        "ARGS=agent --agent main -m hello URL=unset PORT=18789 TOKEN=test-gateway-token",
      );
    } finally {
      fs.rmSync(setup.tmpDir, { recursive: true, force: true });
    }
  });

  it("approves and retries when agent creates a new CLI pairing request", () => {
    const setup = writeProxyEnvWithGuard();
    const requestedFlag = path.join(setup.tmpDir, "requested.flag");
    const approvedFlag = path.join(setup.tmpDir, "approved-after-agent.flag");
    fs.writeFileSync(
      path.join(setup.fakeBin, "openclaw"),
      `#!/usr/bin/env bash
printf 'ARGS=%s URL=%s PORT=%s TOKEN=%s\n' "$*" "\${OPENCLAW_GATEWAY_URL-unset}" "\${OPENCLAW_GATEWAY_PORT-unset}" "\${OPENCLAW_GATEWAY_TOKEN-unset}" >> ${JSON.stringify(setup.commandLog)}
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  if [ -f ${JSON.stringify(approvedFlag)} ]; then
    printf '{"pending":[],"paired":[{"clientMode":"cli"}]}\n'
  elif [ -f ${JSON.stringify(requestedFlag)} ]; then
    printf '{"pending":[{"requestId":"pair-after-agent","clientMode":"cli","scopes":["operator.pairing","operator.write"]}],"paired":[]}\n'
  else
    printf '{"pending":[],"paired":[]}\n'
  fi
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  [ "\${3:-}" = "pair-after-agent" ] || exit 9
  touch ${JSON.stringify(approvedFlag)}
  printf '{"ok":true}\n'
  exit 0
fi
if [ "\${1:-}" = "agent" ]; then
  if [ -f ${JSON.stringify(approvedFlag)} ]; then
    printf 'agent ok after retry\n'
    exit 0
  fi
  touch ${JSON.stringify(requestedFlag)}
  echo 'gateway connect failed: GatewayClientRequestError: device pairing required (requestId: pair-after-agent)' >&2
  exit 1
fi
exit 2
`,
      { mode: 0o755 },
    );

    try {
      const result = runGuardedOpenclaw(setup, ["agent", "--agent", "main", "-m", "hello"]);

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("agent ok after retry");
      expect(result.stderr).not.toContain("device pairing required");
      const commandLog = fs.readFileSync(setup.commandLog, "utf-8");
      expect(commandLog).toContain(
        "ARGS=devices list --json URL=unset PORT=18789 TOKEN=test-gateway-token",
      );
      expect(commandLog).toContain(
        "ARGS=devices approve pair-after-agent --json URL=unset PORT=unset TOKEN=unset",
      );
      expect(commandLog.match(/ARGS=agent --agent main -m hello/g) ?? []).toHaveLength(2);
    } finally {
      fs.rmSync(setup.tmpDir, { recursive: true, force: true });
    }
  });
});
