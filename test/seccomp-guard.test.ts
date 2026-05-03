// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

function extractStartScriptHeredoc(src: string, marker: string): string {
  const heredoc = src.match(new RegExp(`<<'${marker}'\\n([\\s\\S]*?)\\n${marker}`));
  if (!heredoc) {
    throw new Error(`Expected ${marker} heredoc in scripts/nemoclaw-start.sh`);
  }
  return heredoc[1];
}

function extractRuntimeShellEnvSnippet(src: string): string {
  const start = src.indexOf("write_runtime_shell_env() {");
  const end = src.indexOf("# cleanup_on_signal", start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Expected write_runtime_shell_env in scripts/nemoclaw-start.sh");
  }
  return `${src.slice(start, end).trimEnd()}\nwrite_runtime_shell_env`;
}

describe("Seccomp guard preload", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("entrypoint writes the preload and propagates it to connect-session env", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-seccomp-entrypoint-"));
    const preloadPath = path.join(tempDir, "seccomp-guard.js");
    const proxyEnvPath = path.join(tempDir, "proxy-env.sh");
    const start = src.indexOf("# ── Seccomp syscall guard");
    const end = src.indexOf("# OpenShell re-injects narrow NO_PROXY", start);
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Expected seccomp guard entrypoint block in scripts/nemoclaw-start.sh");
    }
    const block = src.slice(start, end).replaceAll("/tmp/nemoclaw-seccomp-guard.js", preloadPath);
    const persistBlock = extractRuntimeShellEnvSnippet(src).replaceAll(
      "/tmp/nemoclaw-proxy-env.sh",
      proxyEnvPath,
    );
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `source ${JSON.stringify(path.join(import.meta.dirname, "..", "scripts", "lib", "sandbox-init.sh"))}`,
      "emit_sandbox_sourced_file() { local target=\"$1\"; cat > \"$target\"; chmod 444 \"$target\"; }",
      "NODE_OPTIONS='--require /already-loaded.js'",
      block,
      'PROXY_HOST="10.200.0.1"',
      'PROXY_PORT="3128"',
      '_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"',
      '_NO_PROXY_VAL="localhost,127.0.0.1,::1,${PROXY_HOST}"',
      '_TOOL_REDIRECTS=()',
      '_PROXY_FIX_SCRIPT="/tmp/nemoclaw-http-proxy-fix.js"',
      '_WS_FIX_SCRIPT="/nonexistent/ws-proxy-fix.js"',
      '_NEMOTRON_FIX_SCRIPT="/tmp/nemoclaw-nemotron-inference-fix.js"',
      "set +u",
      persistBlock,
      "printf 'NODE_OPTIONS=%s\\n' \"$NODE_OPTIONS\"",
      "printf 'SCRIPT=%s\\n' \"$_SECCOMP_GUARD_SCRIPT\"",
    ].join("\n");
    const wrapperPath = path.join(tempDir, "run.sh");

    try {
      fs.writeFileSync(wrapperPath, wrapper, { mode: 0o700 });
      const result = spawnSync("bash", [wrapperPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`SCRIPT=${preloadPath}`);
      expect(result.stdout).toContain("--require /already-loaded.js");
      expect(result.stdout).toContain(`--require ${preloadPath}`);
      const stat = fs.statSync(preloadPath);
      expect(stat.isFile()).toBe(true);
      expect((stat.mode & 0o777).toString(8)).toBe("444");
      const envFile = fs.readFileSync(proxyEnvPath, "utf-8");
      expect(envFile).toContain(`--require ${preloadPath}`);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preload returns empty object when uv_interface_addresses is blocked", () => {
    // Extract the guard script from the heredoc and run it in a subprocess
    // that simulates a seccomp-blocked os.networkInterfaces().
    const guardScript = extractStartScriptHeredoc(src, "SECCOMP_GUARD_EOF");

    const testScript = `
      // Simulate seccomp-blocked os.networkInterfaces
      const os = require('os');
      const _origNI = os.networkInterfaces;
      os.networkInterfaces = function() {
        throw new SystemError('uv_interface_addresses');
      };
      class SystemError extends Error {
        constructor(msg) { super('A system error occurred: ' + msg + ' returned Unknown system error 1 (Unknown system error 1)'); }
      }

      // Load the guard (it patches os.networkInterfaces)
      ${guardScript}

      // Verify the patch works
      const result = os.networkInterfaces();
      console.log(JSON.stringify({ result, type: typeof result }));
    `;

    const r = spawnSync(process.execPath, ["-e", testScript], {
      encoding: "utf-8",
      timeout: 5000,
    });
    expect(r.status).toBe(0);
    const output = JSON.parse(r.stdout.trim());
    expect(output.result).toEqual({});
    expect(output.type).toBe("object");
  });

  it("preload re-throws non-seccomp errors from os.networkInterfaces", () => {
    const guardScript = extractStartScriptHeredoc(src, "SECCOMP_GUARD_EOF");

    const testScript = `
      const os = require('os');
      os.networkInterfaces = function() {
        throw new Error('some other error');
      };

      ${guardScript}

      try {
        os.networkInterfaces();
        console.log('NO_THROW');
      } catch (e) {
        console.log('THREW:' + e.message);
      }
    `;

    const r = spawnSync(process.execPath, ["-e", testScript], {
      encoding: "utf-8",
      timeout: 5000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("THREW:some other error");
  });

  it("preload passes through when os.networkInterfaces works normally", () => {
    const guardScript = extractStartScriptHeredoc(src, "SECCOMP_GUARD_EOF");

    const testScript = `
      const os = require('os');
      const fakeResult = { lo: [{ address: '127.0.0.1', family: 'IPv4' }] };
      os.networkInterfaces = function() { return fakeResult; };

      ${guardScript}

      const result = os.networkInterfaces();
      console.log(JSON.stringify(result));
    `;

    const r = spawnSync(process.execPath, ["-e", testScript], {
      encoding: "utf-8",
      timeout: 5000,
    });
    expect(r.status).toBe(0);
    const output = JSON.parse(r.stdout.trim());
    expect(output.lo).toBeDefined();
    expect(output.lo[0].address).toBe("127.0.0.1");
  });
});

