// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

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

function startScriptHeredoc(src: string, marker: string): string {
  const match = src.match(new RegExp(`<<'${marker}'\\n([\\s\\S]*?)\\n${marker}`));
  expect(match).toBeTruthy();
  return match![1];
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

describe("nemoclaw-start non-root fallback", () => {
  it("detaches gateway output from sandbox create in non-root mode", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");

    expect(src).toMatch(/if \[ "\$\(id -u\)" -ne 0 \]; then/);
    expect(src).toMatch(/touch \/tmp\/gateway\.log/);
    expect(src).toMatch(
      /nohup "\$OPENCLAW" gateway run --port "\$\{_DASHBOARD_PORT\}" >\/tmp\/gateway\.log 2>&1 &/,
    );
  });

  it("exits on locked config integrity failure in non-root mode", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");

    const nonRootBlock = src.match(/if \[ "\$\(id -u\)" -ne 0 \]; then([\s\S]*?)# ── Root path/);
    expect(nonRootBlock).toBeTruthy();
    // Non-root block must call the locked-aware verifier and exit 1 on failure.
    expect(nonRootBlock[1]).toMatch(/if ! verify_config_integrity_if_locked\b.*; then\s+.*exit 1/s);
    // Must not contain the old "proceeding anyway" fallback
    expect(src).not.toMatch(/proceeding anyway/i);
  });

  it("calls verify_config_integrity_if_locked in both root and non-root paths", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");

    // The function must be called at least twice: once in the non-root
    // if-block and once in the root path below it.
    const calls = src.match(/verify_config_integrity_if_locked/g) || [];
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

  it("repairs ownership for all writable OpenClaw state directories in non-root mode", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const fn = src.match(/fix_openclaw_ownership\(\) \{([\s\S]*?)^\s*\}/m);
    expect(fn).toBeTruthy();
    for (const dir of ["workspace", "memory", "credentials", "flows", "telegram", "media"]) {
      expect(fn![1]).toContain(dir);
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

describe("nemoclaw-start _SANDBOX_HOME variable (#1609)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("defines _SANDBOX_HOME before first use", () => {
    const defPos = src.indexOf('_SANDBOX_HOME="/sandbox"');
    expect(defPos).toBeGreaterThan(-1);

    // All usages must come after the definition
    const usages = [...src.matchAll(/\$\{?_SANDBOX_HOME\}?/g)];
    expect(usages.length).toBeGreaterThanOrEqual(2);
    for (const m of usages) {
      // Skip the definition line itself
      if (m.index === defPos) continue;
      expect(m.index).toBeGreaterThan(defPos);
    }
  });

  it("does not rewrite rc files while exporting the gateway token", () => {
    const exportFn = src.match(/export_gateway_token\(\) \{([\s\S]*?)^\}/m);
    expect(exportFn).toBeTruthy();
    expect(exportFn[1]).not.toContain("${_SANDBOX_HOME}/.bashrc");
    expect(exportFn[1]).not.toContain("${_SANDBOX_HOME}/.profile");
    expect(exportFn[1]).not.toContain("rewrite_rc_marker_block");
  });

  it("keeps dynamic shell state in the sourced runtime env file", () => {
    const runtimeBlock = runtimeShellEnvBlock(src);
    expect(runtimeBlock).toContain("/tmp/nemoclaw-proxy-env.sh");
    expect(runtimeBlock).toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(runtimeBlock).toContain("nemoclaw-configure-guard begin");
    expect(runtimeBlock).not.toContain("${_SANDBOX_HOME}/.bashrc");
    expect(runtimeBlock).not.toContain("${_SANDBOX_HOME}/.profile");
  });

  it("backfills the runtime env shim into stale rc files before locking them", () => {
    const shimBlock = runtimeShellEnvShimBlock(src);
    expect(src).toContain(
      '_RUNTIME_SHELL_ENV_SHIM="[ -f ${_RUNTIME_SHELL_ENV_FILE} ] && . ${_RUNTIME_SHELL_ENV_FILE}"',
    );
    expect(shimBlock).toContain('"${_SANDBOX_HOME}/.bashrc" "${_SANDBOX_HOME}/.profile"');
    expect(shimBlock).toContain('grep -qxF "$_RUNTIME_SHELL_ENV_SHIM" "$rc_file"');
    expect(shimBlock).toContain('chown root:root "$rc_file"');
    expect(shimBlock).toContain("printf '\\n%s\\n%s\\n'");

    for (const block of [
      src.match(/if \[ "\$\(id -u\)" -ne 0 \]; then([\s\S]*?)# ── Root path/)?.[1],
      src.slice(src.indexOf("# ── Root path")),
    ]) {
      expect(block).toBeTruthy();
      const writePos = block!.indexOf("write_runtime_shell_env");
      const ensurePos = block!.indexOf("ensure_runtime_shell_env_shim");
      const lockPos = block!.indexOf('lock_rc_files "$_SANDBOX_HOME"');
      expect(writePos).toBeGreaterThan(-1);
      expect(ensurePos).toBeGreaterThan(writePos);
      expect(lockPos).toBeGreaterThan(ensurePos);
    }
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

  it("shell-escapes the token before embedding it in proxy-env.sh", () => {
    const runtimeBlock = runtimeShellEnvBlock(src);
    expect(runtimeBlock).toContain("_escaped_gateway_token");
    expect(runtimeBlock).toContain("sed \"s/'/'\\\\\\\\''/g\"");
    expect(runtimeBlock).toMatch(/export OPENCLAW_GATEWAY_TOKEN='%s'/);
  });

  it("does not mutate .bashrc or .profile for token propagation", () => {
    expect(src).not.toContain("rewrite_rc_marker_block");
    expect(src).not.toContain(".bashrc.tmp");
    expect(src).not.toContain("nemoclaw-gateway-token begin");
  });

  it("calls export_gateway_token in both root and non-root paths", () => {
    const calls = src.match(/export_gateway_token/g) || [];
    // definition + 2 call sites
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe("nemoclaw-start configure guard (#1114)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("emits configure guard through proxy-env.sh", () => {
    const runtimeBlock = runtimeShellEnvBlock(src);
    expect(runtimeBlock).toContain("nemoclaw-configure-guard begin");
    expect(runtimeBlock).toContain("emit_sandbox_sourced_file");
  });

  it("intercepts openclaw configure with an actionable error", () => {
    const body = configureGuardBlock(src);
    expect(body).toContain("configure)");
    expect(body).toContain("nemoclaw onboard --resume");
    expect(body).toContain("return 1");
  });

  it("passes non-configure subcommands through to the real binary", () => {
    expect(configureGuardBlock(src)).toContain('command openclaw "$@"');
  });

  it("keeps marker comments while relying on proxy-env replacement for idempotence", () => {
    const body = configureGuardBlock(src);
    expect(body).toContain("nemoclaw-configure-guard begin");
    expect(body).toContain("nemoclaw-configure-guard end");
    expect(runtimeShellEnvBlock(src)).toContain('emit_sandbox_sourced_file "$_PROXY_ENV_FILE"');
  });

  it("writes runtime shell env in both root and non-root paths", () => {
    const calls = src.match(/write_runtime_shell_env/g) || [];
    // definition + 2 call sites
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("does not write configure guard into rc files", () => {
    const runtimeBlock = runtimeShellEnvBlock(src);
    expect(runtimeBlock).not.toContain('>"$rc_file"');
    expect(runtimeBlock).not.toContain('>>"$rc_file"');
    expect(src).not.toContain("install_configure_guard");
  });
});

describe("nemoclaw-start configure guard blocks --local (#2016)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("blocks openclaw agent --local with a hard error and return 1", () => {
    const body = configureGuardBlock(src);
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
    expect(configureGuardBlock(src)).toContain("openclaw agent --agent main");
  });

  it("allows openclaw agent without --local to pass through", () => {
    const body = configureGuardBlock(src);
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

describe("nemoclaw-start persistent gateway log hardening", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("creates a regular root-owned persistent log before root append", () => {
    const helperFn = src.match(/start_persistent_gateway_log_mirror\(\) \{([\s\S]*?)^}/m);
    expect(helperFn).toBeTruthy();
    expect(helperFn![1]).toContain('[ -L "$log_dir" ]');
    expect(helperFn![1]).toContain('[ -L "$log_file" ]');
    expect(helperFn![1]).toContain("install -d -o root -g root -m 755");
    expect(helperFn![1]).toContain("install -o root -g root -m 644 /dev/null");
    expect(helperFn![1]).toContain('>>"$log_file"');
  });

  it("uses the persistent log helper in root and non-root paths", () => {
    const calls = src.match(/start_persistent_gateway_log_mirror \|\| exit 1/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(src).not.toContain("chown gateway:gateway /sandbox/.openclaw/logs");
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

  it("calls apply_model_override after locked-aware integrity check in both paths", () => {
    // Non-root path: extract from uid check to the Root path comment
    const nonRootBlock = src.match(/if \[ "\$\(id -u\)" -ne 0 \]; then([\s\S]*?)# ── Root path/);
    expect(nonRootBlock).toBeTruthy();
    expect(nonRootBlock[1]).toMatch(
      /verify_config_integrity_if_locked[\s\S]*?apply_model_override[\s\S]*?export_gateway_token/,
    );

    // Root path: locked-aware integrity check → apply_model_override → apply_cors_override
    const rootBlock = src.match(
      /# ── Root path[\s\S]*?verify_config_integrity_if_locked[\s\S]*?apply_model_override[\s\S]*?apply_cors_override[\s\S]*?export_gateway_token/,
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

  it("triggers only on explicit override env vars (MODEL_OVERRIDE or INFERENCE_API_OVERRIDE)", () => {
    const fn = src.match(/apply_model_override\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    // The guard should only check the two explicit override env vars (#2653).
    // NEMOCLAW_CONTEXT_WINDOW, NEMOCLAW_MAX_TOKENS, and NEMOCLAW_REASONING are
    // promoted from Dockerfile ARGs to ENV and always set — they should only
    // take effect alongside an explicit model or API override.
    const guard = fn[1].split("return 0")[0];
    expect(guard).toContain("NEMOCLAW_MODEL_OVERRIDE");
    expect(guard).toContain("NEMOCLAW_INFERENCE_API_OVERRIDE");
    expect(guard).not.toMatch(
      /\[\s*-n\s*"\$\{NEMOCLAW_CONTEXT_WINDOW:-\}"/,
    );
    expect(guard).not.toMatch(
      /\[\s*-n\s*"\$\{NEMOCLAW_MAX_TOKENS:-\}"/,
    );
    expect(guard).not.toMatch(
      /\[\s*-n\s*"\$\{NEMOCLAW_REASONING:-\}"/,
    );
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
      /apply_model_override[\s\S]*?apply_cors_override[\s\S]*?export_gateway_token/,
    );

    const rootBlock = src.match(
      /# ── Root path[\s\S]*?apply_model_override[\s\S]*?apply_cors_override[\s\S]*?export_gateway_token/,
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

describe("Slack channel guard — unhandled-rejection safety net (#2340)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const extractGuardScript = () => {
    const match = src.match(/<<'SLACK_GUARD_EOF'\n([\s\S]*?)\nSLACK_GUARD_EOF/);
    expect(match).toBeTruthy();
    return match[1];
  };

  it("defines install_slack_channel_guard function", () => {
    expect(src).toMatch(/install_slack_channel_guard\(\) \{/);
  });

  it("calls install_slack_channel_guard after configure_messaging_channels in both paths", () => {
    const nonRootBlock = src.match(
      /if \[ "\$\(id -u\)" -ne 0 \]; then([\s\S]*?)# ── Root path/,
    );
    expect(nonRootBlock).toBeTruthy();
    expect(nonRootBlock[1]).toMatch(
      /configure_messaging_channels[\s\S]*?install_slack_channel_guard/,
    );

    const rootBlock = src.match(
      /# ── Root path[\s\S]*?configure_messaging_channels[\s\S]*?install_slack_channel_guard/,
    );
    expect(rootBlock).toBeTruthy();
  });

  it("is a no-op when no Slack channel is configured", () => {
    const fn = src.match(/install_slack_channel_guard\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain('grep -q \'"slack"\'');
    expect(fn[1]).toContain("return 0");
  });

  it("installs a Node.js preload script via NODE_OPTIONS", () => {
    expect(src).toContain('export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require $_SLACK_GUARD_SCRIPT"');
  });

  it("catches unhandled promise rejections from Slack", () => {
    const fn = src.match(/install_slack_channel_guard\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("unhandledRejection");
    expect(fn[1]).toContain("isSlackRejection");
  });

  it("catches uncaught exceptions from Slack (sync throws)", () => {
    const fn = src.match(/install_slack_channel_guard\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("uncaughtException");
  });

  it("passes non-Slack failures through to later process handlers", () => {
    const fn = src.match(/install_slack_channel_guard\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("origEmit.apply");

    const run = spawnSync(
      process.execPath,
      [
        "-e",
        `${extractGuardScript()}
process.on('unhandledRejection', function () {
  console.log('downstream');
  process.exit(42);
});
process.emit('unhandledRejection', new Error('plain failure'), {});
`,
      ],
      { encoding: "utf-8" },
    );
    expect(run.status).toBe(42);
    expect(run.stdout).toContain("downstream");
  });

  it("consumes Slack auth rejections before later fatal handlers see them", () => {
    const run = spawnSync(
      process.execPath,
      [
        "-e",
        `${extractGuardScript()}
let downstreamCalled = false;
process.on('unhandledRejection', function () {
  downstreamCalled = true;
  process.exit(42);
});
process.emit('unhandledRejection', new Error('An API error occurred: invalid_auth'), {});
setImmediate(function () {
  console.log('downstream=' + downstreamCalled);
});
`,
      ],
      { encoding: "utf-8" },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("downstream=false");
    expect(run.stderr).toContain("provider failed to start");
  });

  it("detects Slack errors by error code, message, stack trace, and domain", () => {
    const fn = src.match(/install_slack_channel_guard\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("slack_webapi_platform_error");
    expect(fn[1]).toContain("invalid_auth");
    expect(fn[1]).toContain("token_revoked");
    expect(fn[1]).toContain("@slack/");
    // Proxy/network errors targeting Slack domains (CONNECT tunnel failures)
    expect(fn[1]).toMatch(/msg\.indexOf\('slack\.com'\)\s*!==\s*-1/);
  });

  it("logs caught Slack errors as warnings instead of crashing", () => {
    const fn = src.match(/install_slack_channel_guard\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("provider failed to start");
    expect(fn[1]).toContain("caught by safety net, gateway continues");
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

// -------------------------------------------------------------------
// NC-2227-01: Legacy migration guards
// -------------------------------------------------------------------
describe("NC-2227-01: legacy migration guards", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("uses a migration-complete sentinel to prevent re-running migration", () => {
    const fn = src.match(/migrate_legacy_layout\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain(".migration-complete");
    expect(fn[1]).toContain("sentinel");
  });

  it("requires root to run migration", () => {
    const fn = src.match(/migrate_legacy_layout\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("id -u");
    expect(fn[1]).toContain("migration skipped");
    expect(fn[1]).toContain("requires root");
  });

  it("rejects sandbox-owned data directories without a legacy symlink bridge", () => {
    const fn = src.match(/migrate_legacy_layout\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("data_owner");
    expect(fn[1]).toContain("sandbox-owned");
    expect(fn[1]).toContain("legacy symlink bridge");
    expect(fn[1]).toContain("possible agent-planted trigger");
  });

  it("repairs trusted-sentinel sandboxes when legacy artifacts remain", () => {
    const fn = src.match(/migrate_legacy_layout\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("trusted sentinel exists but legacy artifacts remain; repairing");
    expect(fn[1]).toContain("legacy_symlinks_exist");
    expect(fn[1]).toContain("assert_no_legacy_layout");
  });

  it("fails entrypoint startup if legacy migration cannot complete", () => {
    expect(src).toContain(
      'migrate_legacy_layout "/sandbox/.openclaw" "/sandbox/.openclaw-data" "openclaw" || exit 1',
    );
  });

  it("rejects symlinked config dirs, legacy data dirs, and entries before root copy", () => {
    const fn = src.match(/migrate_legacy_layout\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain('[ -L "$config_dir" ]');
    expect(fn[1]).toContain('[ -L "$data_dir" ]');
    expect(fn[1]).toContain('[ -L "$entry" ]');
    expect(fn[1]).toContain("refusing migration");
  });

  it("checks immutable bits before touching legacy migration artifacts", () => {
    const fn = src.match(/migrate_legacy_layout\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(src).toContain("path_has_immutable_bit");
    expect(src).toContain("ensure_mutable_for_migration");
    for (const target of ["$sentinel", "$config_dir", "$data_dir", "$target"]) {
      expect(fn![1]).toContain(`ensure_mutable_for_migration "${target}"`);
    }
    expect(fn![1]).toContain('elif [ -d "$target" ] && [ -d "$entry" ]; then');
  });

  it("uses a sandbox placeholder in shields-down recovery hints", () => {
    expect(src).toContain("nemoclaw <sandbox> shields down");
    expect(src).not.toContain("nemoclaw ${label} shields down");
  });

  it("does not chown -R the config directory itself", () => {
    const fn = src.match(/migrate_legacy_layout\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    // The old pattern chown -R sandbox:sandbox "$config_dir" must NOT exist
    expect(fn[1]).not.toMatch(/chown -R sandbox:sandbox "\$config_dir"\s/);
    // Only subdirectories should be chowned
    expect(fn[1]).toContain('[ -d "$entry" ] || continue');
  });

  it("checks hidden config symlinks when validating legacy layout", () => {
    const existsFn = src.match(/legacy_symlinks_exist\(\) \{([\s\S]*?)^}/m);
    const assertFn = src.match(/assert_no_legacy_layout\(\) \{([\s\S]*?)^}/m);
    expect(existsFn).toBeTruthy();
    expect(assertFn).toBeTruthy();
    for (const fn of [existsFn![1], assertFn![1]]) {
      expect(fn).toContain('"$config_dir"/.[!.]*');
      expect(fn).toContain('"$config_dir"/..?*');
      expect(fn).toContain('"$config_dir"/*');
    }
  });

  it("uses non-dereferencing ownership repair for migrated state trees", () => {
    const fn = src.match(/migrate_legacy_layout\(\) \{([\s\S]*?)^}/m);
    const provisionFn = src.match(/provision_agent_workspaces\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(provisionFn).toBeTruthy();
    expect(src).toContain("chown_tree_no_symlink_follow");
    expect(fn![1]).toContain("chown_tree_no_symlink_follow sandbox:sandbox");
    expect(fn![1]).toContain("chown_tree_no_symlink_follow root:root");
    expect(fn![1]).not.toContain('chown -R sandbox:sandbox "$entry"');
    expect(fn![1]).not.toContain('chown -R root:root "$config_dir/$subdir"');
    expect(provisionFn![1]).toContain('chown_tree_no_symlink_follow sandbox:sandbox "$ws_path"');
    expect(provisionFn![1]).not.toContain('chown -R sandbox:sandbox "$ws_path"');
  });

  it("reapplies shields-up ownership if shields were previously active", () => {
    const fn = src.match(/migrate_legacy_layout\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("shields_were_active");
    expect(fn[1]).toContain("Reapplying shields-up ownership");
    expect(src).toContain("restore_immutable_if_possible");
    expect(fn[1]).toContain("restore_immutable_if_possible");
    expect(fn[1]).toContain('"$config_dir"/openclaw.json');
    expect(fn[1]).toContain('"$config_dir"/.config-hash');
    expect(fn[1]).toContain('"$config_dir"/.env');
    expect(fn[1]).toContain('"$config_dir"');
    for (const dir of ["skills", "hooks", "cron", "agents", "extensions", "plugins"]) {
      expect(fn[1]).toContain(dir);
    }
    expect(fn[1]).toContain("chmod -R go-w");
  });

  it("writes a root-owned read-only sentinel after successful migration", () => {
    const fn = src.match(/migrate_legacy_layout\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    // Sentinel must be root-owned and 444
    expect(fn[1]).toMatch(/chown root:root "\$sentinel"/);
    expect(fn[1]).toMatch(/chmod 444 "\$sentinel"/);
  });

  it("only provisions canonical workspace-* paths from config", () => {
    const fn = src.match(/provision_agent_workspaces\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain("workspacePattern");
    expect(fn[1]).toContain("workspacePattern.test(relative)");
    expect(fn[1]).toContain("workspacePattern.test(name)");
    expect(fn[1]).toContain('[ -L "$d" ]');
    expect(fn[1]).toContain('[ -L "$ws_path" ]');
  });

  it("migrates hidden legacy entries before removing the legacy data dir", () => {
    const fn = src.match(/migrate_legacy_layout\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    expect(fn[1]).toContain('"$data_dir"/.[!.]*');
    expect(fn[1]).toContain('"$data_dir"/..?*');
  });
});

describe("Slack token rewriter (#2085)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("legacy apply_slack_token_override carve-out is fully removed", () => {
    // The previous implementation mutated openclaw.json at startup to splice
    // the real Slack token into the config. Replaced by the rewriter preload —
    // this assertion guards against accidental re-introduction.
    expect(src).not.toContain("apply_slack_token_override");
  });

  it("defines _SLACK_REWRITER_SCRIPT and install_slack_token_rewriter", () => {
    expect(src).toContain('_SLACK_REWRITER_SCRIPT="/tmp/nemoclaw-slack-token-rewriter.js"');
    expect(src).toContain("install_slack_token_rewriter()");
  });

  it("install_slack_token_rewriter exports NODE_OPTIONS pointing at the rewriter path", () => {
    // Function-body extraction can't easily skip past the embedded heredoc,
    // so just assert the file contains the export line. The byte-identity
    // sync test catches any drift in the heredoc body.
    expect(src).toMatch(
      /export NODE_OPTIONS="\$\{NODE_OPTIONS:\+\$NODE_OPTIONS \}--require \$_SLACK_REWRITER_SCRIPT"/,
    );
  });

  it("install_slack_token_rewriter is a no-op when no Slack placeholder is present", () => {
    // The trigger must be the placeholder token, not just the channel name —
    // otherwise the rewriter installs on configs that have already been
    // mutated to a real token, which would mask regressions.
    expect(src).toContain('grep -q \'OPENSHELL-RESOLVE-ENV-SLACK_\'');
  });

  it("calls install_slack_token_rewriter and verify_no_slack_secrets_on_disk in both paths", () => {
    const nonRootBlock = src.match(/if \[ "\$\(id -u\)" -ne 0 \]; then([\s\S]*?)# ── Root path/);
    expect(nonRootBlock).toBeTruthy();
    expect(nonRootBlock[1]).toMatch(
      /configure_messaging_channels[\s\S]*?install_slack_token_rewriter[\s\S]*?install_slack_channel_guard[\s\S]*?verify_no_slack_secrets_on_disk/,
    );
    const rootBlock = src.split(/# ── Root path/)[1] || "";
    expect(rootBlock).toMatch(
      /configure_messaging_channels[\s\S]*?install_slack_token_rewriter[\s\S]*?install_slack_channel_guard[\s\S]*?verify_no_slack_secrets_on_disk/,
    );
  });

  it("validate_tmp_permissions includes the rewriter path in both branches", () => {
    const calls =
      src.match(/validate_tmp_permissions\s+.*"\$_SLACK_REWRITER_SCRIPT"/g) || [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("connect-shell rc export sources the rewriter when present", () => {
    // The export is emitted from inside an outer `echo "..."` so the inner
    // double quotes appear escaped (\"). Match accordingly.
    expect(src).toMatch(
      /\[ -f \\"\$_SLACK_REWRITER_SCRIPT\\" \].*--require \$_SLACK_REWRITER_SCRIPT/,
    );
  });

  it("verify_no_slack_secrets_on_disk refuses to serve on real-token leak", () => {
    const fn = src.match(/verify_no_slack_secrets_on_disk\(\) \{([\s\S]*?)^}/m);
    expect(fn).toBeTruthy();
    // Negative lookahead: matches xoxb-/xapp- only when NOT followed by the
    // placeholder marker. exit 78 is EX_CONFIG (sysexits.h).
    expect(fn[1]).toContain("OPENSHELL-RESOLVE-ENV-");
    expect(fn[1]).toMatch(/xoxb.*xapp/);
    expect(fn[1]).toContain("exit 78");

    const python = fn[1].match(
      /python3 - "\$config" <<'PYSLACKSECRET'(?:; then)?\n([\s\S]*?)\nPYSLACKSECRET/,
    );
    expect(python).toBeTruthy();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-secret-"));
    const run = (input: string) => {
      const config = path.join(tmpDir, "openclaw.json");
      fs.writeFileSync(config, input);
      return spawnSync("python3", ["-c", python[1], config], { encoding: "utf-8" }).status;
    };

    expect(run('{"botToken":"xoxb-real-token"}\n')).toBe(0);
    expect(run('{"botToken":"prefixxoxb-real-token"}\n')).toBe(0);
    expect(run('{"appToken":"xapp-real-token"}\n')).toBe(0);
    expect(run('{"botToken":"xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN"}\n')).toBe(1);
    expect(run('{"token":"openshell:resolve:env:SLACK_BOT_TOKEN"}\n')).toBe(1);
  });
});
