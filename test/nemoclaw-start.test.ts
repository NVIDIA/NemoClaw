// @ts-nocheck
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
    expect(src).toMatch(
      /nohup "\$OPENCLAW" gateway run --port "\$\{_DASHBOARD_PORT\}" >\/tmp\/gateway\.log 2>&1 &/,
    );
  });

  it("exits on config integrity failure in non-root mode", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");

    const nonRootBlock = src.match(/if \[ "\$\(id -u\)" -ne 0 \]; then([\s\S]*?)# ── Root path/);
    expect(nonRootBlock).toBeTruthy();
    // Non-root block must call verify_config_integrity (with config dir) and exit 1 on failure
    expect(nonRootBlock[1]).toMatch(/if ! verify_config_integrity\b.*; then\s+.*exit 1/s);
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

    // Extract the non-root block up to the Root path comment.
    // Using ^fi$ would match the first nested fi inside helper functions,
    // truncating the block and including file-writing echo lines that
    // intentionally omit >&2 (e.g., proxy-env.sh generation).
    const nonRootBlock = src.match(/if \[ "\$\(id -u\)" -ne 0 \]; then([\s\S]*?)# ── Root path/);
    expect(nonRootBlock).toBeTruthy();
    const block = nonRootBlock[1];

    // Only check top-level echo lines that are NOT inside { } > file redirects
    // or { } | emit_sandbox_sourced_file pipe patterns (proxy-env.sh, etc.)
    const braceStripped = block
      .replace(/^\s*\{[\s\S]*?^\s*\}\s*>\s*"[^"]*"\s*$/gm, "")
      .replace(/^\s*\{[\s\S]*?^\s*\}\s*\|\s*emit_sandbox_sourced_file\b[^\n]*$/gm, "");
    const echoLines = braceStripped.match(/^\s*echo\s+.+$/gm) || [];
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

describe("nemoclaw-start configure guard blocks --local (#2016)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("blocks openclaw agent --local with a hard error and return 1", () => {
    const guardBlock = src.match(
      /install_configure_guard\(\) \{([\s\S]*?)^validate_openclaw_symlinks/m,
    );
    expect(guardBlock).toBeTruthy();
    const body = guardBlock[1];
    // Must contain the agent) case that checks for --local
    expect(body).toContain("agent)");
    expect(body).toContain('"--local"');
    // Must print an error (not a warning) and return 1
    expect(body).toMatch(/echo "Error:.*--local.*not supported inside NemoClaw sandboxes/);
    expect(body).toMatch(/return 1/);
    // Must NOT contain the old warning pattern
    expect(body).not.toContain("[SECURITY] Warning");
  });

  it("suggests the correct alternative command without --local", () => {
    const guardBlock = src.match(
      /install_configure_guard\(\) \{([\s\S]*?)^validate_openclaw_symlinks/m,
    );
    expect(guardBlock).toBeTruthy();
    expect(guardBlock[1]).toContain("openclaw agent --agent main");
  });

  it("allows openclaw agent without --local to pass through", () => {
    const guardBlock = src.match(
      /install_configure_guard\(\) \{([\s\S]*?)^validate_openclaw_symlinks/m,
    );
    expect(guardBlock).toBeTruthy();
    const body = guardBlock[1];
    // The agent) case only returns 1 inside the --local check.
    // After the for loop, execution falls through to `command openclaw "$@"`.
    expect(body).toContain('command openclaw "$@"');
  });
});

describe("nemoclaw-start configure guard blocks config set/unset (#1973)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("adds a config) case that matches only set and unset subcommands", () => {
    expect(src).toMatch(/config\)\s+case "\$2" in\s+set \| unset\)/);
  });

  it("prints an actionable error quoting the invoked subcommand and returns 1", () => {
    expect(src).toContain("'openclaw config $2' cannot modify config inside the sandbox");
    expect(src).toMatch(/set \| unset\)[\s\S]*?return 1/);
  });

  it("redirects users to nemoclaw onboard --resume", () => {
    expect(src).toMatch(/set \| unset\)[\s\S]*?nemoclaw onboard --resume/);
  });

  it("does not block immutable subcommands (get, list) — they fall through to the real binary", () => {
    // The config) arm only enumerates mutating subcommands. Read-only ones are
    // not matched, so execution falls through to `command openclaw "$@"` below.
    expect(src).not.toMatch(/config\)\s+case "\$2" in[\s\S]*?\b(get|list|show|view)\)/);
    expect(src).toContain('command openclaw "$@"');
  });
});

