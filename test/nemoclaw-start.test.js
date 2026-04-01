// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

describe("nemoclaw-start non-root fallback", () => {
  it("detaches gateway output from sandbox create in non-root mode", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");

    expect(src).toMatch(/if \[ "\$\(id -u\)" -ne 0 \]; then/);
    expect(src).toMatch(/touch \/tmp\/gateway\.log/);
    expect(src).toMatch(/nohup "\$OPENCLAW" gateway run >\/tmp\/gateway\.log 2>&1 &/);
  });

  it("exits on config integrity failure in non-root mode", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");

    // Non-root block must call verify_config_integrity and exit 1 on failure
    expect(src).toMatch(/if ! verify_config_integrity; then\s+.*exit 1/s);
    // Must not contain the old "proceeding anyway" fallback
    expect(src).not.toMatch(/proceeding anyway/i);
  });

  it("calls verify_config_integrity in both root and non-root paths", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");

    // The function must be called at least twice: once in the non-root
    // if-block and once in the root path below it.
    const calls = src.match(/verify_config_integrity/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(3); // definition + 2 call sites
  });

  it("sends startup diagnostics to stderr so they do not leak into bridge output (#1064)", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");

    expect(src).toContain("echo 'Setting up NemoClaw...' >&2");

    const nonRootBlock = src.match(/if \[ "\$\(id -u\)" -ne 0 \]; then([\s\S]*?)^fi$/m);
    expect(nonRootBlock).toBeTruthy();
    const block = nonRootBlock[1];

    const echoLines = block.match(/^\s*echo\s+.+$/gm) || [];
    expect(echoLines.length).toBeGreaterThan(0);
    for (const line of echoLines) {
      expect(line).toContain(">&2");
    }

    const dashboardFn = src.match(/print_dashboard_urls\(\) \{([\s\S]*?)^\}/m);
    expect(dashboardFn).toBeTruthy();
    const dashboardBody = dashboardFn[1];
    const dashboardEchoes = dashboardBody.match(/^\s*echo\s+.+$/gm) || [];
    expect(dashboardEchoes.length).toBeGreaterThan(0);
    for (const line of dashboardEchoes) {
      expect(line).toContain(">&2");
    }
  });
});

describe("nemoclaw-start auto-pair client whitelisting (#117)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("defines ALLOWED_CLIENTS whitelist containing openclaw-control-ui", () => {
    expect(src).toMatch(/ALLOWED_CLIENTS\s*=\s*\{.*'openclaw-control-ui'.*\}/);
  });

  it("defines ALLOWED_MODES whitelist containing webchat", () => {
    expect(src).toMatch(/ALLOWED_MODES\s*=\s*\{.*'webchat'.*\}/);
  });

  it("rejects devices not in the whitelist", () => {
    expect(src).toMatch(/client_id not in ALLOWED_CLIENTS and client_mode not in ALLOWED_MODES/);
    expect(src).toMatch(/\[auto-pair\] rejected unknown client=/);
  });

  it("validates device is a dict before accessing fields", () => {
    expect(src).toMatch(/if not isinstance\(device, dict\)/);
  });

  it("logs client identity on approval", () => {
    expect(src).toMatch(/\[auto-pair\] approved request=\{request_id\} client=\{client_id\}/);
  });

  it("does not unconditionally approve all pending devices", () => {
    // The old pattern: `(device or {}).get('requestId')` — approve everything
    // Must NOT be present in the auto-pair block
    expect(src).not.toMatch(/\(device or \{\}\)\.get\('requestId'\)/);
  });

  it("tracks handled requests to avoid reprocessing rejected devices", () => {
    expect(src).toMatch(/HANDLED\s*=\s*set\(\)/);
    expect(src).toMatch(/request_id in HANDLED/);
    expect(src).toMatch(/HANDLED\.add\(request_id\)/);
  });

  it("documents NEMOCLAW_DISABLE_DEVICE_AUTH as a build-time setting in the script header", () => {
    // Must mention it's build-time only — setting at runtime has no effect
    // because openclaw.json is baked and immutable
    const header = src.split("set -euo pipefail")[0];
    expect(header).toMatch(/NEMOCLAW_DISABLE_DEVICE_AUTH/);
    expect(header).toMatch(/build[- ]time/i);
  });

  it("defines ALLOWED_CLIENTS and ALLOWED_MODES outside the poll loop", () => {
    // These are constants — they should be defined once alongside HANDLED,
    // not reconstructed inside the `if pending:` block every poll cycle
    const autoPairBlock = src.match(/PYAUTOPAIR[\s\S]*?PYAUTOPAIR/);
    expect(autoPairBlock).toBeTruthy();
    const pyCode = autoPairBlock[0];

    // ALLOWED_CLIENTS/ALLOWED_MODES should appear BEFORE the `while` loop,
    // at the same level as HANDLED, APPROVED, etc.
    const allowedClientsPos = pyCode.indexOf("ALLOWED_CLIENTS");
    const whilePos = pyCode.indexOf("while time.time()");
    expect(allowedClientsPos).toBeGreaterThan(-1);
    expect(whilePos).toBeGreaterThan(-1);
    expect(allowedClientsPos).toBeLessThan(whilePos);
  });
});
