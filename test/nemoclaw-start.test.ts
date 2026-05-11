// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");
const PRELOAD_SCRIPTS = path.join(import.meta.dirname, "..", "nemoclaw-blueprint", "scripts");

function configureGuardBlock(src: string): string {
  const start = src.indexOf("# nemoclaw-configure-guard begin");
  const end = src.indexOf("# nemoclaw-configure-guard end", start);
  const endMarker = "# nemoclaw-configure-guard end";
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end + endMarker.length);
}

function runtimeShellEnvBlock(src: string): string {
  const start = src.indexOf("write_runtime_shell_env() {");
  const end = src.indexOf("# cleanup_on_signal", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

function runtimeShellEnvShimBlock(src: string): string {
  const start = src.indexOf("ensure_runtime_shell_env_shim() {");
  const end = src.indexOf("# ── Legacy layout migration", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

function nonRootFallbackBlock(src: string): string {
  const start = src.indexOf("# ── Non-root fallback");
  const end = src.indexOf("# ── Root path", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

function startScriptHeredoc(src: string, marker: string): string {
  const match = src.match(new RegExp(`<<'${marker}'[^\\n]*\\n([\\s\\S]*?)\\n${marker}`));
  if (match) return match[1];
  const preloadByMarker: Record<string, string> = {
    CIAO_GUARD_EOF: "ciao-network-guard.js",
    SAFETY_NET_EOF: "sandbox-safety-net.js",
    SLACK_GUARD_EOF: "slack-channel-guard.js",
    TELEGRAM_DIAGNOSTICS_EOF: "telegram-diagnostics.js",
  };
  const preload = preloadByMarker[marker];
  expect(preload).toBeTruthy();
  return fs.readFileSync(path.join(PRELOAD_SCRIPTS, preload), "utf-8");
}

function extractShellFunctionFromSource(src: string, name: string): string {
  const match = src.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
  if (!match) {
    throw new Error(`Expected ${name} in scripts/nemoclaw-start.sh`);
  }
  return `${name}() {${match[1]}\n}`;
}

function runEmbeddedPreload(
  script: string,
  argv1: string,
  argv2: string,
  title = "node",
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [
      "-e",
      `process.env.OPENSHELL_SANDBOX = '1';
process.title = ${JSON.stringify(title)};
process.argv[1] = ${JSON.stringify(argv1)};
process.argv[2] = ${JSON.stringify(argv2)};
${script}`,
    ],
    { encoding: "utf-8" },
  );
}

function startScriptLine(src: string, needle: string): string {
  const start = src.indexOf(needle);
  if (start === -1) {
    throw new Error(`Expected line containing ${needle} in scripts/nemoclaw-start.sh`);
  }
  const end = src.indexOf("\n", start);
  return src.slice(start, end === -1 ? undefined : end);
}

function nonRootIntegrityGateBlock(src: string): string {
  const marker = src.indexOf("# ── Non-root fallback");
  const start = src.indexOf('if [ "$(id -u)" -ne 0 ]; then', marker);
  const end = src.indexOf("  apply_model_override", start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Expected non-root integrity gate in scripts/nemoclaw-start.sh");
  }
  return `${src.slice(start, end)}fi\n`;
}

function rootIntegrityGateBlock(src: string): string {
  const rootStart = src.indexOf("# ── Root path");
  const verifyStart = src.indexOf(
    "verify_config_integrity_if_locked /sandbox/.openclaw",
    rootStart,
  );
  if (rootStart === -1 || verifyStart === -1) {
    throw new Error("Expected root integrity check in scripts/nemoclaw-start.sh");
  }
  const lineEnd = src.indexOf("\n", verifyStart);
  return src.slice(verifyStart, lineEnd === -1 ? undefined : lineEnd);
}

describe("nemoclaw-start non-root fallback", () => {
  it("exits before startup work when locked config integrity fails in non-root mode", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const script = [
      "set -euo pipefail",
      'id() { if [ "${1:-}" = "-u" ]; then printf "1000"; else command id "$@"; fi; }',
      'verify_config_integrity_if_locked() { printf "verify:%s\\n" "$*"; return 1; }',
      'apply_model_override() { echo "SHOULD_NOT_RUN"; exit 70; }',
      nonRootIntegrityGateBlock(src),
      'echo "SHOULD_NOT_CONTINUE"',
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("verify:/sandbox/.openclaw");
    expect(result.stdout).not.toContain("SHOULD_NOT");
    expect(result.stderr).toContain("Config integrity check failed");
    expect(result.stderr).not.toMatch(/proceeding anyway/i);
  });

  it("verifies config integrity in both non-root and root startup paths", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const nonRootScript = [
      "set -euo pipefail",
      'id() { if [ "${1:-}" = "-u" ]; then printf "1000"; else command id "$@"; fi; }',
      'verify_config_integrity_if_locked() { printf "nonroot:%s\\n" "$*"; }',
      'normalize_mutable_config_perms() { :; }',
      nonRootIntegrityGateBlock(src),
      'echo "NONROOT_CONTINUED"',
    ].join("\n");
    const rootScript = [
      "set -euo pipefail",
      'verify_config_integrity_if_locked() { printf "root:%s\\n" "$*"; }',
      rootIntegrityGateBlock(src),
      'echo "ROOT_CONTINUED"',
    ].join("\n");

    const nonRoot = spawnSync("bash", ["-c", nonRootScript], {
      encoding: "utf-8",
      timeout: 5000,
    });
    const root = spawnSync("bash", ["-c", rootScript], { encoding: "utf-8", timeout: 5000 });

    expect(nonRoot.status).toBe(0);
    expect(nonRoot.stdout).toContain("nonroot:/sandbox/.openclaw");
    expect(nonRoot.stdout).toContain("NONROOT_CONTINUED");
    expect(root.status).toBe(0);
    expect(root.stdout).toContain("root:/sandbox/.openclaw");
    expect(root.stdout).toContain("ROOT_CONTINUED");
  });

  it("sends startup diagnostics to stderr so they do not leak into bridge output (#1064)", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const token = "a".repeat(64);
    const script = [
      "set -euo pipefail",
      `_read_gateway_token() { printf "${token}\\n"; }`,
      'PUBLIC_PORT="19000"',
      `CHAT_UI_URL="https://remote.example.test/ui/#token=${token}"`,
      startScriptLine(src, "echo 'Setting up NemoClaw...'"),
      extractShellFunctionFromSource(src, "print_dashboard_urls"),
      "print_dashboard_urls",
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Setting up NemoClaw");
    expect(result.stderr).toContain("[gateway] Local UI: http://127.0.0.1:19000/");
    expect(result.stderr).toContain("[gateway] Remote UI: https://remote.example.test/ui/");
    expect(result.stderr).toContain("Dashboard auth token redacted from startup logs.");
    expect(result.stderr).not.toContain("#token=");
    expect(result.stderr).not.toContain(token);
  });

  it("unwraps the sandbox-create env self-wrapper and applies dashboard port defaults", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const start = src.indexOf("# Normalize the sandbox-create bootstrap wrapper");
    const end = src.indexOf("# ── Config integrity check", start);
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Expected sandbox-create wrapper normalization and port block");
    }
    const snippet = src.slice(start, end);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-wrapper-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "run.sh");

    function runScenario(setArgs: string, extraEnv: Record<string, string> = {}) {
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        setArgs,
        snippet,
        'printf "CHAT_UI_URL=%s\\n" "$CHAT_UI_URL"',
        'printf "PUBLIC_PORT=%s\\n" "$PUBLIC_PORT"',
        'printf "SANDBOX_HOME=%s\\n" "$_SANDBOX_HOME"',
        'printf "CMD=%s\\n" "${NEMOCLAW_CMD[*]}"',
      ].join("\n");
      fs.writeFileSync(scriptPath, script, { mode: 0o700 });
      return spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH || ""}`, ...extraEnv },
      });
    }

    try {
      fs.mkdirSync(fakeBin);
      fs.writeFileSync(path.join(fakeBin, "openclaw"), "#!/usr/bin/env bash\nexit 0\n", {
        mode: 0o755,
      });

      const injected = runScenario(
        "set -- env CHAT_UI_URL=https://chat.example.test NEMOCLAW_DASHBOARD_PORT=19000 nemoclaw-start openclaw agent --agent main",
      );
      expect(injected.status).toBe(0);
      expect(injected.stdout).toContain("CHAT_UI_URL=http://127.0.0.1:19000");
      expect(injected.stdout).toContain("PUBLIC_PORT=19000");
      expect(injected.stdout).toContain("SANDBOX_HOME=/sandbox");
      expect(injected.stdout).toContain("CMD=openclaw agent --agent main");

      const baked = runScenario("set -- nemoclaw-start openclaw agent", {
        CHAT_UI_URL: "https://baked.example.test/ui",
      });
      expect(baked.status).toBe(0);
      expect(baked.stdout).toContain("CHAT_UI_URL=https://baked.example.test/ui");
      expect(baked.stdout).toContain("PUBLIC_PORT=18789");
      expect(baked.stdout).toContain("SANDBOX_HOME=/sandbox");
      expect(baked.stdout).toContain("CMD=openclaw agent");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("executes explicit non-root commands before gateway startup setup", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const script = [
      "set -euo pipefail",
      'id() { if [ "${1:-}" = "-u" ]; then printf "1000"; else command id "$@"; fi; }',
      'verify_config_integrity_if_locked() { :; }',
      'normalize_mutable_config_perms() { :; }',
      'apply_model_override() { :; }',
      'apply_cors_override() { :; }',
      'export_gateway_token() { :; }',
      'write_runtime_shell_env() { :; }',
      'ensure_runtime_shell_env_shim() { :; }',
      'lock_rc_files() { :; }',
      'configure_messaging_channels() { echo "SHOULD_NOT_CONFIGURE"; exit 70; }',
      'install_telegram_diagnostics() { echo "SHOULD_NOT_INSTALL"; exit 71; }',
      'install_slack_token_rewriter() { echo "SHOULD_NOT_INSTALL"; exit 72; }',
      'install_slack_channel_guard() { echo "SHOULD_NOT_INSTALL"; exit 73; }',
      'verify_no_slack_secrets_on_disk() { echo "SHOULD_NOT_VERIFY"; exit 74; }',
      '_SANDBOX_HOME=/sandbox',
      "NEMOCLAW_CMD=(bash -c 'echo EXPLICIT_COMMAND; exit 23')",
      nonRootFallbackBlock(src),
      'echo "SHOULD_NOT_REACH"',
    ].join("\n");

    const result = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 5000 });

    expect(result.status).toBe(23);
    expect(result.stdout).toContain("EXPLICIT_COMMAND");
    expect(result.stdout).not.toContain("SHOULD_NOT");
  });

  it("repairs writable OpenClaw state directories in non-root mode", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const match = src.match(/fix_openclaw_ownership\(\) \{([\s\S]*?)^\s*\}/m);
    if (!match) {
      throw new Error("Expected fix_openclaw_ownership in scripts/nemoclaw-start.sh");
    }
    const fn = `fix_openclaw_ownership() {${match[1]}\n}`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-ownership-"));
    const openclawDir = path.join(tmpDir, ".openclaw");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "{}\n", { mode: 0o644 });
    fs.writeFileSync(path.join(openclawDir, ".config-hash"), "hash\n", { mode: 0o644 });
    fs.writeFileSync(
      scriptPath,
      ["#!/usr/bin/env bash", "set -euo pipefail", fn, "fix_openclaw_ownership"].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 5000,
        env: { ...process.env, HOME: tmpDir },
      });
      expect(result.status).toBe(0);
      for (const dir of ["workspace", "memory", "credentials", "flows", "telegram", "media"]) {
        expect(fs.statSync(path.join(openclawDir, dir)).isDirectory()).toBe(true);
      }
      expect((fs.statSync(openclawDir).mode & 0o777).toString(8)).toBe("770");
      expect(fs.statSync(openclawDir).mode & 0o2000).toBe(0o2000);
      expect((fs.statSync(path.join(openclawDir, "openclaw.json")).mode & 0o777).toString(8)).toBe(
        "660",
      );
      expect((fs.statSync(path.join(openclawDir, ".config-hash")).mode & 0o777).toString(8)).toBe(
        "660",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("nemoclaw-start gateway preload process detection (#2478)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const safetyNetScript = startScriptHeredoc(src, "SAFETY_NET_EOF");
  const ciaoGuardScript = startScriptHeredoc(src, "CIAO_GUARD_EOF");

  it("activates the safety net for the re-execed openclaw-gateway child", () => {
    const run = runEmbeddedPreload(safetyNetScript, "/usr/local/bin/openclaw-gateway", "--port");
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("[sandbox-safety-net] loaded (openclaw-gateway)");
  });

  it("activates the ciao guard fallback for the re-execed openclaw-gateway child", () => {
    const run = runEmbeddedPreload(ciaoGuardScript, "/usr/local/bin/openclaw-gateway", "--port");
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("[guard] ciao-network-guard loaded (openclaw-gateway)");
  });

  it("still recognizes the openclaw gateway launcher path", () => {
    const safetyNet = runEmbeddedPreload(safetyNetScript, "/usr/local/bin/openclaw", "gateway");
    const ciaoGuard = runEmbeddedPreload(ciaoGuardScript, "/usr/local/bin/openclaw", "gateway");
    expect(safetyNet.status).toBe(0);
    expect(ciaoGuard.status).toBe(0);
    expect(safetyNet.stderr).toContain("[sandbox-safety-net] loaded (launcher)");
    expect(ciaoGuard.stderr).toContain("[guard] ciao-network-guard loaded (launcher)");
  });

  it("prefers the re-execed process title over launcher argv", () => {
    const safetyNet = runEmbeddedPreload(
      safetyNetScript,
      "/usr/local/bin/openclaw",
      "gateway",
      "openclaw-gateway",
    );
    const ciaoGuard = runEmbeddedPreload(
      ciaoGuardScript,
      "/usr/local/bin/openclaw",
      "gateway",
      "openclaw-gateway",
    );
    expect(safetyNet.status).toBe(0);
    expect(ciaoGuard.status).toBe(0);
    expect(safetyNet.stderr).toContain("[sandbox-safety-net] loaded (openclaw-gateway)");
    expect(ciaoGuard.stderr).toContain("[guard] ciao-network-guard loaded (openclaw-gateway)");
  });

  it("does not install the safety net for non-gateway CLI commands", () => {
    const run = runEmbeddedPreload(safetyNetScript, "/usr/local/bin/openclaw", "agent");
    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("[sandbox-safety-net] loaded");
  });
});

describe("nemoclaw-start gateway token export (#1114)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  function runGatewayTokenHarness(configJson: string, initialToken = "stale-token") {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-token-"));
    const openclawDir = path.join(tmpDir, ".openclaw");
    const proxyEnv = path.join(tmpDir, "proxy-env.sh");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), configJson);

    const readToken = extractShellFunctionFromSource(src, "_read_gateway_token").replaceAll(
      "/sandbox/.openclaw/openclaw.json",
      path.join(openclawDir, "openclaw.json"),
    );
    const exportToken = extractShellFunctionFromSource(src, "export_gateway_token");
    const printDashboard = extractShellFunctionFromSource(src, "print_dashboard_urls");
    const runtimeEnv = runtimeShellEnvBlock(src).replaceAll("/tmp/nemoclaw-proxy-env.sh", proxyEnv);

    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
        readToken,
        exportToken,
        printDashboard,
        runtimeEnv,
        `export OPENCLAW_GATEWAY_TOKEN=${JSON.stringify(initialToken)}`,
        'PUBLIC_PORT="18789"',
        'CHAT_UI_URL="https://remote.example.test/ui"',
        'PROXY_HOST="10.200.0.1"',
        'PROXY_PORT="3128"',
        '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
        '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
        '_SANDBOX_SAFETY_NET="/tmp/safety-net.js"',
        '_PROXY_FIX_SCRIPT="/tmp/http-proxy-fix.js"',
        '_WS_FIX_SCRIPT="/nonexistent/ws-proxy-fix.js"',
        '_NEMOTRON_FIX_SCRIPT="/tmp/nemotron-fix.js"',
        '_SECCOMP_GUARD_SCRIPT="/tmp/seccomp-guard.js"',
        '_CIAO_GUARD_SCRIPT="/tmp/ciao-guard.js"',
        '_SLACK_GUARD_SCRIPT="/nonexistent/slack-guard.js"',
        '_SLACK_REWRITER_SCRIPT="/nonexistent/slack-rewriter.js"',
        "_TOOL_REDIRECTS=()",
        "set +u",
        "export_gateway_token",
        'printf "TOKEN=%s\\n" "${OPENCLAW_GATEWAY_TOKEN-unset}"',
        "print_dashboard_urls",
        "write_runtime_shell_env",
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
    const envFile = fs.existsSync(proxyEnv) ? fs.readFileSync(proxyEnv, "utf-8") : "";
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { result, envFile };
  }

  it("reads, exports, prints, and shell-escapes the gateway token without touching rc files", () => {
    const { result, envFile } = runGatewayTokenHarness(
      JSON.stringify({ gateway: { auth: { token: "tok'en" } } }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("TOKEN=tok'en");
    expect(result.stderr).toContain("http://127.0.0.1:18789/");
    expect(result.stderr).toContain("https://remote.example.test/ui/");
    expect(result.stderr).toContain("Dashboard auth token redacted from startup logs.");
    expect(result.stderr).not.toContain("#token=");
    expect(result.stderr).not.toContain("tok'en");
    expect(envFile).toContain("export OPENCLAW_GATEWAY_TOKEN='tok'\\''en'");
    expect(envFile).toContain("nemoclaw-configure-guard begin");
    expect(envFile).not.toContain(".bashrc");
    expect(envFile).not.toContain(".profile");
  });

  it("unsets stale OPENCLAW_GATEWAY_TOKEN when no token is configured", () => {
    const { result, envFile } = runGatewayTokenHarness(JSON.stringify({ gateway: { auth: {} } }));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("TOKEN=unset");
    expect(result.stderr).not.toContain("#token=");
    expect(envFile).not.toContain("OPENCLAW_GATEWAY_TOKEN");
  });
});

describe("nemoclaw-start configure guard behavior", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  function writeProxyEnvWithGuard() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-configure-guard-"));
    const fakeBin = path.join(tmpDir, "bin");
    const proxyEnv = path.join(tmpDir, "proxy-env.sh");
    const commandLog = path.join(tmpDir, "openclaw.log");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "openclaw"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(commandLog)}\nexit 0\n`,
      { mode: 0o755 },
    );
    const runtimeBlock = `${runtimeShellEnvBlock(src)}\nwrite_runtime_shell_env`.replaceAll(
      "/tmp/nemoclaw-proxy-env.sh",
      proxyEnv,
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
      '_WS_FIX_SCRIPT="/nonexistent/ws-proxy-fix.js"',
      '_NEMOTRON_FIX_SCRIPT="/tmp/nemotron-fix.js"',
      '_SECCOMP_GUARD_SCRIPT="/tmp/seccomp-guard.js"',
      '_CIAO_GUARD_SCRIPT="/tmp/ciao-guard.js"',
      '_SLACK_GUARD_SCRIPT="/nonexistent/slack-guard.js"',
      '_SLACK_REWRITER_SCRIPT="/nonexistent/slack-rewriter.js"',
      "_TOOL_REDIRECTS=()",
      "set +u",
      runtimeBlock,
    ].join("\n");
    const scriptPath = path.join(tmpDir, "write-env.sh");
    fs.writeFileSync(scriptPath, wrapper, { mode: 0o700 });
    const write = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
    expect(write.status).toBe(0);
    return { tmpDir, fakeBin, proxyEnv, commandLog };
  }

  function runGuardedOpenclaw(setup: ReturnType<typeof writeProxyEnvWithGuard>, args: string[]) {
    return spawnSync(
      "bash",
      [
        "--norc",
        "-lc",
        [
          `source ${JSON.stringify(setup.proxyEnv)}`,
          ["openclaw", ...args.map((arg) => JSON.stringify(arg))].join(" "),
        ].join("; "),
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, PATH: `${setup.fakeBin}:${process.env.PATH || ""}` },
        timeout: 5000,
      },
    );
  }

  it("emits a proxy-env guard that blocks mutating OpenClaw commands and passes read-only commands through", () => {
    const setup = writeProxyEnvWithGuard();
    try {
      const envFile = fs.readFileSync(setup.proxyEnv, "utf-8");
      expect(envFile).toContain("nemoclaw-configure-guard begin");
      expect(envFile).toContain("nemoclaw-configure-guard end");

      const configure = runGuardedOpenclaw(setup, ["configure"]);
      expect(configure.status).toBe(1);
      expect(configure.stderr).toContain("cannot modify config inside the sandbox");
      expect(configure.stderr).toContain("nemoclaw onboard --resume");

      const configSet = runGuardedOpenclaw(setup, ["config", "set", "foo", "bar"]);
      expect(configSet.status).toBe(1);
      expect(configSet.stderr).toContain("openclaw config set");
      expect(configSet.stderr).toContain("nemoclaw onboard --resume");

      const channelsAdd = runGuardedOpenclaw(setup, ["channels", "add", "slack"]);
      expect(channelsAdd.status).toBe(1);
      expect(channelsAdd.stderr).toContain("openclaw channels add");
      expect(channelsAdd.stderr).toContain("nemoclaw <sandbox> channels add");

      const localAgent = runGuardedOpenclaw(setup, ["agent", "--local"]);
      expect(localAgent.status).toBe(1);
      expect(localAgent.stderr).toContain("--local");
      expect(localAgent.stderr).toContain("openclaw agent --agent main");

      expect(runGuardedOpenclaw(setup, ["agent", "--agent", "main", "-m", "hello"]).status).toBe(0);
      expect(runGuardedOpenclaw(setup, ["config", "get", "foo"]).status).toBe(0);
      expect(runGuardedOpenclaw(setup, ["channels", "list"]).status).toBe(0);
      expect(fs.readFileSync(setup.commandLog, "utf-8")).toContain("agent --agent main -m hello");
      expect(fs.readFileSync(setup.commandLog, "utf-8")).toContain("config get foo");
      expect(fs.readFileSync(setup.commandLog, "utf-8")).toContain("channels list");
    } finally {
      fs.rmSync(setup.tmpDir, { recursive: true, force: true });
    }
  });

  // #2592 reported the guard did not fire for `openclaw channels add telegram`
  // and `openclaw channels remove telegram` from inside the sandbox. The
  // existing test above only exercises `add slack`. Lock in coverage for every
  // (channel × op) combo so the guard cannot regress for any one of them
  // while passing for another.
  it("#2592: blocks every (channel × op) mutating combo and surfaces the host-side hint", () => {
    const setup = writeProxyEnvWithGuard();
    try {
      const channels = ["slack", "telegram", "discord"];
      const ops = ["add", "remove"];
      for (const op of ops) {
        for (const channel of channels) {
          const result = runGuardedOpenclaw(setup, ["channels", op, channel]);
          expect(result.status, `channels ${op} ${channel} should be blocked`).toBe(1);
          expect(result.stderr).toContain(`openclaw channels ${op}`);
          expect(result.stderr).toContain(`nemoclaw <sandbox> channels ${op}`);
        }
      }
    } finally {
      fs.rmSync(setup.tmpDir, { recursive: true, force: true });
    }
  });
});

