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

  it("unwraps the sandbox-create env self-wrapper before building NEMOCLAW_CMD", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");

    expect(src).toContain('if [ "${1:-}" = "env" ]; then');
    expect(src).toContain('export "${_raw_args[$i]}"');
    expect(src).toContain('set -- "${_raw_args[@]:$((_self_wrapper_index + 1))}"');
  });
});

describe("nemoclaw-start _SANDBOX_HOME variable (#1609)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("defines _SANDBOX_HOME before first use", () => {
    const defPos = src.indexOf('_SANDBOX_HOME="/sandbox"');
    expect(defPos).toBeGreaterThan(-1);

    // All usages must come after the definition
    const usages = [...src.matchAll(/\$\{?_SANDBOX_HOME\}?/g)];
    expect(usages.length).toBeGreaterThanOrEqual(3);
    for (const m of usages) {
      // Skip the definition line itself
      if (m.index === defPos) continue;
      expect(m.index).toBeGreaterThan(defPos);
    }
  });

  it("uses _SANDBOX_HOME for rc file paths in export_gateway_token", () => {
    const exportFn = src.match(/export_gateway_token\(\) \{([\s\S]*?)^\}/m);
    expect(exportFn).toBeTruthy();
    expect(exportFn[1]).toContain("${_SANDBOX_HOME}/.bashrc");
    expect(exportFn[1]).toContain("${_SANDBOX_HOME}/.profile");
  });

  it("uses _SANDBOX_HOME for rc file paths in install_configure_guard", () => {
    const guardFn = src.match(
      /install_configure_guard\(\) \{([\s\S]*?)^validate_openclaw_symlinks/m,
    );
    expect(guardFn).toBeTruthy();
    expect(guardFn[1]).toContain("${_SANDBOX_HOME}/.bashrc");
    expect(guardFn[1]).toContain("${_SANDBOX_HOME}/.profile");
  });
});

