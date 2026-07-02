// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

function extractShellFunctionFromSource(src: string, name: string): string {
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

function installAgentPairingFailureFixture(
  setup: ReturnType<typeof writeProxyEnvWithGuard>,
  devicesList: Record<string, unknown>,
) {
  fs.writeFileSync(
    path.join(setup.fakeBin, "openclaw"),
    `#!/usr/bin/env bash
printf 'ARGS=%s URL=%s PORT=%s TOKEN=%s\n' "$*" "\${OPENCLAW_GATEWAY_URL-unset}" "\${OPENCLAW_GATEWAY_PORT-unset}" "\${OPENCLAW_GATEWAY_TOKEN-unset}" >> ${JSON.stringify(setup.commandLog)}
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  printf '%s\n' ${JSON.stringify(JSON.stringify(devicesList))}
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  printf 'unexpected approval for %s\n' "\${3:-}" >&2
  exit 0
fi
if [ "\${1:-}" = "agent" ]; then
  echo 'gateway connect failed: GatewayClientRequestError: device pairing required (requestId: rejected-pairing)' >&2
  exit 1
fi
exit 2
`,
    { mode: 0o755 },
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
    printf '{"pending":[{"requestId":"pair-1","clientId":"cli","clientMode":"cli","scopes":["operator.pairing","operator.write"]}],"paired":[]}\n'
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
      expect(commandLog).toContain("ARGS=devices list --json URL=unset PORT=unset TOKEN=unset");
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
      expect(commandLog).toContain("ARGS=devices list --json URL=unset PORT=unset TOKEN=unset");
      expect(commandLog).toContain(
        "ARGS=devices approve pair-after-agent --json URL=unset PORT=unset TOKEN=unset",
      );
      expect(commandLog.match(/ARGS=agent --agent main -m hello/g) ?? []).toHaveLength(2);
    } finally {
      fs.rmSync(setup.tmpDir, { recursive: true, force: true });
    }
  });

  it("approves and retries when embedded fallback succeeds with a pairing warning (#5324)", () => {
    const setup = writeProxyEnvWithGuard();
    const requestedFlag = path.join(setup.tmpDir, "fallback-requested.flag");
    const approvedFlag = path.join(setup.tmpDir, "fallback-approved.flag");
    fs.writeFileSync(
      path.join(setup.fakeBin, "openclaw"),
      `#!/usr/bin/env bash
printf 'ARGS=%s URL=%s PORT=%s TOKEN=%s\n' "$*" "\${OPENCLAW_GATEWAY_URL-unset}" "\${OPENCLAW_GATEWAY_PORT-unset}" "\${OPENCLAW_GATEWAY_TOKEN-unset}" >> ${JSON.stringify(setup.commandLog)}
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  if [ -f ${JSON.stringify(approvedFlag)} ]; then
    printf '{"pending":[],"paired":[{"clientMode":"cli"}]}\n'
  elif [ -f ${JSON.stringify(requestedFlag)} ]; then
    printf '{"pending":[{"requestId":"pair-after-fallback","clientMode":"cli","scopes":["operator.pairing","operator.write"]}],"paired":[]}\n'
  else
    printf '{"pending":[],"paired":[]}\n'
  fi
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  [ "\${3:-}" = "pair-after-fallback" ] || exit 9
  touch ${JSON.stringify(approvedFlag)}
  printf '{"ok":true}\n'
  exit 0
fi
if [ "\${1:-}" = "agent" ]; then
  if [ -f ${JSON.stringify(approvedFlag)} ]; then
    printf 'gateway answer\n'
    exit 0
  fi
  touch ${JSON.stringify(requestedFlag)}
  printf 'embedded answer\n'
  echo 'gateway connect failed: GatewayClientRequestError: device pairing required (requestId: pair-after-fallback)' >&2
  echo 'EMBEDDED FALLBACK: Gateway agent failed; running embedded agent: pairing required' >&2
  exit 0
fi
exit 2
`,
      { mode: 0o755 },
    );

    try {
      const result = runGuardedOpenclaw(setup, ["agent", "--agent", "main", "-m", "hello"]);

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("gateway answer");
      expect(result.stdout).not.toContain("embedded answer");
      expect(result.stderr).not.toContain("device pairing required");
      expect(result.stderr).not.toContain("EMBEDDED FALLBACK");
      const commandLog = fs.readFileSync(setup.commandLog, "utf-8");
      expect(commandLog).toContain(
        "ARGS=devices approve pair-after-fallback --json URL=unset PORT=unset TOKEN=unset",
      );
      expect(commandLog.match(/ARGS=agent --agent main -m hello/g) ?? []).toHaveLength(2);
    } finally {
      fs.rmSync(setup.tmpDir, { recursive: true, force: true });
    }
  });

  it("wraps one-shot exec agent messages through the runtime guard (#5324)", () => {
    const setup = writeProxyEnvWithGuard();
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const requestedFlag = path.join(setup.tmpDir, "oneshot-requested.flag");
    const approvedFlag = path.join(setup.tmpDir, "oneshot-approved.flag");
    fs.writeFileSync(
      path.join(setup.fakeBin, "openclaw"),
      `#!/usr/bin/env bash
printf 'ARGS=%s URL=%s PORT=%s TOKEN=%s\n' "$*" "\${OPENCLAW_GATEWAY_URL-unset}" "\${OPENCLAW_GATEWAY_PORT-unset}" "\${OPENCLAW_GATEWAY_TOKEN-unset}" >> ${JSON.stringify(setup.commandLog)}
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  if [ -f ${JSON.stringify(approvedFlag)} ]; then
    printf '{"pending":[],"paired":[{"clientMode":"cli"}]}\n'
  elif [ -f ${JSON.stringify(requestedFlag)} ]; then
    printf '{"pending":[{"requestId":"pair-one-shot","clientMode":"cli","scopes":["operator.pairing","operator.write"]}],"paired":[]}\n'
  else
    printf '{"pending":[],"paired":[]}\n'
  fi
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  [ "\${3:-}" = "pair-one-shot" ] || exit 9
  touch ${JSON.stringify(approvedFlag)}
  printf '{"ok":true}\n'
  exit 0
fi
if [ "\${1:-}" = "agent" ]; then
  if [ -f ${JSON.stringify(approvedFlag)} ]; then
    printf 'one-shot gateway answer\n'
    exit 0
  fi
  touch ${JSON.stringify(requestedFlag)}
  printf 'one-shot embedded answer\n'
  echo 'gateway connect failed: GatewayClientRequestError: device pairing required (requestId: pair-one-shot)' >&2
  echo 'EMBEDDED FALLBACK: Gateway agent failed; running embedded agent: pairing required' >&2
  exit 0
fi
exit 2
`,
      { mode: 0o755 },
    );
    const script = [
      "set -euo pipefail",
      `_RUNTIME_SHELL_ENV_FILE=${JSON.stringify(setup.proxyEnv)}`,
      "normalize_mutable_config_perms() { :; }",
      extractShellFunctionFromSource(src, "_nemoclaw_agent_args_include_message"),
      extractShellFunctionFromSource(src, "prepare_oneshot_openclaw_agent_guard"),
      extractShellFunctionFromSource(src, "run_oneshot_command"),
      "NEMOCLAW_CMD=(openclaw agent --agent main -m hello)",
      "prepare_oneshot_openclaw_agent_guard",
      'run_oneshot_command "${NEMOCLAW_CMD[@]}"',
    ].join("\n");

    try {
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf-8",
        env: { ...process.env, PATH: `${setup.fakeBin}:${process.env.PATH || ""}` },
        timeout: 5000,
      });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("one-shot gateway answer");
      expect(result.stdout).not.toContain("one-shot embedded answer");
      expect(result.stderr).not.toContain("device pairing required");
      expect(result.stderr).not.toContain("EMBEDDED FALLBACK");
      const commandLog = fs.readFileSync(setup.commandLog, "utf-8");
      expect(commandLog).toContain(
        "ARGS=devices approve pair-one-shot --json URL=unset PORT=unset TOKEN=unset",
      );
      expect(commandLog.match(/ARGS=agent --agent main -m hello/g) ?? []).toHaveLength(2);
    } finally {
      fs.rmSync(setup.tmpDir, { recursive: true, force: true });
    }
  });

  it("does not inspect pairing requests for non-message agent commands (#5324)", () => {
    const setup = writeProxyEnvWithGuard();
    fs.writeFileSync(
      path.join(setup.fakeBin, "openclaw"),
      `#!/usr/bin/env bash
printf 'ARGS=%s URL=%s PORT=%s TOKEN=%s\n' "$*" "\${OPENCLAW_GATEWAY_URL-unset}" "\${OPENCLAW_GATEWAY_PORT-unset}" "\${OPENCLAW_GATEWAY_TOKEN-unset}" >> ${JSON.stringify(setup.commandLog)}
if [ "\${1:-}" = "devices" ]; then
  echo 'unexpected device approval path' >&2
  exit 9
fi
if [ "\${1:-}" = "agent" ]; then
  printf 'agent help\n'
  exit 0
fi
exit 2
`,
      { mode: 0o755 },
    );

    try {
      const result = runGuardedOpenclaw(setup, ["agent", "--help"]);

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("agent help");
      const commandLog = fs.readFileSync(setup.commandLog, "utf-8");
      expect(commandLog).toContain("ARGS=agent --help");
      expect(commandLog).not.toContain("ARGS=devices list");
      expect(commandLog).not.toContain("ARGS=devices approve");
    } finally {
      fs.rmSync(setup.tmpDir, { recursive: true, force: true });
    }
  });

  const rejectedPairingCases: Array<{
    title: string;
    devicesList: Record<string, unknown>;
  }> = [
    {
      title: "rejects webchat pending requests",
      devicesList: {
        pending: [
          {
            requestId: "pair-webchat",
            clientMode: "webchat",
            scopes: ["operator.pairing", "operator.write"],
          },
        ],
      },
    },
    {
      title: "rejects control-ui pending requests in the agent recovery path",
      devicesList: {
        pending: [
          {
            requestId: "pair-control-ui",
            clientId: "openclaw-control-ui",
            clientMode: "cli",
            scopes: ["operator.pairing", "operator.write"],
          },
        ],
      },
    },
    {
      title: "rejects admin-scope pending requests",
      devicesList: {
        pending: [
          {
            requestId: "pair-admin",
            clientId: "openclaw-cli",
            clientMode: "cli",
            scopes: ["operator.pairing", "operator.write", "operator.admin"],
          },
        ],
      },
    },
    {
      title: "rejects empty scope pending requests",
      devicesList: {
        pending: [
          {
            requestId: "pair-empty-scopes",
            clientId: "openclaw-cli",
            clientMode: "cli",
            scopes: [],
          },
        ],
      },
    },
    {
      title: "rejects missing scope pending requests",
      devicesList: {
        pending: [
          {
            requestId: "pair-missing-scopes",
            clientId: "openclaw-cli",
            clientMode: "cli",
          },
        ],
      },
    },
    {
      title: "rejects request IDs containing whitespace",
      devicesList: {
        pending: [
          {
            requestId: "pair whitespace",
            clientId: "openclaw-cli",
            clientMode: "cli",
            scopes: ["operator.pairing", "operator.write"],
          },
        ],
      },
    },
    {
      title: "rejects paired-device identity mismatches",
      devicesList: {
        pending: [
          {
            requestId: "pair-mismatch",
            clientId: "openclaw-cli",
            clientMode: "cli",
            role: "operator",
            deviceId: "cli-device",
            publicKey: "request-key",
            scopes: ["operator.pairing", "operator.write"],
          },
        ],
        paired: [
          {
            clientId: "openclaw-cli",
            clientMode: "cli",
            role: "operator",
            deviceId: "cli-device",
            publicKey: "paired-key",
            scopes: ["operator.pairing"],
          },
        ],
      },
    },
  ];

  for (const { title, devicesList } of rejectedPairingCases) {
    it(`${title} (#5324)`, () => {
      const setup = writeProxyEnvWithGuard();
      installAgentPairingFailureFixture(setup, devicesList);

      try {
        const result = runGuardedOpenclaw(setup, ["agent", "--agent", "main", "-m", "hello"]);

        expect(result.status, result.stderr || result.stdout).toBe(1);
        expect(result.stderr).toContain("device pairing required");
        const commandLog = fs.readFileSync(setup.commandLog, "utf-8");
        expect(commandLog).toContain("ARGS=devices list --json URL=unset PORT=unset TOKEN=unset");
        expect(commandLog).toContain(
          "ARGS=agent --agent main -m hello URL=unset PORT=18789 TOKEN=test-gateway-token",
        );
        expect(commandLog).not.toContain("ARGS=devices approve");
      } finally {
        fs.rmSync(setup.tmpDir, { recursive: true, force: true });
      }
    });
  }
});