describe("nemoclaw-start persistent gateway log hardening", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  function persistentLogFunction(root: string, gatewayLog: string): string {
    return extractShellFunctionFromSource(src, "start_persistent_gateway_log_mirror")
      .replaceAll("/sandbox/.openclaw/logs", path.join(root, "logs"))
      .replaceAll("/tmp/gateway.log", gatewayLog);
  }

  it("creates a regular read-only persistent log mirror and refuses unsafe paths", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-persistent-log-"));
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const persistentLog = path.join(tmpDir, "logs", "gateway-persistent.log");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.writeFileSync(gatewayLog, "initial gateway line\n");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        persistentLogFunction(tmpDir, gatewayLog),
        "start_persistent_gateway_log_mirror",
        "sleep 0.2",
        `printf '%s\\n' later-line >> ${JSON.stringify(gatewayLog)}`,
        `for _ in {1..30}; do grep -Fq later-line ${JSON.stringify(persistentLog)} 2>/dev/null && break; sleep 0.1; done`,
        'kill "$GATEWAY_LOG_PERSIST_PID" 2>/dev/null || true',
        'wait "$GATEWAY_LOG_PERSIST_PID" 2>/dev/null || true',
        "printf 'PID=%s\\n' \"$GATEWAY_LOG_PERSIST_PID\"",
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("PID=");
      const stat = fs.statSync(persistentLog);
      expect(stat.isFile()).toBe(true);
      expect((stat.mode & 0o777).toString(8)).toBe("644");
      const log = fs.readFileSync(persistentLog, "utf-8");
      expect(log).toContain("initial gateway line");
      expect(log).toContain("later-line");

      fs.rmSync(path.join(tmpDir, "logs"), { recursive: true, force: true });
      fs.symlinkSync(tmpDir, path.join(tmpDir, "logs"));
      const unsafe = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(unsafe.status).not.toBe(0);
      expect(unsafe.stderr).toContain("refusing symlinked persistent log directory");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("runtime model override (#759)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  function extractShellFunction(name: string): string {
    const match = src.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
    if (!match) {
      throw new Error(`Expected ${name} in scripts/nemoclaw-start.sh`);
    }
    return `${name}() {${match[1]}\n}`;
  }

  function runApplyModelOverride(env: Record<string, string> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-model-override-"));
    const openclawDir = path.join(root, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({
        agents: { defaults: { model: { primary: "old-model" } } },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: [
                {
                  id: "old-model",
                  name: "old-model",
                  contextWindow: 1024,
                  maxTokens: 128,
                  reasoning: false,
                },
              ],
            },
          },
        },
      }),
    );
    const configPath = path.join(openclawDir, "openclaw.json");
    const hashPath = path.join(openclawDir, ".config-hash");
    fs.writeFileSync(hashPath, "oldhash\n");
    fs.chmodSync(openclawDir, 0o2770);
    fs.chmodSync(configPath, 0o660);
    fs.chmodSync(hashPath, 0o660);

    const helperFns = [
      extractShellFunction("openclaw_config_dir_owner"),
      extractShellFunction("prepare_openclaw_config_for_write"),
      extractShellFunction("restore_openclaw_config_after_write"),
    ]
      .join("\n")
      .replaceAll("/sandbox", root);
    const fn = extractShellFunction("apply_model_override").replaceAll("/sandbox", root);
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "id() { echo 0; }",
      "chown() { return 0; }",
      `stat() { if [ "$1" = "-c" ] && [ "$2" = "%U" ] && [ "$3" = ${JSON.stringify(openclawDir)} ]; then echo sandbox; return 0; fi; command stat "$@"; }`,
      'relax_config_for_write() { chmod 644 "$@"; }',
      'lock_config_after_write() { chmod 444 "$@"; }',
      helperFns,
      fn,
      "apply_model_override",
    ].join("\n");
    const script = path.join(root, "run.sh");
    fs.writeFileSync(script, wrapper, { mode: 0o700 });
    const result = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
    });
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const hash = fs.readFileSync(hashPath, "utf-8");
    const modes = {
      dir: fs.statSync(openclawDir).mode & 0o7777,
      config: fs.statSync(configPath).mode & 0o777,
      hash: fs.statSync(hashPath).mode & 0o777,
    };
    fs.rmSync(root, { recursive: true, force: true });
    return { result, config, hash, modes };
  }

  it("applies model, API, context, max-token, and reasoning overrides and recomputes the hash", () => {
    const { result, config, hash } = runApplyModelOverride({
      NEMOCLAW_MODEL_OVERRIDE: "new-model",
      NEMOCLAW_INFERENCE_API_OVERRIDE: "anthropic-messages",
      NEMOCLAW_CONTEXT_WINDOW: "4096",
      NEMOCLAW_MAX_TOKENS: "512",
      NEMOCLAW_REASONING: "true",
    });

    expect(result.status).toBe(0);
    expect(config.agents.defaults.model.primary).toBe("new-model");
    const provider = config.models.providers.inference;
    expect(provider.api).toBe("anthropic-messages");
    expect(provider.models[0]).toMatchObject({
      id: "new-model",
      name: "new-model",
      contextWindow: 4096,
      maxTokens: 512,
      reasoning: true,
    });
    expect(hash).toContain("openclaw.json");
  });

  it("restores mutable config permissions after successful overrides", () => {
    const { result, modes } = runApplyModelOverride({
      NEMOCLAW_MODEL_OVERRIDE: "new-model",
    });

    expect(result.status).toBe(0);
    expect(modes.dir).toBe(0o2770);
    expect(modes.config).toBe(0o660);
    expect(modes.hash).toBe(0o660);
  });

  it("treats invalid supplemental overrides as atomic no-ops", () => {
    const cases = [
      {
        env: { NEMOCLAW_CONTEXT_WINDOW: "not-a-number" },
        message: "NEMOCLAW_CONTEXT_WINDOW must be a positive integer",
      },
      {
        env: { NEMOCLAW_CONTEXT_WINDOW: "0" },
        message: "NEMOCLAW_CONTEXT_WINDOW must be a positive integer",
      },
      {
        env: { NEMOCLAW_MAX_TOKENS: "not-a-number" },
        message: "NEMOCLAW_MAX_TOKENS must be a positive integer",
      },
      {
        env: { NEMOCLAW_MAX_TOKENS: "0" },
        message: "NEMOCLAW_MAX_TOKENS must be a positive integer",
      },
      {
        env: { NEMOCLAW_REASONING: "maybe" },
        message: 'NEMOCLAW_REASONING must be "true" or "false"',
      },
      {
        env: { NEMOCLAW_INFERENCE_API_OVERRIDE: "unexpected-api" },
        message: 'must be "openai-completions" or "anthropic-messages"',
      },
    ];

    for (const { env, message } of cases) {
      const { result, config, hash } = runApplyModelOverride({
        NEMOCLAW_MODEL_OVERRIDE: "new-model",
        ...env,
      });

      expect(result.status).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(message);
      expect(config.agents.defaults.model.primary).toBe("old-model");
      expect(config.models.providers.inference.api).toBe("openai-completions");
      expect(config.models.providers.inference.models[0]).toMatchObject({
        id: "old-model",
        name: "old-model",
        contextWindow: 1024,
        maxTokens: 128,
        reasoning: false,
      });
      expect(hash).toBe("oldhash\n");
    }
  });
});