describe("nemoclaw-start configure guard blocks channels mutators (#2097)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("adds a channels) case that allows read-only subcommands through", () => {
    expect(src).toMatch(/channels\)\s+case "\$2" in\s+list \| "" \| -h \| --help\)/);
  });

  it("blocks mutating channels subcommands with an actionable error and return 1", () => {
    expect(src).toContain("'openclaw channels $2' cannot modify channels inside the sandbox");
    expect(src).toMatch(/channels\)[\s\S]*?\*\)[\s\S]*?return 1/);
  });

  it("redirects users to the host-side channels commands", () => {
    expect(src).toMatch(/channels\)[\s\S]*?nemoclaw <sandbox> channels add/);
    expect(src).toMatch(/channels\)[\s\S]*?nemoclaw <sandbox> channels remove/);
  });
});

describe("runtime model override (#759)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("defines apply_model_override function", () => {
    expect(src).toContain("apply_model_override()");
    expect(src).toContain("NEMOCLAW_MODEL_OVERRIDE");
  });

  it("calls apply_model_override after verify_config_integrity in both paths", () => {
    // Non-root path: extract from uid check to the Root path comment
    const nonRootBlock = src.match(/if \[ "\$\(id -u\)" -ne 0 \]; then([\s\S]*?)# ── Root path/);
    expect(nonRootBlock).toBeTruthy();
    expect(nonRootBlock[1]).toMatch(
      /verify_config_integrity[\s\S]*?apply_model_override[\s\S]*?export_gateway_token/,
    );

    // Root path: verify_config_integrity → apply_model_override → apply_cors_override
    const rootBlock = src.match(
      /# ── Root path[\s\S]*?verify_config_integrity[\s\S]*?apply_model_override[\s\S]*?apply_cors_override[\s\S]*?export_gateway_token/,
    );
    expect(rootBlock).toBeTruthy();
  });

  it("recomputes config hash after override", () => {
    const fn = src.match(/apply_model_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("sha256sum openclaw.json");
    expect(fn[1]).toContain("config-hash");
  });

  it("is a no-op when no override env vars are set", () => {
    const fn = src.match(/apply_model_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    // Guard checks all override env vars before returning early
    expect(fn[1]).toContain("NEMOCLAW_MODEL_OVERRIDE");
    // shfmt may format `|| return 0` as a standalone `return 0` on its own line
    expect(fn[1]).toMatch(/\|\|\s*return 0|^\s*return 0/m);
  });

  it("supports optional NEMOCLAW_INFERENCE_API_OVERRIDE for cross-provider switches", () => {
    expect(src).toContain("NEMOCLAW_INFERENCE_API_OVERRIDE");
  });

  it("guards against symlink attacks on config and hash files", () => {
    const fn = src.match(/apply_model_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain('-L "$config_file"');
    expect(fn[1]).toContain('-L "$hash_file"');
    expect(fn[1]).toContain("Refusing model override");
  });

  it("only applies override in root mode", () => {
    const fn = src.match(/apply_model_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toMatch(/id -u.*-ne 0/);
    expect(fn[1]).toContain("requires root");
  });

  it("validates inference API override against allowlist", () => {
    const fn = src.match(/apply_model_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("openai-completions");
    expect(fn[1]).toContain("anthropic-messages");
  });

  it("rejects model override with control characters", () => {
    const fn = src.match(/apply_model_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("control characters");
  });

  it("supports NEMOCLAW_CONTEXT_WINDOW override", () => {
    const fn = src.match(/apply_model_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("NEMOCLAW_CONTEXT_WINDOW");
    expect(fn[1]).toContain("contextWindow");
  });

  it("supports NEMOCLAW_MAX_TOKENS override", () => {
    const fn = src.match(/apply_model_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("NEMOCLAW_MAX_TOKENS");
    expect(fn[1]).toContain("maxTokens");
  });

  it("supports NEMOCLAW_REASONING override", () => {
    const fn = src.match(/apply_model_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("NEMOCLAW_REASONING");
    expect(fn[1]).toContain("reasoning");
  });

  it("validates NEMOCLAW_CONTEXT_WINDOW is a positive integer", () => {
    const fn = src.match(/apply_model_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("NEMOCLAW_CONTEXT_WINDOW must be a positive integer");
  });

  it("validates NEMOCLAW_MAX_TOKENS is a positive integer", () => {
    const fn = src.match(/apply_model_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("NEMOCLAW_MAX_TOKENS must be a positive integer");
  });

  it("validates NEMOCLAW_REASONING is true or false", () => {
    const fn = src.match(/apply_model_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain('NEMOCLAW_REASONING must be "true" or "false"');
  });

  it("triggers on any override env var, not just MODEL_OVERRIDE", () => {
    const fn = src.match(/apply_model_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    // The guard should check all five env vars
    const guard = fn[1].split("return 0")[0];
    expect(guard).toContain("NEMOCLAW_MODEL_OVERRIDE");
    expect(guard).toContain("NEMOCLAW_INFERENCE_API_OVERRIDE");
    expect(guard).toContain("NEMOCLAW_CONTEXT_WINDOW");
    expect(guard).toContain("NEMOCLAW_MAX_TOKENS");
    expect(guard).toContain("NEMOCLAW_REASONING");
  });
});

describe("runtime CORS origin override (#719)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("defines apply_cors_override function", () => {
    expect(src).toContain("apply_cors_override()");
    expect(src).toContain("NEMOCLAW_CORS_ORIGIN");
  });

  it("calls apply_cors_override after apply_model_override in both paths", () => {
    const nonRootBlock = src.match(/if \[ "\$\(id -u\)" -ne 0 \]; then([\s\S]*?)# ── Root path/);
    expect(nonRootBlock).toBeTruthy();
    expect(nonRootBlock[1]).toMatch(
      /apply_model_override[\s\S]*?apply_cors_override[\s\S]*?apply_slack_token_override[\s\S]*?export_gateway_token/,
    );

    const rootBlock = src.match(
      /# ── Root path[\s\S]*?apply_model_override\n\s*apply_cors_override\n\s*apply_slack_token_override\n\s*export_gateway_token/,
    );
    expect(rootBlock).toBeTruthy();
  });

  it("recomputes config hash after override", () => {
    const fn = src.match(/apply_cors_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("sha256sum openclaw.json");
    expect(fn[1]).toContain("config-hash");
  });

  it("is a no-op when NEMOCLAW_CORS_ORIGIN is not set", () => {
    const fn = src.match(/apply_cors_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toMatch(/\[ -n "\$\{NEMOCLAW_CORS_ORIGIN:-\}" \] \|\| return 0/);
  });

  it("validates origin starts with http:// or https://", () => {
    const fn = src.match(/apply_cors_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("^https?://");
  });

  it("guards against symlink attacks", () => {
    const fn = src.match(/apply_cors_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain('-L "$config_file"');
    expect(fn[1]).toContain("Refusing CORS override");
  });

  it("only applies override in root mode", () => {
    const fn = src.match(/apply_cors_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toMatch(/id -u.*-ne 0/);
    expect(fn[1]).toContain("requires root");
  });

  it("rejects origin with control characters", () => {
    const fn = src.match(/apply_cors_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("control characters");
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

  it("uses shared cleanup_on_signal from sandbox-init.sh", () => {
    // cleanup_on_signal is provided by sandbox-init.sh; the entrypoint
    // must NOT define its own cleanup() — it uses the shared version.
    const localCleanup = src.match(/^cleanup\(\)/gm);
    expect(localCleanup).toBeNull();
    // Must reference cleanup_on_signal in trap registrations
    expect(src).toContain("trap cleanup_on_signal SIGTERM SIGINT");
  });

  it("sets SANDBOX_CHILD_PIDS and SANDBOX_WAIT_PID before trap in non-root path", () => {
    const nonRootBlock = src.match(/if \[ "\$\(id -u\)" -ne 0 \]; then[\s\S]*?# ── Root path/)?.[0];
    expect(nonRootBlock).toBeDefined();
    expect(nonRootBlock).toContain("SANDBOX_CHILD_PIDS=");
    expect(nonRootBlock).toContain("SANDBOX_WAIT_PID=");
    const pidsIdx = nonRootBlock.indexOf("SANDBOX_CHILD_PIDS=");
    const waitIdx = nonRootBlock.indexOf("SANDBOX_WAIT_PID=");
    const trapIdx = nonRootBlock.indexOf("trap cleanup_on_signal");
    expect(waitIdx).toBeGreaterThan(-1);
    expect(pidsIdx).toBeLessThan(trapIdx);
    expect(waitIdx).toBeLessThan(trapIdx);
  });

  it("sets SANDBOX_CHILD_PIDS and SANDBOX_WAIT_PID before trap in root path", () => {
    const rootBlock = src.split(/# ── Root path/)[1] || "";
    expect(rootBlock).toContain("SANDBOX_CHILD_PIDS=");
    expect(rootBlock).toContain("SANDBOX_WAIT_PID=");
    const pidsIdx = rootBlock.indexOf("SANDBOX_CHILD_PIDS=");
    const waitIdx = rootBlock.indexOf("SANDBOX_WAIT_PID=");
    const trapIdx = rootBlock.indexOf("trap cleanup_on_signal");
    expect(waitIdx).toBeGreaterThan(-1);
    expect(pidsIdx).toBeLessThan(trapIdx);
    expect(waitIdx).toBeLessThan(trapIdx);
  });

  it("captures AUTO_PAIR_PID from background process", () => {
    expect(src).toMatch(/AUTO_PAIR_PID=\$!/);
  });
});

describe("nemoclaw-start CHAT_UI_URL override for configurable dashboard port (#1925)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("unconditionally sets CHAT_UI_URL when NEMOCLAW_DASHBOARD_PORT is injected", () => {
    // When the var is present (injected via envArgs in onboard.ts), the gateway
    // must use the configured port even if the Docker image has a different
    // CHAT_UI_URL baked in as a Docker ENV directive.
    const overrideBlock = src.match(
      /if \[ -n "\$\{NEMOCLAW_DASHBOARD_PORT:-\}" \]; then([\s\S]*?)else/,
    );
    expect(overrideBlock).toBeTruthy();
    // Plain assignment — the Docker ENV value cannot take precedence
    expect(overrideBlock[1]).toContain('CHAT_UI_URL="http://127.0.0.1:${_DASHBOARD_PORT}"');
    // Must NOT use :- in this branch — that would let the baked-in Docker ENV win
    // and restart the gateway on the wrong port (#1925)
    expect(overrideBlock[1]).not.toMatch(/CHAT_UI_URL=.*:-/);
  });

  it("falls back to baked-in CHAT_UI_URL when NEMOCLAW_DASHBOARD_PORT is absent", () => {
    // When no port override was injected (default install), honour whatever
    // CHAT_UI_URL was baked into the Docker image at onboard time.
    const ifElseBlock = src.match(
      /if \[ -n "\$\{NEMOCLAW_DASHBOARD_PORT:-\}" \]; then[\s\S]*?else([\s\S]*?)fi/,
    );
    expect(ifElseBlock).toBeTruthy();
    expect(ifElseBlock[1]).toContain(
      'CHAT_UI_URL="${CHAT_UI_URL:-http://127.0.0.1:${_DASHBOARD_PORT}}"',
    );
  });

  it("passes --port to openclaw gateway run in root path (gosu gateway) (#1925)", () => {
    // The root path (run as root, then gosu'd to the gateway user) must also
    // pass --port so the gateway binds to the configured port. Without this,
    // a user with NEMOCLAW_DASHBOARD_PORT set would get a gateway on 18789
    // even though the SSH tunnel forwards the custom port.
    const rootBlock = src.split(/# ── Root path/)[1] || "";
    expect(rootBlock).toMatch(
      /nohup gosu gateway "\$OPENCLAW" gateway run --port "\$\{_DASHBOARD_PORT\}" >\/tmp\/gateway\.log 2>&1 &/,
    );
  });
});
