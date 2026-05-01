// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

describe("Seccomp guard preload", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("defines _SECCOMP_GUARD_SCRIPT path variable", () => {
    expect(src).toContain('_SECCOMP_GUARD_SCRIPT="/tmp/nemoclaw-seccomp-guard.js"');
  });

  it("embeds the guard via a SECCOMP_GUARD_EOF heredoc", () => {
    expect(src).toMatch(
      /emit_sandbox_sourced_file\s+"\$_SECCOMP_GUARD_SCRIPT"\s+<<'SECCOMP_GUARD_EOF'/,
    );
    expect(src).toMatch(/^SECCOMP_GUARD_EOF$/m);
  });

  it("registers the preload in NODE_OPTIONS", () => {
    expect(src).toContain(
      'export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_SECCOMP_GUARD_SCRIPT"',
    );
  });

  it("includes the preload in the proxy-env sourced file for connect sessions", () => {
    expect(src).toMatch(/# Seccomp guard for connect sessions/);
    expect(src).toContain("--require $_SECCOMP_GUARD_SCRIPT");
  });

  it("passes the preload path to validate_tmp_permissions in both root and non-root branches", () => {
    const calls =
      src.match(/validate_tmp_permissions\s+[^;\n]*\$_SECCOMP_GUARD_SCRIPT/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("preload patches os.networkInterfaces to catch uv_interface_addresses errors", () => {
    const heredoc = src.match(/<<'SECCOMP_GUARD_EOF'\n([\s\S]*?)\nSECCOMP_GUARD_EOF/);
    expect(heredoc).not.toBeNull();
    const script = heredoc[1];
    expect(script).toContain("os.networkInterfaces");
    expect(script).toContain("uv_interface_addresses");
    expect(script).toContain("_origNetworkInterfaces");
  });

  it("preload returns empty object when uv_interface_addresses is blocked", () => {
    // Extract the guard script from the heredoc and run it in a subprocess
    // that simulates a seccomp-blocked os.networkInterfaces().
    const heredoc = src.match(/<<'SECCOMP_GUARD_EOF'\n([\s\S]*?)\nSECCOMP_GUARD_EOF/);
    expect(heredoc).not.toBeNull();
    const guardScript = heredoc[1];

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
    const heredoc = src.match(/<<'SECCOMP_GUARD_EOF'\n([\s\S]*?)\nSECCOMP_GUARD_EOF/);
    expect(heredoc).not.toBeNull();
    const guardScript = heredoc[1];

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
    const heredoc = src.match(/<<'SECCOMP_GUARD_EOF'\n([\s\S]*?)\nSECCOMP_GUARD_EOF/);
    expect(heredoc).not.toBeNull();
    const guardScript = heredoc[1];

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

  it("reads ws-proxy-fix.js from /usr/local/lib/nemoclaw/ not /opt/nemoclaw-blueprint/", () => {
    expect(src).toContain('_WS_FIX_SOURCE="/usr/local/lib/nemoclaw/ws-proxy-fix.js"');
    expect(src).not.toContain('_WS_FIX_SCRIPT="/opt/nemoclaw-blueprint/scripts/ws-proxy-fix.js"');
  });

  it("copies ws-proxy-fix.js to /tmp via emit_sandbox_sourced_file", () => {
    expect(src).toContain('_WS_FIX_SCRIPT="/tmp/nemoclaw-ws-proxy-fix.js"');
    expect(src).toMatch(/emit_sandbox_sourced_file\s+"\$_WS_FIX_SCRIPT"\s+<\s*"\$_WS_FIX_SOURCE"/);
  });

  it("Dockerfile copies ws-proxy-fix.js to /usr/local/lib/nemoclaw/", () => {
    const dockerfile = fs.readFileSync(
      path.join(import.meta.dirname, "..", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain(
      "COPY nemoclaw-blueprint/scripts/ws-proxy-fix.js /usr/local/lib/nemoclaw/ws-proxy-fix.js",
    );
  });
});

describe("Early entrypoint stderr capture", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("redirects stdout and stderr to /tmp/nemoclaw-start.log via tee", () => {
    expect(src).toContain('_START_LOG="/tmp/nemoclaw-start.log"');
    expect(src).toMatch(/exec\s+>\s+>\(tee\s+-a\s+"\$_START_LOG"\)/);
    expect(src).toMatch(/2>\s+>\(tee\s+-a\s+"\$_START_LOG"\s+>&2\)/);
  });

  it("restricts log permissions before writing to prevent token leakage", () => {
    expect(src).toMatch(/chmod 600 "\$_START_LOG"/);
  });
});