describe("runtime CORS origin override (#719)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  function extractShellFunction(name: string): string {
    const match = src.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
    if (!match) {
      throw new Error(`Expected ${name} in scripts/nemoclaw-start.sh`);
    }
    return `${name}() {${match[1]}\n}`;
  }

  function runApplyCorsOverride(origin: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cors-override-"));
    const openclawDir = path.join(root, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    fs.writeFileSync(
      path.join(openclawDir, "openclaw.json"),
      JSON.stringify({ gateway: { controlUi: { allowedOrigins: ["http://127.0.0.1:18789"] } } }),
    );
    const configPath = path.join(openclawDir, "openclaw.json");
    const hashPath = path.join(openclawDir, ".config-hash");
    fs.writeFileSync(hashPath, "oldhash\n");
    fs.chmodSync(openclawDir, 0o2770);
    fs.chmodSync(configPath, 0o660);
    fs.chmodSync(hashPath, 0o660);

    const helperFns = [
      extractShellFunction("openclaw_config_dir_owner"),
      extractShellFunction("prepare_openclaw_config_for_write"),
      extractShellFunction("restore_openclaw_config_after_write"),
    ]
      .join("\n")
      .replaceAll("/sandbox", root);
    const fn = extractShellFunction("apply_cors_override").replaceAll("/sandbox", root);
    const script = path.join(root, "run.sh");
    fs.writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "id() { echo 0; }",
        "chown() { return 0; }",
        `stat() { if [ "$1" = "-c" ] && [ "$2" = "%U" ] && [ "$3" = ${JSON.stringify(openclawDir)} ]; then echo sandbox; return 0; fi; command stat "$@"; }`,
        'relax_config_for_write() { chmod 644 "$@"; }',
        'lock_config_after_write() { chmod 444 "$@"; }',
        helperFns,
        fn,
        "apply_cors_override",
      ].join("\n"),
      { mode: 0o700 },
    );
    const result = spawnSync("bash", [script], {
      encoding: "utf-8",
      env: { ...process.env, NEMOCLAW_CORS_ORIGIN: origin },
    });
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const hash = fs.readFileSync(hashPath, "utf-8");
    fs.rmSync(root, { recursive: true, force: true });
    return { result, config, hash };
  }

  it("adds valid CORS origins and recomputes the config hash", () => {
    const { result, config, hash } = runApplyCorsOverride("https://chat.example.test");
    expect(result.status).toBe(0);
    expect(config.gateway.controlUi.allowedOrigins).toContain("https://chat.example.test");
    expect(hash).toContain("openclaw.json");
  });

  it("rejects invalid CORS origins without mutating config", () => {
    const { result, config } = runApplyCorsOverride("javascript:alert(1)");
    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("must start with http:// or https://");
    expect(config.gateway.controlUi.allowedOrigins).toEqual(["http://127.0.0.1:18789"]);
  });
});