describe("nemoclaw-start gateway token export (#1114)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("defines _read_gateway_token helper used by both export and dashboard", () => {
    expect(src).toMatch(/_read_gateway_token\(\) \{/);
    // export_gateway_token calls the helper
    expect(src).toMatch(/token="\$\(_read_gateway_token\)"/);
    // print_dashboard_urls also calls the helper
    const dashboardFn = src.match(/print_dashboard_urls\(\) \{([\s\S]*?)^\}/m);
    expect(dashboardFn).toBeTruthy();
    expect(dashboardFn[1]).toContain("_read_gateway_token");
  });

  it("uses with-open context manager in the Python snippet", () => {
    const helperFn = src.match(/_read_gateway_token\(\) \{([\s\S]*?)^\}/m);
    expect(helperFn).toBeTruthy();
    expect(helperFn[1]).toContain("with open(");
  });

  it("unsets stale OPENCLAW_GATEWAY_TOKEN when token is empty", () => {
    const exportFn = src.match(/export_gateway_token\(\) \{([\s\S]*?)^\}/m);
    expect(exportFn).toBeTruthy();
    const body = exportFn[1];
    // Must unset before returning on empty token
    const unsetPos = body.indexOf("unset OPENCLAW_GATEWAY_TOKEN");
    const returnPos = body.indexOf("return");
    expect(unsetPos).toBeGreaterThan(-1);
    expect(returnPos).toBeGreaterThan(-1);
    expect(unsetPos).toBeLessThan(returnPos);
  });

  it("shell-escapes the token before embedding in rc snippet", () => {
    const exportFn = src.match(/export_gateway_token\(\) \{([\s\S]*?)^\}/m);
    expect(exportFn).toBeTruthy();
    const body = exportFn[1];
    // Must use single quotes around the escaped token value
    expect(body).toContain("escaped_token");
    expect(body).toMatch(/export OPENCLAW_GATEWAY_TOKEN='\$\{escaped_token\}'/);
  });

  it("calls export_gateway_token in both root and non-root paths", () => {
    const calls = src.match(/export_gateway_token/g) || [];
    // definition + 2 call sites
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe("nemoclaw-start configure guard (#1114)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("defines install_configure_guard function", () => {
    expect(src).toMatch(/install_configure_guard\(\) \{/);
  });

  it("intercepts openclaw configure with an actionable error", () => {
    // The guard installs a heredoc containing a shell function — extract the
    // full block between the function definition and the next top-level function.
    const guardBlock = src.match(
      /install_configure_guard\(\) \{([\s\S]*?)^validate_openclaw_symlinks/m,
    );
    expect(guardBlock).toBeTruthy();
    const body = guardBlock[1];
    expect(body).toContain("configure)");
    expect(body).toContain("nemoclaw onboard --resume");
    expect(body).toContain("return 1");
  });

  it("passes non-configure subcommands through to the real binary", () => {
    const guardBlock = src.match(
      /install_configure_guard\(\) \{([\s\S]*?)^validate_openclaw_symlinks/m,
    );
    expect(guardBlock).toBeTruthy();
    expect(guardBlock[1]).toContain('command openclaw "$@"');
  });

  it("uses idempotent marker blocks", () => {
    const guardBlock = src.match(
      /install_configure_guard\(\) \{([\s\S]*?)^validate_openclaw_symlinks/m,
    );
    expect(guardBlock).toBeTruthy();
    const body = guardBlock[1];
    expect(body).toContain("nemoclaw-configure-guard begin");
    expect(body).toContain("nemoclaw-configure-guard end");
    // Uses awk to strip existing block before re-inserting
    expect(body).toContain("awk");
  });

  it("calls install_configure_guard in both root and non-root paths", () => {
    const calls = src.match(/install_configure_guard/g) || [];
    // definition + 2 call sites
    expect(calls.length).toBeGreaterThanOrEqual(3);
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

describe("nemoclaw-start signal handling", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("defines cleanup() as a single top-level function", () => {
    const matches = src.match(/^cleanup\(\)/gm);
    expect(matches).toHaveLength(1);
  });

  it("cleanup() forwards SIGTERM to both GATEWAY_PID and AUTO_PAIR_PID", () => {
    const cleanup = src.match(/cleanup\(\) \{[\s\S]*?^}/m)?.[0];
    expect(cleanup).toBeDefined();
    expect(cleanup).toMatch(/kill -TERM "\$GATEWAY_PID"/);
    expect(cleanup).toMatch(/kill -TERM "\$AUTO_PAIR_PID"/);
  });

  it("cleanup() waits for both child processes", () => {
    const cleanup = src.match(/cleanup\(\) \{[\s\S]*?^}/m)?.[0];
    expect(cleanup).toMatch(/wait "\$GATEWAY_PID"/);
    expect(cleanup).toMatch(/wait "\$AUTO_PAIR_PID"/);
  });

  it("cleanup() exits with the gateway exit status", () => {
    const cleanup = src.match(/cleanup\(\) \{[\s\S]*?^}/m)?.[0];
    expect(cleanup).toMatch(/exit "\$gateway_status"/);
  });

  it("registers trap before start_auto_pair in non-root path", () => {
    // trap must appear before start_auto_pair within the non-root block
    const nonRootBlock = src.match(/if \[ "\$\(id -u\)" -ne 0 \]; then[\s\S]*?^fi$/m)?.[0];
    expect(nonRootBlock).toBeDefined();
    const trapIdx = nonRootBlock.indexOf("trap cleanup SIGTERM SIGINT");
    const autoIdx = nonRootBlock.indexOf("start_auto_pair");
    expect(trapIdx).toBeGreaterThan(-1);
    expect(autoIdx).toBeGreaterThan(-1);
    expect(trapIdx).toBeLessThan(autoIdx);
  });

  it("registers trap before start_auto_pair in root path", () => {
    // In the root path (after the non-root fi), trap must precede start_auto_pair
    const rootBlock = src.split(/^fi$/m).slice(-1)[0];
    const trapIdx = rootBlock.indexOf("trap cleanup SIGTERM SIGINT");
    const autoIdx = rootBlock.indexOf("start_auto_pair");
    expect(trapIdx).toBeGreaterThan(-1);
    expect(autoIdx).toBeGreaterThan(-1);
    expect(trapIdx).toBeLessThan(autoIdx);
  });

  it("captures AUTO_PAIR_PID from background process", () => {
    expect(src).toMatch(/AUTO_PAIR_PID=\$!/);
  });
});