describe("ws-proxy-fix Landlock mitigation", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("copies ws-proxy-fix.js from a Landlock-readable source into /tmp and registers it", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ws-fix-entrypoint-"));
    const sourcePath = path.join(tempDir, "source-ws-proxy-fix.js");
    const runtimePath = path.join(tempDir, "runtime-ws-proxy-fix.js");
    const start = src.indexOf('_WS_FIX_SOURCE="/usr/local/lib/nemoclaw/ws-proxy-fix.js"');
    const end = src.indexOf("# ── Seccomp syscall guard", start);
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Expected ws-proxy-fix entrypoint block in scripts/nemoclaw-start.sh");
    }
    const block = src
      .slice(start, end)
      .replace(
        '_WS_FIX_SOURCE="/usr/local/lib/nemoclaw/ws-proxy-fix.js"',
        `_WS_FIX_SOURCE=${JSON.stringify(sourcePath)}`,
      )
      .replace(
        '_WS_FIX_SCRIPT="/tmp/nemoclaw-ws-proxy-fix.js"',
        `_WS_FIX_SCRIPT=${JSON.stringify(runtimePath)}`,
      );
    const wrapper = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "emit_sandbox_sourced_file() { local target=\"$1\"; cat > \"$target\"; chmod 444 \"$target\"; }",
      "NODE_OPTIONS='--require /already-loaded.js'",
      block,
      "printf 'NODE_OPTIONS=%s\\n' \"$NODE_OPTIONS\"",
      "printf 'SCRIPT=%s\\n' \"$_WS_FIX_SCRIPT\"",
    ].join("\n");
    const wrapperPath = path.join(tempDir, "run.sh");

    try {
      fs.writeFileSync(sourcePath, "// ws preload fixture\n");
      fs.writeFileSync(wrapperPath, wrapper, { mode: 0o700 });
      const result = spawnSync("bash", [wrapperPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`SCRIPT=${runtimePath}`);
      expect(result.stdout).toContain("--require /already-loaded.js");
      expect(result.stdout).toContain(`--require ${runtimePath}`);
      expect(fs.readFileSync(runtimePath, "utf-8")).toBe("// ws preload fixture\n");
      expect((fs.statSync(runtimePath).mode & 0o777).toString(8)).toBe("444");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

});

describe("Early entrypoint stderr capture", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("captures early stdout/stderr to a restricted diagnostic log", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-start-log-"));
    const logPath = path.join(tempDir, "nemoclaw-start.log");
    const start = src.indexOf("# ── Early stderr/stdout capture");
    const end = src.indexOf("# ── Source shared sandbox initialisation library", start);
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Expected early stderr/stdout capture block in scripts/nemoclaw-start.sh");
    }
    const block = src.slice(start, end).replaceAll("/tmp/nemoclaw-start.log", logPath);
    const wrapperPath = path.join(tempDir, "run.sh");
    fs.writeFileSync(
      wrapperPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        block,
        "echo stdout-line",
        "echo stderr-line >&2",
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [wrapperPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("stdout-line");
      expect(result.stderr).toContain("stderr-line");
      const log = fs.readFileSync(logPath, "utf-8");
      expect(log).toContain("stdout-line");
      expect(log).toContain("stderr-line");
      expect((fs.statSync(logPath).mode & 0o777).toString(8)).toBe("600");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