describe("Slack channel guard — unhandled-rejection safety net (#2340)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const extractGuardScript = () => startScriptHeredoc(src, "SLACK_GUARD_EOF");

  function slackGuardSection(guardPath: string, configPath: string): string {
    const start = src.indexOf("# read-only at runtime), this injects a Node.js preload");
    const end = src.indexOf("_read_gateway_token()", start);
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Expected Slack channel guard section in scripts/nemoclaw-start.sh");
    }
    return src
      .slice(start, end)
      .replace(
        '_SLACK_GUARD_SCRIPT="/tmp/nemoclaw-slack-channel-guard.js"',
        `_SLACK_GUARD_SCRIPT=${JSON.stringify(guardPath)}`,
      )
      .replace(
        '_SLACK_GUARD_SOURCE="/usr/local/lib/nemoclaw/preloads/slack-channel-guard.js"',
        `_SLACK_GUARD_SOURCE=${JSON.stringify(path.join(PRELOAD_SCRIPTS, "slack-channel-guard.js"))}`,
      )
      .replace(
        'local config_file="/sandbox/.openclaw/openclaw.json"',
        `local config_file=${JSON.stringify(configPath)}`,
      );
  }

  function runSlackGuardHarness(body: string): ReturnType<typeof spawnSync> {
    return spawnSync(
      process.execPath,
      [
        "-e",
        `process.env.OPENSHELL_SANDBOX = '1';
${extractGuardScript()}
${body}`,
      ],
      { encoding: "utf-8" },
    );
  }

  it("installs the guard only when Slack is configured", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-guard-"));
    const configPath = path.join(tmpDir, "openclaw.json");
    const guardPath = path.join(tmpDir, "slack-channel-guard.js");
    const scriptPath = path.join(tmpDir, "run.sh");
    const run = (config: string) => {
      fs.writeFileSync(configPath, config);
      fs.rmSync(guardPath, { force: true });
      fs.writeFileSync(
        scriptPath,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
          "NODE_OPTIONS='--require /already-loaded.js'",
          slackGuardSection(guardPath, configPath),
          "install_slack_channel_guard",
          'printf "NODE_OPTIONS=%s\\n" "$NODE_OPTIONS"',
        ].join("\n"),
        { mode: 0o700 },
      );
      return spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
    };

    try {
      const noSlack = run('{"channels":{}}\n');
      expect(noSlack.status).toBe(0);
      expect(fs.existsSync(guardPath)).toBe(false);
      expect(noSlack.stdout).not.toContain(guardPath);

      const withSlack = run('{"channels":{"slack":{"accounts":{"default":{}}}}}\n');
      expect(withSlack.status).toBe(0);
      expect(fs.existsSync(guardPath)).toBe(true);
      expect((fs.statSync(guardPath).mode & 0o777).toString(8)).toBe("444");
      expect(withSlack.stdout).toContain("--require /already-loaded.js");
      expect(withSlack.stdout).toContain(`--require ${guardPath}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("catches uncaught exceptions from Slack (sync throws)", () => {
    const result = runSlackGuardHarness(`
process.emit('uncaughtException', new Error('An API error occurred: invalid_auth'));
setImmediate(function () { console.log('still-running'); });
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("still-running");
    expect(result.stderr).toContain("provider failed to start");
  });

  it("passes non-Slack failures through to later process handlers", () => {
    const result = runSlackGuardHarness(`
process.on('unhandledRejection', function () {
  console.log('downstream');
  process.exit(42);
});
process.emit('unhandledRejection', new Error('plain failure'), {});
`);
    expect(result.status).toBe(42);
    expect(result.stdout).toContain("downstream");
  });

  it("consumes Slack auth rejections before later fatal handlers see them", () => {
    const result = runSlackGuardHarness(`
let downstreamCalled = false;
process.on('unhandledRejection', function () {
  downstreamCalled = true;
  process.exit(42);
});
process.emit('unhandledRejection', new Error('An API error occurred: invalid_auth'), {});
setImmediate(function () {
  console.log('downstream=' + downstreamCalled);
});
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("downstream=false");
    expect(result.stderr).toContain("provider failed to start");
  });

  it("detects Slack errors by error code, message, stack trace, and domain", () => {
    const result = runSlackGuardHarness(`
const cases = [
  Object.assign(new Error('code path'), { code: 'slack_webapi_platform_error' }),
  new Error('token_revoked'),
  Object.assign(new Error('stack path'), { stack: 'at @slack/web-api' }),
  new Error('CONNECT failed for slack.com'),
];
for (const err of cases) process.emit('unhandledRejection', err, {});
setImmediate(function () { console.log('cases=' + cases.length); });
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("cases=4");
    expect((result.stderr.match(/provider failed to start/g) || []).length).toBe(4);
    expect(result.stderr).toContain("caught by safety net, gateway continues");
  });
});

