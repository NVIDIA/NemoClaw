// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const requireForTest = createRequire(import.meta.url);
const YAML = requireForTest("yaml");

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");
const RUNTIME_ENV_SHELLS = ["bash", "sh"] as const;

const startScriptSource = fs.readFileSync(START_SCRIPT, "utf-8");

function gatewayWsHostBlock(): string {
  const start = startScriptSource.indexOf('_GATEWAY_WS_HOST="${NEMOCLAW_GATEWAY_WS_HOST:-}"');
  const end = startScriptSource.indexOf('OPENCLAW="$(command -v openclaw)"', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return startScriptSource.slice(start, end);
}

function runtimeShellEnvFunction(): string {
  const start = startScriptSource.indexOf("write_runtime_shell_env() {");
  const end = startScriptSource.indexOf("# cleanup_on_signal", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return startScriptSource.slice(start, end);
}

function startAutoPairFunction(autoPairLog: string): string {
  const start = startScriptSource.indexOf("start_auto_pair() {");
  const endMarker = "\n}\n\n# ── Proxy environment";
  const end = startScriptSource.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return startScriptSource.slice(start, end + 2).replaceAll("/tmp/auto-pair.log", autoPairLog);
}

function writeRuntimeShellEnv(tmpDir: string): string {
  const envFilePath = path.join(tmpDir, "nemoclaw-proxy-env.sh");
  const fn = runtimeShellEnvFunction().replaceAll(
    '"/tmp/nemoclaw-proxy-env.sh"',
    JSON.stringify(envFilePath),
  );
  const script = [
    "set -euo pipefail",
    '_PROXY_URL="http://10.200.0.1:3128"',
    '_NO_PROXY_VAL="localhost,127.0.0.1"',
    `_SANDBOX_SAFETY_NET=${JSON.stringify(path.join(tmpDir, "safety-net.js"))}`,
    `_PROXY_FIX_SCRIPT=${JSON.stringify(path.join(tmpDir, "proxy-fix.js"))}`,
    `_WS_FIX_SCRIPT=${JSON.stringify(path.join(tmpDir, "ws-fix.js"))}`,
    `_NEMOTRON_FIX_SCRIPT=${JSON.stringify(path.join(tmpDir, "nemotron-fix.js"))}`,
    `_SECCOMP_GUARD_SCRIPT=${JSON.stringify(path.join(tmpDir, "seccomp-guard.js"))}`,
    `_CIAO_GUARD_SCRIPT=${JSON.stringify(path.join(tmpDir, "ciao-guard.js"))}`,
    "NODE_USE_ENV_PROXY=",
    "_TOOL_REDIRECTS=()",
    "emit_messaging_connect_runtime_preload_exports() { :; }",
    // Stand-in for the sandbox-init helper: atomically-written ownership is
    // covered separately; this harness exercises the resulting sourced env.
    'emit_sandbox_sourced_file() { cat > "$1"; chmod 444 "$1"; }',
    fn,
    "write_runtime_shell_env",
  ].join("\n");
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    timeout: 5000,
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      OPENCLAW_GATEWAY_PORT: "18790",
      OPENCLAW_GATEWAY_TOKEN: "test-gateway-token",
      OPENCLAW_GATEWAY_URL: "ws://10.200.0.2:18790",
      OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return envFilePath;
}

function runGatewayHostBlock(opts: {
  hostnameOutput?: string;
  insideSandbox?: boolean;
  env?: Record<string, string>;
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gwhost-"));
  try {
    const stub = path.join(tmpDir, "hostname");
    if (opts.hostnameOutput !== undefined) {
      fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "${opts.hostnameOutput}"\n`, {
        mode: 0o755,
      });
    } else {
      fs.writeFileSync(stub, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    }
    const sandboxRoot = path.join(tmpDir, "sandbox-root");
    if (opts.insideSandbox !== false) fs.mkdirSync(sandboxRoot);
    const script = [
      "set -euo pipefail",
      '_DASHBOARD_PORT="${_DASHBOARD_PORT:-18790}"',
      gatewayWsHostBlock(),
      'printf "URL=%s\\n" "$OPENCLAW_GATEWAY_URL"',
      'printf "INSECURE=%s\\n" "${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS:-unset}"',
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf-8",
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${tmpDir}:${process.env.PATH ?? ""}`,
        NEMOCLAW_GATEWAY_WS_HOST: "",
        NEMOCLAW_SANDBOX_ROOT: sandboxRoot,
        OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "",
        ...opts.env,
      },
    });
    expect(result.status).toBe(0);
    return result.stdout;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("gateway websocket url host derivation", () => {
  it("prefers the sandbox primary interface address and enables the private-ws break-glass", () => {
    const out = runGatewayHostBlock({ hostnameOutput: "10.200.0.2 fe80::aaaa" });
    expect(out).toContain("URL=ws://10.200.0.2:18790");
    expect(out).toContain("INSECURE=1");
  });

  it("falls back to loopback without the break-glass when no interface address is detectable", () => {
    const out = runGatewayHostBlock({});
    expect(out).toContain("URL=ws://127.0.0.1:18790");
    expect(out).toContain("INSECURE=unset");
  });

  it("keeps the loopback default outside a sandbox even when an interface address exists", () => {
    const out = runGatewayHostBlock({ hostnameOutput: "192.168.1.50", insideSandbox: false });
    expect(out).toContain("URL=ws://127.0.0.1:18790");
    expect(out).toContain("INSECURE=unset");
  });

  it("honors the NEMOCLAW_GATEWAY_WS_HOST override", () => {
    const out = runGatewayHostBlock({
      hostnameOutput: "10.200.0.2",
      env: { NEMOCLAW_GATEWAY_WS_HOST: "10.77.0.5" },
    });
    expect(out).toContain("URL=ws://10.77.0.5:18790");
    expect(out).toContain("INSECURE=1");
  });

  it("keeps the injected private gateway under a NemoClaw alias for ordinary commands (#4504)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gwenv-"));
    try {
      const envFilePath = path.join(tmpDir, "nemoclaw-proxy-env.sh");
      const fn = runtimeShellEnvFunction().replaceAll(
        '"/tmp/nemoclaw-proxy-env.sh"',
        JSON.stringify(envFilePath),
      );
      const script = [
        "set -u",
        '_PROXY_URL="http://10.200.0.1:3128"',
        '_NO_PROXY_VAL="localhost,127.0.0.1"',
        // Stand-in for the sandbox-init helper: write stdin to the target path.
        'emit_sandbox_sourced_file() { cat > "$1"; }',
        fn,
        "write_runtime_shell_env",
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf-8",
        timeout: 5000,
        env: {
          ...process.env,
          OPENCLAW_GATEWAY_PORT: "18790",
          OPENCLAW_GATEWAY_URL: "ws://10.200.0.2:18790",
          OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const envFile = fs.readFileSync(envFilePath, "utf-8");
      expect(envFile).toContain("export NEMOCLAW_OPENCLAW_GATEWAY_URL='ws://10.200.0.2:18790'");
      expect(envFile).toContain("export NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS='1'");
      expect(envFile).not.toContain("export OPENCLAW_GATEWAY_URL=");
      expect(envFile).not.toContain("export OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=");

      for (const shell of RUNTIME_ENV_SHELLS) {
        const sourced = spawnSync(
          shell,
          [
            "-c",
            [
              `. ${JSON.stringify(envFilePath)}`,
              `. ${JSON.stringify(envFilePath)}`,
              'printf "PUBLIC_URL=%s\\n" "${OPENCLAW_GATEWAY_URL-unset}"',
              'printf "PRIVATE_URL=%s\\n" "${NEMOCLAW_OPENCLAW_GATEWAY_URL-unset}"',
              'printf "TRUSTED_URL=%s\\n" "${_NEMOCLAW_TRUSTED_OPENCLAW_GATEWAY_URL-unset}"',
              'if ( _NEMOCLAW_TRUSTED_OPENCLAW_GATEWAY_URL=ws://attacker.invalid ) 2>/dev/null; then printf "TRUSTED_READONLY=no\\n"; else printf "TRUSTED_READONLY=yes\\n"; fi',
              'printf "PUBLIC_INSECURE=%s\\n" "${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS-unset}"',
              'printf "PRIVATE_INSECURE=%s\\n" "${NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS-unset}"',
              'printf "PORT=%s\\n" "${OPENCLAW_GATEWAY_PORT-unset}"',
            ].join("; "),
          ],
          {
            encoding: "utf-8",
            timeout: 5000,
            env: {
              ...process.env,
              OPENCLAW_GATEWAY_PORT: "18790",
              OPENCLAW_GATEWAY_URL: "ws://10.200.0.2:18790",
              OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
            },
          },
        );
        expect(sourced.status, `${shell}: ${sourced.stderr}`).toBe(0);
        expect(sourced.stdout).toContain("PUBLIC_URL=unset");
        expect(sourced.stdout).toContain("PRIVATE_URL=ws://10.200.0.2:18790");
        expect(sourced.stdout).toContain("TRUSTED_URL=ws://10.200.0.2:18790");
        expect(sourced.stdout).toContain("TRUSTED_READONLY=yes");
        expect(sourced.stdout).toContain("PUBLIC_INSECURE=unset");
        expect(sourced.stdout).toContain("PRIVATE_INSECURE=1");
        expect(sourced.stdout).toContain("PORT=18790");

        const explicitOverride = spawnSync(
          shell,
          [
            "-c",
            `. ${JSON.stringify(envFilePath)}; printf "URL=%s INSECURE=%s\\n" "$OPENCLAW_GATEWAY_URL" "$OPENCLAW_ALLOW_INSECURE_PRIVATE_WS"`,
          ],
          {
            encoding: "utf-8",
            timeout: 5000,
            env: {
              ...process.env,
              OPENCLAW_GATEWAY_URL: "wss://gateway.example.test:443",
              OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "explicit-marker",
            },
          },
        );
        expect(explicitOverride.status, `${shell}: ${explicitOverride.stderr}`).toBe(0);
        expect(explicitOverride.stdout).toContain(
          "URL=wss://gateway.example.test:443 INSECURE=explicit-marker",
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("clears the gateway token when a readonly caller value conflicts with the trust anchor (#6413)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gwenv-conflict-"));
    try {
      const envFilePath = writeRuntimeShellEnv(tmpDir);
      const fakeBin = path.join(tmpDir, "bin");
      const callLog = path.join(tmpDir, "openclaw-calls.log");
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(
        path.join(fakeBin, "openclaw"),
        [
          "#!/bin/sh",
          `printf 'ARGS=%s TOKEN=%s\\n' "$*" "\${OPENCLAW_GATEWAY_TOKEN:-unset}" >> ${JSON.stringify(callLog)}`,
        ].join("\n"),
        { mode: 0o755 },
      );

      for (const shell of RUNTIME_ENV_SHELLS) {
        fs.rmSync(callLog, { force: true });
        const probe = spawnSync(
          shell,
          [
            "-c",
            [
              "_NEMOCLAW_TRUSTED_OPENCLAW_GATEWAY_URL=ws://attacker.invalid:18790",
              "command readonly _NEMOCLAW_TRUSTED_OPENCLAW_GATEWAY_URL",
              `. ${JSON.stringify(envFilePath)} && echo SOURCE_STATUS=unexpected || echo SOURCE_STATUS=blocked`,
              "if command -v _nemoclaw_whatsapp_postpair_start >/dev/null; then echo TOKEN_HELPER=installed; else echo TOKEN_HELPER=disabled; fi",
              "openclaw channels login --channel whatsapp",
              'openclaw gateway call channels.start --params \'{"channel":"whatsapp"}\' --json',
            ].join("\n"),
          ],
          {
            encoding: "utf-8",
            timeout: 5000,
            env: {
              ...process.env,
              PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
              OPENCLAW_GATEWAY_TOKEN: "ambient-gateway-token",
              OPENCLAW_GATEWAY_URL: "ws://attacker.invalid:18790",
            },
          },
        );
        expect(probe.status, `${shell}: ${probe.stderr}`).toBe(0);
        expect(probe.stdout).toContain("SOURCE_STATUS=blocked");
        expect(probe.stdout).toContain("TOKEN_HELPER=disabled");
        expect(probe.stderr).toContain("gateway-token helpers were disabled");

        const calls = fs.readFileSync(callLog, "utf-8").split("\n").filter(Boolean);
        expect(calls).toHaveLength(2);
        expect(calls[0]).toContain("ARGS=channels login --channel whatsapp TOKEN=unset");
        expect(calls[1]).toContain("ARGS=gateway call channels.start");
        expect(calls[1]).toContain("TOKEN=unset");
        expect(calls.every((line) => !line.includes("ambient-gateway-token"))).toBe(true);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses a conflicting anchor when shadowed dispatch cannot clear the token (#6413)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gwenv-conflict-shadow-"));
    try {
      const envFilePath = writeRuntimeShellEnv(tmpDir);
      const fakeBin = path.join(tmpDir, "bin");
      const callLog = path.join(tmpDir, "openclaw-calls.log");
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(
        path.join(fakeBin, "openclaw"),
        '#!/bin/sh\nprintf invoked > "$CALL_LOG"\n',
        {
          mode: 0o755,
        },
      );

      for (const shell of RUNTIME_ENV_SHELLS) {
        fs.writeFileSync(callLog, "");
        const probe = spawnSync(
          shell,
          [
            "-c",
            [
              "_NEMOCLAW_TRUSTED_OPENCLAW_GATEWAY_URL=ws://attacker.invalid:18790",
              "readonly _NEMOCLAW_TRUSTED_OPENCLAW_GATEWAY_URL",
              "command() { :; }",
              `. ${JSON.stringify(envFilePath)}`,
              "openclaw channels login --channel whatsapp",
            ].join("\n"),
          ],
          {
            encoding: "utf-8",
            timeout: 5000,
            env: {
              ...process.env,
              CALL_LOG: callLog,
              PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
              OPENCLAW_GATEWAY_TOKEN: "ambient-gateway-token",
            },
          },
        );
        expect(probe.status, `${shell}: ${probe.stderr}`).toBe(1);
        expect(probe.stderr).toContain(
          "conflicting gateway trust anchor, and the ambient gateway token could not be cleared",
        );
        expect(fs.readFileSync(callLog, "utf-8"), shell).toBe("");
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails closed when shell dispatch cannot make the trust anchor readonly (#6413)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gwenv-mutable-anchor-"));
    try {
      const envFilePath = writeRuntimeShellEnv(tmpDir);

      for (const shell of RUNTIME_ENV_SHELLS) {
        const probe = spawnSync(
          shell,
          [
            "-c",
            [
              "command() { :; }",
              "_NEMOCLAW_TRUSTED_OPENCLAW_GATEWAY_URL=ws://10.200.0.2:18790",
              `. ${JSON.stringify(envFilePath)}`,
            ].join("\n"),
          ],
          {
            encoding: "utf-8",
            timeout: 5000,
            env: {
              ...process.env,
              OPENCLAW_GATEWAY_TOKEN: "ambient-gateway-token",
            },
          },
        );
        expect(probe.status, `${shell}: ${probe.stderr}`).toBe(1);
        expect(probe.stderr).toContain(
          "gateway trust anchor did not become readonly, and the ambient gateway token could not be cleared",
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("strips the gateway token from caller-selected WhatsApp URLs in Bash and POSIX sh (#6413)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gwenv-whatsapp-sh-"));
    try {
      const envFilePath = writeRuntimeShellEnv(tmpDir);
      const fakeBin = path.join(tmpDir, "bin");
      const callLog = path.join(tmpDir, "openclaw-calls.log");
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(
        path.join(fakeBin, "openclaw"),
        [
          "#!/bin/sh",
          `printf 'URL=%s TOKEN=%s\\n' "\${OPENCLAW_GATEWAY_URL:-unset}" "\${OPENCLAW_GATEWAY_TOKEN:-unset}" > ${JSON.stringify(callLog)}`,
        ].join("\n"),
        { mode: 0o755 },
      );

      for (const shell of RUNTIME_ENV_SHELLS) {
        const probe = spawnSync(
          shell,
          ["-c", `. ${JSON.stringify(envFilePath)}; openclaw channels login --channel whatsapp`],
          {
            encoding: "utf-8",
            timeout: 5000,
            env: {
              ...process.env,
              PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
              OPENCLAW_GATEWAY_TOKEN: "ambient-gateway-token",
              OPENCLAW_GATEWAY_URL: "wss://caller-selected.example.test:443",
            },
          },
        );
        expect(probe.status, `${shell}: ${probe.stderr}`).toBe(0);
        expect(fs.readFileSync(callLog, "utf-8")).toBe(
          "URL=wss://caller-selected.example.test:443 TOKEN=unset\n",
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("strips a readonly token from caller-selected WhatsApp URLs without trusting exit (#6413)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gwenv-whatsapp-readonly-"));
    try {
      const envFilePath = writeRuntimeShellEnv(tmpDir);
      const fakeBin = path.join(tmpDir, "bin");
      const callLog = path.join(tmpDir, "openclaw-calls.log");
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(
        path.join(fakeBin, "openclaw"),
        [
          "#!/bin/sh",
          `printf 'TOKEN=%s\\n' "\${OPENCLAW_GATEWAY_TOKEN:-unset}" > ${JSON.stringify(callLog)}`,
        ].join("\n"),
        { mode: 0o755 },
      );

      for (const shell of RUNTIME_ENV_SHELLS) {
        fs.writeFileSync(callLog, "");
        const probe = spawnSync(
          shell,
          [
            "-c",
            [
              `. ${JSON.stringify(envFilePath)}`,
              "command readonly OPENCLAW_GATEWAY_TOKEN",
              ...(shell === "bash" ? ["exit() { :; }"] : []),
              "openclaw channels login --channel whatsapp",
            ].join("\n"),
          ],
          {
            encoding: "utf-8",
            timeout: 5000,
            env: {
              ...process.env,
              PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
              OPENCLAW_GATEWAY_TOKEN: "ambient-gateway-token",
              OPENCLAW_GATEWAY_URL: "wss://caller-selected.example.test:443",
            },
          },
        );
        expect(probe.status, `${shell}: ${probe.stderr}`).toBe(0);
        expect(fs.readFileSync(callLog, "utf-8"), shell).toBe("TOKEN=unset\n");
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails closed when an imported bracket function breaks login parsing (#6413)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gwenv-whatsapp-bracket-"));
    try {
      const envFilePath = writeRuntimeShellEnv(tmpDir);
      const fakeBin = path.join(tmpDir, "bin");
      const callLog = path.join(tmpDir, "openclaw-calls.log");
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(
        path.join(fakeBin, "openclaw"),
        '#!/bin/sh\nprintf invoked > "$CALL_LOG"\n',
        { mode: 0o755 },
      );
      fs.writeFileSync(callLog, "");

      const probe = spawnSync(
        "bash",
        [
          "-c",
          [
            `. ${JSON.stringify(envFilePath)}`,
            "function [ { return 1; }",
            "export OPENCLAW_GATEWAY_URL=wss://caller-selected.example.test:443",
            "openclaw channels login --channel whatsapp",
          ].join("\n"),
        ],
        {
          encoding: "utf-8",
          timeout: 5000,
          env: {
            ...process.env,
            CALL_LOG: callLog,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            OPENCLAW_GATEWAY_TOKEN: "ambient-gateway-token",
          },
        },
      );
      expect(probe.status, probe.stderr).toBe(1);
      expect(probe.stderr).toContain(
        "'openclaw channels login' is only supported inside the sandbox for WhatsApp",
      );
      expect(fs.readFileSync(callLog, "utf-8")).toBe("");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      scenario: "a selective bracket function poisons source-time comparisons",
      setup: [
        "_NEMOCLAW_TRUSTED_OPENCLAW_GATEWAY_URL=wss://caller-selected.example.test:443",
        'function [ { case "$1:$2:$3" in wss://caller-selected.example.test:443:!=:ws://10.200.0.2:18790) return 1 ;; esac; builtin [ "$@"; }',
      ],
    },
    {
      scenario: "a return function continues after a conflicting readonly anchor",
      setup: [
        "_NEMOCLAW_TRUSTED_OPENCLAW_GATEWAY_URL=wss://caller-selected.example.test:443",
        "readonly _NEMOCLAW_TRUSTED_OPENCLAW_GATEWAY_URL",
        "function return { :; }",
      ],
    },
  ])("strips the token when $scenario (#6413)", ({ setup }) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gwenv-source-poison-"));
    try {
      const envFilePath = writeRuntimeShellEnv(tmpDir);
      const fakeBin = path.join(tmpDir, "bin");
      const callLog = path.join(tmpDir, "openclaw-calls.log");
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(
        path.join(fakeBin, "openclaw"),
        [
          "#!/bin/sh",
          `printf 'URL=%s TOKEN=%s\\n' "\${OPENCLAW_GATEWAY_URL:-unset}" "\${OPENCLAW_GATEWAY_TOKEN:-unset}" > ${JSON.stringify(callLog)}`,
        ].join("\n"),
        { mode: 0o755 },
      );

      const probe = spawnSync(
        "bash",
        [
          "-c",
          [
            ...setup,
            `. ${JSON.stringify(envFilePath)}`,
            "export OPENCLAW_GATEWAY_URL=wss://caller-selected.example.test:443",
            "openclaw channels login --channel whatsapp",
          ].join("\n"),
        ],
        {
          encoding: "utf-8",
          timeout: 5000,
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            OPENCLAW_GATEWAY_TOKEN: "ambient-gateway-token",
          },
        },
      );
      expect(probe.status, probe.stderr).toBe(0);
      expect(fs.readFileSync(callLog, "utf-8")).toBe(
        "URL=wss://caller-selected.example.test:443 TOKEN=unset\n",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sources the trusted runtime env for the auto-pair watcher child only (#4504)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-autopair-env-"));
    try {
      const runtimeEnv = writeRuntimeShellEnv(tmpDir);
      const fakeBin = path.join(tmpDir, "bin");
      const fakePython = path.join(fakeBin, "python3");
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(
        fakePython,
        `#!/bin/sh
{
  printf 'PUBLIC_URL=%s\n' "\${OPENCLAW_GATEWAY_URL-unset}"
  printf 'PUBLIC_INSECURE=%s\n' "\${OPENCLAW_ALLOW_INSECURE_PRIVATE_WS-unset}"
  printf 'PRIVATE_URL=%s\n' "\${NEMOCLAW_OPENCLAW_GATEWAY_URL-unset}"
  printf 'PRIVATE_INSECURE=%s\n' "\${NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS-unset}"
  printf 'PORT=%s\n' "\${OPENCLAW_GATEWAY_PORT-unset}"
  printf 'TOKEN=%s\n' "\${OPENCLAW_GATEWAY_TOKEN-unset}"
} > "\${NEMOCLAW_TEST_WATCHER_ENV_LOG}"
`,
        { mode: 0o755 },
      );

      const runWatcher = (name: string, publicUrl: string, publicInsecure: string): string => {
        const watcherEnvLog = path.join(tmpDir, `${name}-watcher-env.log`);
        const autoPairLog = path.join(tmpDir, `${name}-auto-pair.log`);
        const script = [
          "set -euo pipefail",
          'id() { if [ "${1:-}" = "-u" ]; then printf "1000\\n"; else command id "$@"; fi; }',
          `_RUNTIME_SHELL_ENV_FILE=${JSON.stringify(runtimeEnv)}`,
          `OPENCLAW=${JSON.stringify(path.join(tmpDir, "openclaw"))}`,
          "STEP_DOWN_PREFIX_SANDBOX=()",
          "capture_openclaw_pid_start_identity() { return 0; }",
          startAutoPairFunction(autoPairLog),
          "start_auto_pair",
          'wait "$AUTO_PAIR_PID"',
        ].join("\n");
        const result = spawnSync("bash", ["-c", script], {
          encoding: "utf-8",
          timeout: 5000,
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            NODE_OPTIONS: "",
            NEMOCLAW_TEST_WATCHER_ENV_LOG: watcherEnvLog,
            NEMOCLAW_OPENCLAW_GATEWAY_URL: "",
            NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "",
            OPENCLAW_GATEWAY_PORT: "outer-port",
            OPENCLAW_GATEWAY_TOKEN: "outer-token",
            OPENCLAW_GATEWAY_URL: publicUrl,
            OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: publicInsecure,
          },
        });
        expect(result.status, result.stderr || result.stdout).toBe(0);
        return fs.readFileSync(watcherEnvLog, "utf-8");
      };

      const injected = runWatcher("injected", "ws://10.200.0.2:18790", "1");
      expect(injected).toContain("PUBLIC_URL=unset");
      expect(injected).toContain("PUBLIC_INSECURE=unset");
      expect(injected).toContain("PRIVATE_URL=ws://10.200.0.2:18790");
      expect(injected).toContain("PRIVATE_INSECURE=1");
      expect(injected).toContain("PORT=18790");
      expect(injected).toContain("TOKEN=test-gateway-token");

      const explicit = runWatcher("explicit", "wss://gateway.example.test:443", "explicit-marker");
      expect(explicit).toContain("PUBLIC_URL=wss://gateway.example.test:443");
      expect(explicit).toContain("PUBLIC_INSECURE=explicit-marker");
      expect(explicit).toContain("PRIVATE_URL=ws://10.200.0.2:18790");
      expect(explicit).toContain("PRIVATE_INSECURE=1");
      expect(explicit).toContain("PORT=18790");
      expect(explicit).toContain("TOKEN=test-gateway-token");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("omits the break-glass from the runtime shell env when unset", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gwenv-"));
    try {
      const envFilePath = path.join(tmpDir, "nemoclaw-proxy-env.sh");
      const fn = runtimeShellEnvFunction().replaceAll(
        '"/tmp/nemoclaw-proxy-env.sh"',
        JSON.stringify(envFilePath),
      );
      const script = [
        "set -u",
        '_PROXY_URL="http://10.200.0.1:3128"',
        '_NO_PROXY_VAL="localhost,127.0.0.1"',
        // Stand-in for the sandbox-init helper: write stdin to the target path.
        'emit_sandbox_sourced_file() { cat > "$1"; }',
        fn,
        "write_runtime_shell_env",
      ].join("\n");
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf-8",
        timeout: 5000,
        env: {
          ...process.env,
          OPENCLAW_GATEWAY_PORT: "18790",
          OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18790",
          OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "",
        },
      });
      expect(result.status, result.stderr).toBe(0);
      const envFile = fs.readFileSync(envFilePath, "utf-8");
      expect(envFile).toContain("export NEMOCLAW_OPENCLAW_GATEWAY_URL='ws://127.0.0.1:18790'");
      expect(envFile).not.toContain("export NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=");
      expect(envFile).not.toContain("export OPENCLAW_GATEWAY_URL=");
      expect(envFile).not.toContain("export OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("gateway dial-back base policy", () => {
  function loadYaml(relativePath: string): Record<string, unknown> {
    return YAML.parse(
      fs.readFileSync(path.join(import.meta.dirname, "..", relativePath), "utf-8"),
    ) as Record<string, unknown>;
  }

  function dialbackEndpoints(): Array<Record<string, unknown>> {
    const policy = loadYaml("nemoclaw-blueprint/policies/openclaw-sandbox.yaml");
    const networkPolicies = policy.network_policies as Record<string, unknown> | undefined;
    const dialback = networkPolicies?.openclaw_gateway_dialback as
      | { endpoints?: Array<Record<string, unknown>> }
      | undefined;
    return dialback?.endpoints ?? [];
  }

  it("allowlists the sandbox interface gateway endpoints as raw L4 tunnels", () => {
    const endpoints = dialbackEndpoints();
    const byPort = Object.fromEntries(endpoints.map((e) => [e.port as number, e]));
    for (const port of [18789, 18790]) {
      expect(byPort[port], `endpoint for port ${port}`).toBeTruthy();
      expect(byPort[port].host).toBe("10.200.0.2");
      // Raw L4 tunnel — a rest endpoint would break the 101 WS upgrade.
      expect(byPort[port].access).toBe("full");
      expect(byPort[port].allowed_ips).toContain("10.200.0.2");
    }
  });

  it("never targets loopback — the proxy always blocks loopback regardless of policy", () => {
    const endpoints = dialbackEndpoints();
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      expect(endpoint.host).not.toBe("127.0.0.1");
      expect(endpoint.host).not.toBe("localhost");
    }
  });
});