describe("nemoclaw-start auto-pair client whitelisting (#117)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("approves only whitelisted clients and does not reprocess handled requests", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auto-pair-"));
    const fakeOpenclaw = path.join(tmpDir, "openclaw");
    const stateFile = path.join(tmpDir, "list-count");
    const approveLog = path.join(tmpDir, "approvals.log");
    const pendingJson = JSON.stringify({
      pending: [
        "not-a-device",
        { requestId: "ok-browser", clientId: "openclaw-control-ui", clientMode: "unknown" },
        { requestId: "ok-browser", clientId: "openclaw-control-ui", clientMode: "unknown" },
        { requestId: "ok-webchat", clientId: "other-client", clientMode: "webchat" },
        { requestId: "reject-me", clientId: "evil-client", clientMode: "unknown" },
      ],
      paired: [],
    });
    const pairedJson = JSON.stringify({
      pending: [],
      paired: [{ clientId: "openclaw-control-ui", clientMode: "webchat" }],
    });
    fs.writeFileSync(
      fakeOpenclaw,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "list" ]; then
  count="$(cat ${JSON.stringify(stateFile)} 2>/dev/null || echo 0)"
  count=$((count + 1))
  echo "$count" > ${JSON.stringify(stateFile)}
  if [ "$count" -eq 1 ]; then
    printf '%s\n' ${JSON.stringify(pendingJson)}
  else
    printf '%s\n' ${JSON.stringify(pairedJson)}
  fi
  exit 0
fi
if [ "\${1:-}" = "devices" ] && [ "\${2:-}" = "approve" ]; then
  echo "$3" >> ${JSON.stringify(approveLog)}
  printf '{}\n'
  exit 0
fi
echo "unexpected: $*" >&2
exit 2
`,
      { mode: 0o755 },
    );

    const autoPairScript = startScriptHeredoc(src, "PYAUTOPAIR").replace(
      "import time",
      "import time\ntime.sleep = lambda _seconds: None",
    );

    try {
      const run = spawnSync("python3", ["-c", autoPairScript], {
        encoding: "utf-8",
        env: { ...process.env, OPENCLAW_BIN: fakeOpenclaw },
        timeout: 30_000,
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(
        "[auto-pair] approved request=ok-browser client=openclaw-control-ui",
      );
      expect(run.stdout).toContain("[auto-pair] approved request=ok-webchat client=other-client");
      expect(run.stdout).toContain("[auto-pair] rejected unknown client=evil-client mode=unknown");
      expect(run.stdout).toContain("browser pairing converged approvals=2");
      expect(fs.readFileSync(approveLog, "utf-8").trim().split("\n")).toEqual([
        "ok-browser",
        "ok-webchat",
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 40_000);
});

describe("nemoclaw-start gateway launch signal handling", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  function launchBlock(kind: "non-root" | "root", gatewayLog: string): string {
    const startMarker =
      kind === "non-root"
        ? "# Start gateway in background, auto-pair, then wait"
        : "# Start the gateway as the 'gateway' user.";
    const start = src.indexOf(startMarker);
    const trap = src.indexOf("trap cleanup_on_signal SIGTERM SIGINT", start);
    if (start === -1 || trap === -1) {
      throw new Error(`Expected ${kind} gateway launch block in scripts/nemoclaw-start.sh`);
    }
    const lineEnd = src.indexOf("\n", trap);
    return src.slice(start, lineEnd).replaceAll("/tmp/gateway.log", gatewayLog);
  }

  function runLaunchBlock(kind: "non-root" | "root") {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-launch-${kind}-`));
    const fakeBin = path.join(tmpDir, "bin");
    const openclawLog = path.join(tmpDir, "openclaw.log");
    const gosuLog = path.join(tmpDir, "gosu.log");
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const scriptPath = path.join(tmpDir, "run.sh");
    const waitForLaunchLogIterations = Array.from({ length: 100 }, (_, i) => String(i + 1)).join(
      " ",
    );
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(
      path.join(fakeBin, "openclaw"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(openclawLog)}\nprintf 'gateway stdout marker\\n'\nprintf 'gateway stderr marker\\n' >&2\nexec sleep 30\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(fakeBin, "gosu"),
      `#!/usr/bin/env bash\nprintf 'user=%s args=%s\\n' "$1" "${"$*"}" >> ${JSON.stringify(gosuLog)}\nshift\nexec "$@"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(gatewayLog, "gateway booting\n");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `export PATH=${JSON.stringify(`${fakeBin}:${process.env.PATH || ""}`)}`,
        `OPENCLAW=${JSON.stringify(path.join(fakeBin, "openclaw"))}`,
        '_DASHBOARD_PORT="19000"',
        "start_persistent_gateway_log_mirror() { sleep 30 & GATEWAY_LOG_PERSIST_PID=$!; }",
        "start_auto_pair() { sleep 30 & AUTO_PAIR_PID=$!; }",
        "cleanup_on_signal() { :; }",
        launchBlock(kind, gatewayLog),
        kind === "root"
          ? `for _ in ${waitForLaunchLogIterations}; do [ -s ${JSON.stringify(gosuLog)} ] && [ -s ${JSON.stringify(openclawLog)} ] && break; sleep 0.1; done`
          : `for _ in ${waitForLaunchLogIterations}; do [ -s ${JSON.stringify(openclawLog)} ] && break; sleep 0.1; done`,
        'printf "GATEWAY_PID=%s\\n" "$GATEWAY_PID"',
        'printf "AUTO_PAIR_PID=%s\\n" "${AUTO_PAIR_PID:-}"',
        'printf "TAIL_PID=%s\\n" "${GATEWAY_LOG_TAIL_PID:-}"',
        'printf "PERSIST_PID=%s\\n" "${GATEWAY_LOG_PERSIST_PID:-}"',
        'printf "WAIT_PID=%s\\n" "$SANDBOX_WAIT_PID"',
        'printf "CHILD_PIDS=%s\\n" "${SANDBOX_CHILD_PIDS[*]}"',
        "trap -p SIGTERM",
        'for pid in "${SANDBOX_CHILD_PIDS[@]}"; do pkill -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true; done',
        'for pid in "${SANDBOX_CHILD_PIDS[@]}"; do wait "$pid" 2>/dev/null || true; done',
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 15_000 });
    const openclaw = fs.existsSync(openclawLog) ? fs.readFileSync(openclawLog, "utf-8") : "";
    const gosu = fs.existsSync(gosuLog) ? fs.readFileSync(gosuLog, "utf-8") : "";
    const gateway = fs.existsSync(gatewayLog) ? fs.readFileSync(gatewayLog, "utf-8") : "";
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { result, openclaw, gosu, gateway };
  }

  it("registers child PIDs, redirects gateway output, and traps signals in non-root mode", () => {
    const { result, openclaw, gateway } = runLaunchBlock("non-root");
    expect(result.status).toBe(0);
    expect(openclaw).toContain("gateway run --port 19000");
    expect(gateway).toContain("gateway stdout marker");
    expect(gateway).toContain("gateway stderr marker");
    expect(result.stdout).not.toContain("gateway stdout marker");
    const stdout = result.stdout;
    const gatewayPid = stdout.match(/GATEWAY_PID=(\d+)/)?.[1];
    expect(gatewayPid).toBeTruthy();
    expect(stdout).toContain(`WAIT_PID=${gatewayPid}`);
    expect(stdout).toContain(`CHILD_PIDS=${gatewayPid}`);
    expect(stdout).toMatch(/AUTO_PAIR_PID=\d+/);
    expect(stdout).toMatch(/TAIL_PID=\d+/);
    expect(stdout).toMatch(/PERSIST_PID=\d+/);
    expect(stdout).toContain("cleanup_on_signal");
  });

  it("launches the root gateway through gosu with the configured port and tracks child PIDs", () => {
    const { result, gosu } = runLaunchBlock("root");
    expect(result.status).toBe(0);
    expect(gosu).toContain("user=gateway");
    expect(gosu).toContain("gateway run --port 19000");
    const gatewayPid = result.stdout.match(/GATEWAY_PID=(\d+)/)?.[1];
    expect(gatewayPid).toBeTruthy();
    expect(result.stdout).toContain(`WAIT_PID=${gatewayPid}`);
    expect(result.stdout).toContain(`CHILD_PIDS=${gatewayPid}`);
    expect(result.stdout).toMatch(/AUTO_PAIR_PID=\d+/);
    expect(result.stdout).toMatch(/TAIL_PID=\d+/);
    expect(result.stdout).toMatch(/PERSIST_PID=\d+/);
    expect(result.stdout).toContain("cleanup_on_signal");
  });
});

// -------------------------------------------------------------------
// NC-2227-01: Legacy migration behavior
// -------------------------------------------------------------------
describe("NC-2227-01: legacy migration behavior", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  function migrationFunctions(): string {
    return [
      "path_has_immutable_bit",
      "ensure_mutable_for_migration",
      "restore_immutable_if_possible",
      "chown_tree_no_symlink_follow",
      "legacy_symlinks_exist",
      "assert_no_legacy_layout",
      "migrate_legacy_layout",
    ]
      .map((name) => extractShellFunctionFromSource(src, name))
      .join("\n");
  }

  function runMigration(
    configDir: string,
    dataDir: string,
    opts: { fakeRoot?: boolean; fakeSandboxOwner?: boolean; fakeRootConfigOwner?: boolean } = {},
  ) {
    const script = path.join(path.dirname(configDir), `migration-${Date.now()}.sh`);
    const prelude = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      opts.fakeRoot
        ? 'id() { if [ "${1:-}" = "-u" ]; then echo 0; else command id "$@"; fi; }'
        : "",
      opts.fakeSandboxOwner || opts.fakeRootConfigOwner
        ? `stat() {
  if [ "\${1:-}" = "-c" ] && [ "\${2:-}" = "%U" ] && [ "\${3:-}" = ${JSON.stringify(dataDir)} ]; then
    echo ${opts.fakeSandboxOwner ? "sandbox" : '$(command stat -c %U "$3")'}
    return 0
  fi
  if [ "\${1:-}" = "-c" ] && [ "\${2:-}" = "%U" ] && [ "\${3:-}" = ${JSON.stringify(configDir)} ]; then
    echo ${opts.fakeRootConfigOwner ? "root" : '$(command stat -c %U "$3")'}
    return 0
  fi
  command stat "$@"
}`
        : "",
      migrationFunctions(),
      `migrate_legacy_layout ${JSON.stringify(configDir)} ${JSON.stringify(dataDir)} openclaw`,
    ].filter(Boolean);
    fs.writeFileSync(script, prelude.join("\n"), { mode: 0o700 });
    try {
      return spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
    } finally {
      fs.rmSync(script, { force: true });
    }
  }

  it("migrates legacy and hidden data, removes the legacy dir, and writes a read-only sentinel", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-migrate-"));
    const configDir = path.join(tmpDir, ".openclaw");
    const dataDir = path.join(tmpDir, ".openclaw-data");
    fs.mkdirSync(path.join(configDir, "workspace"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "workspace", "note.txt"), "from legacy");
    fs.mkdirSync(path.join(dataDir, ".hidden"));
    fs.writeFileSync(path.join(dataDir, ".hidden", "secret.txt"), "secret");
    fs.rmSync(path.join(configDir, "workspace"), { recursive: true, force: true });
    fs.symlinkSync(path.join(dataDir, "workspace"), path.join(configDir, "workspace"));

    try {
      const result = runMigration(configDir, dataDir, { fakeRoot: true });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Completed openclaw layout migration");
      expect(fs.existsSync(dataDir)).toBe(false);
      expect(fs.lstatSync(path.join(configDir, "workspace")).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(path.join(configDir, "workspace", "note.txt"), "utf-8")).toBe(
        "from legacy",
      );
      expect(fs.readFileSync(path.join(configDir, ".hidden", "secret.txt"), "utf-8")).toBe(
        "secret",
      );
      const sentinel = path.join(configDir, ".migration-complete");
      expect(fs.existsSync(sentinel)).toBe(true);
      expect((fs.statSync(sentinel).mode & 0o777).toString(8)).toBe("444");
    } finally {
      spawnSync(
        "bash",
        ["-lc", 'chmod -R u+rwx "$1" 2>/dev/null || true; rm -rf "$1"', "bash", tmpDir],
        {
          encoding: "utf-8",
          timeout: 5000,
        },
      );
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup on WSL/overlayfs can fail on chmod-preserved fixtures */
      }
    }
  });

  it("refuses symlink and sandbox-owned untrusted migration inputs", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-migrate-guards-"));
    try {
      const configDir = path.join(tmpDir, "config");
      const dataDir = path.join(tmpDir, "data");
      fs.mkdirSync(configDir);
      fs.mkdirSync(dataDir);

      fs.symlinkSync(configDir, path.join(tmpDir, "config-link"));
      expect(
        runMigration(path.join(tmpDir, "config-link"), dataDir, { fakeRoot: true }).status,
      ).toBe(1);

      fs.writeFileSync(path.join(dataDir, "evil"), "payload");
      fs.symlinkSync(path.join(tmpDir, "outside"), path.join(dataDir, "linked-entry"));
      const linkedEntry = runMigration(configDir, dataDir, { fakeRoot: true });
      expect(linkedEntry.status).toBe(1);
      expect(linkedEntry.stderr).toContain("refusing migration");

      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.mkdirSync(dataDir);
      const sandboxOwned = runMigration(configDir, dataDir, {
        fakeRoot: true,
        fakeSandboxOwner: true,
      });
      expect(sandboxOwned.status).toBe(1);
      expect(sandboxOwned.stderr).toContain("possible agent-planted trigger");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("provisions only canonical workspace paths from OpenClaw config", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-workspaces-"));
    const configDir = path.join(tmpDir, ".openclaw");
    const script = path.join(tmpDir, "provision.sh");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(configDir, "workspace-existing"));
    fs.symlinkSync(tmpDir, path.join(configDir, "workspace-linked"));
    fs.writeFileSync(
      path.join(configDir, "openclaw.json"),
      JSON.stringify({
        agents: {
          defaults: { workspace: "main" },
          list: [
            { workspace: path.join(configDir, "workspace-alpha") },
            { workspace: "workspace-beta" },
            { workspace: "../escape" },
          ],
        },
      }),
    );
    const body = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      extractShellFunctionFromSource(src, "chown_tree_no_symlink_follow"),
      extractShellFunctionFromSource(src, "provision_agent_workspaces").replaceAll(
        "/sandbox/.openclaw",
        configDir,
      ),
      "provision_agent_workspaces",
    ].join("\n");
    fs.writeFileSync(script, body, { mode: 0o700 });

    try {
      const result = spawnSync("bash", [script], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      for (const name of [
        "workspace-existing",
        "workspace-main",
        "workspace-alpha",
        "workspace-beta",
      ]) {
        expect(fs.statSync(path.join(configDir, name)).isDirectory()).toBe(true);
      }
      expect(fs.existsSync(path.join(configDir, "workspace-.."))).toBe(false);
      expect(result.stderr).toContain("refusing symlinked workspace dir");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("seed_default_workspace_templates (#3240)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  function runSeed(
    workspaceDir: string,
    templatesDir: string,
    scriptPath: string,
    options: { skipBootstrap?: boolean } = {},
  ) {
    const configPath = path.join(path.dirname(scriptPath), "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ agents: { defaults: { skipBootstrap: options.skipBootstrap ?? true } } }),
    );
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        extractShellFunctionFromSource(src, "seed_default_workspace_templates"),
        `seed_default_workspace_templates ${JSON.stringify(workspaceDir)} ${JSON.stringify(templatesDir)} ${JSON.stringify(configPath)}`,
      ].join("\n"),
      { mode: 0o700 },
    );
    return spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
  }

  it("seeds the documented workspace templates and skips BOOTSTRAP.md", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-seed-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const templatesDir = path.join(tmpDir, "templates");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(templatesDir, { recursive: true });
    for (const name of [
      "AGENTS.md",
      "SOUL.md",
      "IDENTITY.md",
      "USER.md",
      "TOOLS.md",
      "HEARTBEAT.md",
      "BOOTSTRAP.md",
    ]) {
      fs.writeFileSync(
        path.join(templatesDir, name),
        `---\nsummary: "${name} template"\n---\n# ${name} template content\n`,
      );
    }
    try {
      const result = runSeed(workspaceDir, templatesDir, path.join(tmpDir, "seed.sh"));
      expect(result.status).toBe(0);
      for (const name of [
        "AGENTS.md",
        "SOUL.md",
        "IDENTITY.md",
        "USER.md",
        "TOOLS.md",
        "HEARTBEAT.md",
      ]) {
        expect(fs.existsSync(path.join(workspaceDir, name))).toBe(true);
      }
      // BOOTSTRAP.md must NOT be seeded — its presence triggers the
      // interactive identity-setup turn that skipBootstrap=true is meant
      // to suppress.
      expect(fs.existsSync(path.join(workspaceDir, "BOOTSTRAP.md"))).toBe(false);
      expect(fs.readFileSync(path.join(workspaceDir, "SOUL.md"), "utf-8")).toBe(
        "# SOUL.md template content\n",
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not seed unless OpenClaw bootstrap is explicitly skipped", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-seed-bootstrap-on-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const templatesDir = path.join(tmpDir, "templates");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(path.join(templatesDir, "SOUL.md"), "soul template");
    try {
      const result = runSeed(workspaceDir, templatesDir, path.join(tmpDir, "seed.sh"), {
        skipBootstrap: false,
      });
      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(workspaceDir, "SOUL.md"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not clobber an already-populated workspace", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-seed-existing-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const templatesDir = path.join(tmpDir, "templates");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "USER.md"), "user content");
    fs.writeFileSync(path.join(templatesDir, "USER.md"), "template content");
    fs.writeFileSync(path.join(templatesDir, "SOUL.md"), "soul template");
    try {
      const result = runSeed(workspaceDir, templatesDir, path.join(tmpDir, "seed.sh"));
      expect(result.status).toBe(0);
      expect(fs.readFileSync(path.join(workspaceDir, "USER.md"), "utf-8")).toBe("user content");
      // Workspace was non-empty, so no other templates were copied in.
      expect(fs.existsSync(path.join(workspaceDir, "SOUL.md"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses to seed a symlinked workspace dir", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-seed-symlink-"));
    const realDir = path.join(tmpDir, "real");
    const linkDir = path.join(tmpDir, "link");
    const templatesDir = path.join(tmpDir, "templates");
    fs.mkdirSync(realDir);
    fs.mkdirSync(templatesDir);
    fs.symlinkSync(realDir, linkDir);
    fs.writeFileSync(path.join(templatesDir, "SOUL.md"), "soul template");
    try {
      const result = runSeed(linkDir, templatesDir, path.join(tmpDir, "seed.sh"));
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("refusing to seed symlinked workspace dir");
      expect(fs.existsSync(path.join(realDir, "SOUL.md"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});

describe("Slack token rewriter (#2085)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  function extractFunction(name: string): string {
    const match = src.match(new RegExp(`${name}\\(\\) \\{([\\s\\S]*?)^\\}`, "m"));
    if (!match) {
      throw new Error(`Expected ${name} in scripts/nemoclaw-start.sh`);
    }
    return `${name}() {${match[1]}\n}`;
  }

  function slackRewriterSection(rewriterPath: string, configPath: string): string {
    const start = src.indexOf("# ── Slack token rewriter");
    const end = src.indexOf("# ── Slack secrets-on-disk tripwire", start);
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Expected Slack token rewriter section in scripts/nemoclaw-start.sh");
    }
    return src
      .slice(start, end)
      .replace(
        '_SLACK_REWRITER_SCRIPT="/tmp/nemoclaw-slack-token-rewriter.js"',
        `_SLACK_REWRITER_SCRIPT=${JSON.stringify(rewriterPath)}`,
      )
      .replace(
        '_SLACK_REWRITER_SOURCE="/usr/local/lib/nemoclaw/preloads/slack-token-rewriter.js"',
        `_SLACK_REWRITER_SOURCE=${JSON.stringify(path.join(PRELOAD_SCRIPTS, "slack-token-rewriter.js"))}`,
      )
      .replace(
        'local config_file="/sandbox/.openclaw/openclaw.json"',
        `local config_file=${JSON.stringify(configPath)}`,
      );
  }

  it("installs the rewriter only when a Slack placeholder is present", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-rewriter-start-"));
    const configPath = path.join(tmpDir, "openclaw.json");
    const rewriterPath = path.join(tmpDir, "slack-token-rewriter.js");
    const scriptPath = path.join(tmpDir, "run.sh");
    const run = (config: string) => {
      fs.writeFileSync(configPath, config);
      fs.rmSync(rewriterPath, { force: true });
      fs.writeFileSync(
        scriptPath,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
          "NODE_OPTIONS='--require /already-loaded.js'",
          slackRewriterSection(rewriterPath, configPath),
          "install_slack_token_rewriter",
          'printf "NODE_OPTIONS=%s\\n" "$NODE_OPTIONS"',
        ].join("\n"),
        { mode: 0o700 },
      );
      return spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
    };

    try {
      const noSlack = run('{"channels":{}}\n');
      expect(noSlack.status).toBe(0);
      expect(fs.existsSync(rewriterPath)).toBe(false);
      expect(noSlack.stdout).not.toContain(rewriterPath);

      const withSlack = run('{"botToken":"xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN"}\n');
      expect(withSlack.status).toBe(0);
      expect(fs.existsSync(rewriterPath)).toBe(true);
      expect((fs.statSync(rewriterPath).mode & 0o777).toString(8)).toBe("444");
      expect(withSlack.stdout).toContain("--require /already-loaded.js");
      expect(withSlack.stdout).toContain(`--require ${rewriterPath}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("refuses to serve when real Slack tokens leak to disk", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-secret-"));
    const configPath = path.join(tmpDir, "openclaw.json");
    const scriptPath = path.join(tmpDir, "run.sh");
    const fn = extractFunction("verify_no_slack_secrets_on_disk").replace(
      'local config="/sandbox/.openclaw/openclaw.json"',
      `local config=${JSON.stringify(configPath)}`,
    );
    const run = (config: string) => {
      fs.writeFileSync(configPath, config);
      fs.writeFileSync(
        scriptPath,
        ["#!/usr/bin/env bash", "set -euo pipefail", fn, "verify_no_slack_secrets_on_disk"].join(
          "\n",
        ),
        { mode: 0o700 },
      );
      return spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
    };

    try {
      expect(run('{"botToken":"xoxb-real-token"}\n').status).toBe(78);
      expect(run('{"appToken":"xapp-real-token"}\n').status).toBe(78);
      expect(run('{"botToken":"xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN"}\n').status).toBe(0);
      expect(run('{"token":"openshell:resolve:env:SLACK_BOT_TOKEN"}\n').status).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Telegram diagnostics (#2766)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const telegramDiagnosticsScript = startScriptHeredoc(src, "TELEGRAM_DIAGNOSTICS_EOF");

  function telegramDiagnosticsSection(preloadPath: string, configPath: string): string {
    const start = src.indexOf("# ── Telegram diagnostics");
    const end = src.indexOf("_read_gateway_token()", start);
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Expected Telegram diagnostics section in scripts/nemoclaw-start.sh");
    }
    return src
      .slice(start, end)
      .replace(
        '_TELEGRAM_DIAGNOSTICS_SCRIPT="/tmp/nemoclaw-telegram-diagnostics.js"',
        `_TELEGRAM_DIAGNOSTICS_SCRIPT=${JSON.stringify(preloadPath)}`,
      )
      .replace(
        '_TELEGRAM_DIAGNOSTICS_SOURCE="/usr/local/lib/nemoclaw/preloads/telegram-diagnostics.js"',
        `_TELEGRAM_DIAGNOSTICS_SOURCE=${JSON.stringify(path.join(PRELOAD_SCRIPTS, "telegram-diagnostics.js"))}`,
      )
      .replace(
        'local config_file="/sandbox/.openclaw/openclaw.json"',
        `local config_file=${JSON.stringify(configPath)}`,
      );
  }

  function preGatewaySetupBlock(kind: "non-root" | "root", gatewayLog: string, autoPairLog: string) {
    const nonRootMarker = src.indexOf("# ── Non-root fallback");
    const start =
      kind === "non-root"
        ? src.indexOf('if [ "$(id -u)" -ne 0 ]; then', nonRootMarker)
        : src.indexOf("# Verify locked config integrity before starting anything.");
    const endMarker =
      kind === "non-root"
        ? "  # Start gateway in background, auto-pair, then wait"
        : "# Start the gateway as the 'gateway' user.";
    const end = src.indexOf(endMarker, start);
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(`Expected ${kind} pre-gateway setup block in scripts/nemoclaw-start.sh`);
    }
    const block = src
      .slice(start, end)
      .replaceAll("/tmp/gateway.log", gatewayLog)
      .replaceAll("/tmp/auto-pair.log", autoPairLog);
    return kind === "non-root" ? `${block}fi\n` : block;
  }

  function runPreGatewaySetup(kind: "non-root" | "root") {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-telegram-${kind}-`));
    const configPath = path.join(tmpDir, "openclaw.json");
    const preloadPath = path.join(tmpDir, "telegram-diagnostics.js");
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const autoPairLog = path.join(tmpDir, "auto-pair.log");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.writeFileSync(configPath, '{"channels":{"telegram":{}}}\n');
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        kind === "non-root"
          ? 'id() { if [ "${1:-}" = "-u" ]; then printf "1000"; elif [ "${1:-}" = "-g" ]; then printf "1000"; else command id "$@"; fi; }'
          : 'id() { if [ "${1:-}" = "-u" ]; then printf "0"; elif [ "${1:-}" = "-g" ]; then printf "0"; else command id "$@"; fi; }',
        'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
        'verify_config_integrity_if_locked() { echo "ORDER:verify"; }',
        'normalize_mutable_config_perms() { echo "ORDER:normalize"; }',
        'apply_model_override() { :; }',
        'apply_cors_override() { :; }',
        'export_gateway_token() { :; }',
        'write_runtime_shell_env() { :; }',
        'ensure_runtime_shell_env_shim() { :; }',
        'lock_rc_files() { :; }',
        'configure_messaging_channels() { echo "ORDER:configure"; }',
        'install_slack_token_rewriter() { :; }',
        'install_slack_channel_guard() { :; }',
        'verify_no_slack_secrets_on_disk() { :; }',
        'write_auth_profile() { :; }',
        'harden_auth_profiles() { :; }',
        'seed_default_workspace_templates() { :; }',
        'chown() { :; }',
        'chown_tree_no_symlink_follow() { :; }',
        'start_persistent_gateway_log_mirror() { :; }',
        'gosu() { shift; "$@"; }',
        'validate_tmp_permissions() { printf "VALIDATE:%s\\n" "$*"; }',
        '_SANDBOX_HOME=/sandbox',
        `_SANDBOX_SAFETY_NET=${JSON.stringify(path.join(tmpDir, "safety.js"))}`,
        `_PROXY_FIX_SCRIPT=${JSON.stringify(path.join(tmpDir, "proxy-fix.js"))}`,
        `_NEMOTRON_FIX_SCRIPT=${JSON.stringify(path.join(tmpDir, "nemotron-fix.js"))}`,
        `_WS_FIX_SCRIPT=${JSON.stringify(path.join(tmpDir, "ws-fix.js"))}`,
        `_SECCOMP_GUARD_SCRIPT=${JSON.stringify(path.join(tmpDir, "seccomp-guard.js"))}`,
        `_CIAO_GUARD_SCRIPT=${JSON.stringify(path.join(tmpDir, "ciao-guard.js"))}`,
        `_SLACK_GUARD_SCRIPT=${JSON.stringify(path.join(tmpDir, "slack-guard.js"))}`,
        `_SLACK_REWRITER_SCRIPT=${JSON.stringify(path.join(tmpDir, "slack-rewriter.js"))}`,
        "NEMOCLAW_CMD=()",
        telegramDiagnosticsSection(preloadPath, configPath),
        preGatewaySetupBlock(kind, gatewayLog, autoPairLog),
      ].join("\n"),
      { mode: 0o700 },
    );

    const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
    const preloadExists = fs.existsSync(preloadPath);
    const preloadMode = preloadExists ? (fs.statSync(preloadPath).mode & 0o777).toString(8) : "";
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { result, preloadExists, preloadMode, preloadPath };
  }

  it("installs a Telegram diagnostics preload only when Telegram is configured", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-telegram-install-"));
    const configPath = path.join(tmpDir, "openclaw.json");
    const preloadPath = path.join(tmpDir, "telegram-diagnostics.js");
    const scriptPath = path.join(tmpDir, "run.sh");
    const run = (config: string) => {
      fs.writeFileSync(configPath, config);
      fs.rmSync(preloadPath, { force: true });
      fs.writeFileSync(
        scriptPath,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
          "NODE_OPTIONS='--require /already-loaded.js'",
          telegramDiagnosticsSection(preloadPath, configPath),
          "install_telegram_diagnostics",
          'printf "NODE_OPTIONS=%s\\n" "$NODE_OPTIONS"',
        ].join("\n"),
        { mode: 0o700 },
      );
      return spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
    };

    try {
      const noTelegram = run('{"channels":{}}\n');
      expect(noTelegram.status).toBe(0);
      expect(fs.existsSync(preloadPath)).toBe(false);
      expect(noTelegram.stdout).toContain("NODE_OPTIONS=--require /already-loaded.js");
      expect(noTelegram.stdout).not.toContain(preloadPath);

      const withTelegram = run('{"channels":{"telegram":{}}}\n');
      expect(withTelegram.status).toBe(0);
      expect(fs.existsSync(preloadPath)).toBe(true);
      expect((fs.statSync(preloadPath).mode & 0o777).toString(8)).toBe("444");
      expect(withTelegram.stdout).toContain("--require /already-loaded.js");
      expect(withTelegram.stdout).toContain(`--require ${preloadPath}`);
      expect(withTelegram.stderr).toContain("Telegram diagnostics installed");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("emits provider readiness for successful Telegram Bot API startup probes", () => {
    const run = spawnSync(
      process.execPath,
      [
        "-e",
        `
const { EventEmitter } = require('node:events');
const https = require('node:https');
https.request = function () {
  const req = new EventEmitter();
  process.nextTick(() => req.emit('response', { statusCode: 200 }));
  return req;
};
${telegramDiagnosticsScript}
https.request('https://api.telegram.org/bot123456:SECRET/getMe');
https.request('https://api.telegram.org/bot123456:SECRET/getUpdates?offset=1');
setTimeout(() => {}, 5);
`,
      ],
      { encoding: "utf-8" },
    );

    expect(run.status).toBe(0);
    const readinessLines = run.stderr
      .split(/\r?\n/)
      .filter((line) => line.includes("provider ready"));
    expect(readinessLines).toHaveLength(1);
    expect(readinessLines[0]).toContain("inference.local");
    expect(readinessLines[0]).not.toContain("SECRET");
  });

  it("emits inference diagnostics only after provider startup and redacts token values", () => {
    const run = spawnSync(
      process.execPath,
      [
        "-e",
        `
${telegramDiagnosticsScript}
process.stderr.write('LLM request failed: token=123456:BEFORE\\n');
process.stderr.write('[telegram] [default] starting provider\\n');
process.stderr.write('Embedded agent failed before reply: token=123456:AFTER\\n');
process.stderr.write('FailoverError: token=123456:LATER\\n');
`,
      ],
      { encoding: "utf-8" },
    );

    expect(run.status).toBe(0);
    const diagnosticLines = run.stderr
      .split(/\r?\n/)
      .filter((line) => line.includes("agent turn failed after provider startup"));
    expect(diagnosticLines).toHaveLength(1);
    expect(diagnosticLines[0]).toContain("Embedded agent failed before reply");
    expect(diagnosticLines[0]).toContain("token=<redacted>");
    expect(diagnosticLines[0]).not.toContain("AFTER");
    expect(diagnosticLines[0]).not.toContain("LATER");
  });

  it("installs and validates the diagnostics preload in both entrypoint paths before gateway launch", () => {
    for (const kind of ["non-root", "root"] as const) {
      const setup = runPreGatewaySetup(kind);
      expect(setup.result.status).toBe(0);
      expect(setup.preloadExists).toBe(true);
      expect(setup.preloadMode).toBe("444");
      expect(setup.result.stdout).toContain("ORDER:configure");
      expect(setup.result.stdout).toContain("VALIDATE:");
      expect(setup.result.stdout).toContain(setup.preloadPath);
    }
  });

  it("connect-shell rc sources the diagnostics preload when present", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-telegram-rc-"));
    const proxyEnv = path.join(tmpDir, "proxy-env.sh");
    const preloadPath = path.join(tmpDir, "telegram-diagnostics.js");
    const scriptPath = path.join(tmpDir, "write-env.sh");
    const runtimeBlock = `${runtimeShellEnvBlock(src)}\nwrite_runtime_shell_env`.replaceAll(
      "/tmp/nemoclaw-proxy-env.sh",
      proxyEnv,
    );
    fs.writeFileSync(preloadPath, "// diagnostics\n");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
        'PROXY_HOST="10.200.0.1"',
        'PROXY_PORT="3128"',
        '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
        '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
        `_SANDBOX_SAFETY_NET=${JSON.stringify(path.join(tmpDir, "safety.js"))}`,
        `_PROXY_FIX_SCRIPT=${JSON.stringify(path.join(tmpDir, "proxy-fix.js"))}`,
        `_WS_FIX_SCRIPT=${JSON.stringify(path.join(tmpDir, "ws-fix.js"))}`,
        `_NEMOTRON_FIX_SCRIPT=${JSON.stringify(path.join(tmpDir, "nemotron-fix.js"))}`,
        `_SECCOMP_GUARD_SCRIPT=${JSON.stringify(path.join(tmpDir, "seccomp-guard.js"))}`,
        `_CIAO_GUARD_SCRIPT=${JSON.stringify(path.join(tmpDir, "ciao-guard.js"))}`,
        `_TELEGRAM_DIAGNOSTICS_SCRIPT=${JSON.stringify(preloadPath)}`,
        `_SLACK_GUARD_SCRIPT=${JSON.stringify(path.join(tmpDir, "slack-guard.js"))}`,
        `_SLACK_REWRITER_SCRIPT=${JSON.stringify(path.join(tmpDir, "slack-rewriter.js"))}`,
        "_TOOL_REDIRECTS=()",
        "set +u",
        runtimeBlock,
      ].join("\n"),
      { mode: 0o700 },
    );

    const sourceRuntimeEnv = () =>
      spawnSync(
        "bash",
        ["--norc", "-lc", `source ${JSON.stringify(proxyEnv)}; printf 'NODE_OPTIONS=%s\\n' "$NODE_OPTIONS"`],
        { encoding: "utf-8", env: { PATH: process.env.PATH || "", NODE_OPTIONS: "" }, timeout: 5000 },
      );

    try {
      const write = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(write.status).toBe(0);

      const withPreload = sourceRuntimeEnv();
      expect(withPreload.status).toBe(0);
      expect(withPreload.stdout).toContain(preloadPath);

      fs.rmSync(preloadPath, { force: true });
      const withoutPreload = sourceRuntimeEnv();
      expect(withoutPreload.status).toBe(0);
      expect(withoutPreload.stdout).not.toContain(preloadPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("write_auth_profile (#1332)", () => {
  // Invokes write_auth_profile from the production start script in an isolated
  // HOME, then asserts on the resulting auth-profiles.json — observable
  // behavior, not source-text shape.
  const wrapper = [
    "set -euo pipefail",
    `eval "$(sed -n '/^write_auth_profile() {$/,/^}$/p' "$1")"`,
    "write_auth_profile",
  ].join("\n");

  function runWriteAuthProfile(env: Record<string, string>): {
    home: string;
    authPath: string;
    status: number;
    stderr: string;
  } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-test-"));
    const result = spawnSync("bash", ["-s", "--", START_SCRIPT], {
      input: wrapper,
      env: { PATH: process.env.PATH, HOME: home, ...env },
      encoding: "utf-8",
    });
    return {
      home,
      authPath: path.join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json"),
      status: result.status ?? -1,
      stderr: result.stderr ?? "",
    };
  }

  it("writes profile under the provider key from NEMOCLAW_PROVIDER_KEY", () => {
    const { home, authPath, status, stderr } = runWriteAuthProfile({
      NVIDIA_API_KEY: "secret",
      NEMOCLAW_PROVIDER_KEY: "openai",
    });
    try {
      expect(status, stderr).toBe(0);
      const profile = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      expect(profile).toEqual({
        "openai:manual": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", id: "NVIDIA_API_KEY" },
          profileId: "openai:manual",
        },
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to 'inference' when NEMOCLAW_PROVIDER_KEY is unset", () => {
    const { home, authPath, status, stderr } = runWriteAuthProfile({
      NVIDIA_API_KEY: "secret",
    });
    try {
      expect(status, stderr).toBe(0);
      const profile = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      expect(profile).toHaveProperty("inference:manual");
      expect(profile["inference:manual"].provider).toBe("inference");
      expect(profile).not.toHaveProperty("nvidia:manual");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not use 'nvidia' as the default provider key", () => {
    const { home, authPath, status } = runWriteAuthProfile({
      NVIDIA_API_KEY: "secret",
    });
    try {
      expect(status).toBe(0);
      const profile = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      for (const key of Object.keys(profile)) {
        expect(key).not.toMatch(/^nvidia:/);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("treats provider_key as a literal (no shell command substitution)", () => {
    // If the provider_key were interpolated into the heredoc instead of
    // passed as argv, $(...) inside the value would execute and replace it.
    const { home, authPath, status, stderr } = runWriteAuthProfile({
      NVIDIA_API_KEY: "secret",
      NEMOCLAW_PROVIDER_KEY: "$(echo pwned)",
    });
    try {
      expect(status, stderr).toBe(0);
      const profile = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      expect(profile).toHaveProperty("$(echo pwned):manual");
      expect(profile["$(echo pwned):manual"].provider).toBe("$(echo pwned)");
      expect(profile).not.toHaveProperty("pwned:manual");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("is a no-op when NVIDIA_API_KEY is unset", () => {
    const { home, authPath, status } = runWriteAuthProfile({});
    try {
      expect(status).toBe(0);
      expect(fs.existsSync(authPath)).toBe(false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("writes the auth profile with 0600 permissions", () => {
    const { home, authPath, status } = runWriteAuthProfile({
      NVIDIA_API_KEY: "secret",
      NEMOCLAW_PROVIDER_KEY: "openai",
    });
    try {
      expect(status).toBe(0);
      const mode = fs.statSync(authPath).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
