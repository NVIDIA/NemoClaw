// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavioral regression coverage for #7795.
 *
 * The in-sandbox hints that print a copyable host-side `nemoclaw <name> …`
 * command resolved the sandbox name from `OPENSHELL_SANDBOX` at render time.
 * OpenShell records the name on the container, but exports the variable as the
 * boolean "1" to every process it spawns inside the sandbox — the entrypoint and
 * the `connect` shell included — and keeps the real value only in its own
 * root-owned PID 1 environment, which the unprivileged entrypoint cannot read.
 * So the name was unavailable in-sandbox and every hint fell back to the literal
 * `<name>` placeholder, leaving the copyable command unusable.
 *
 * The fix injects the host's already-validated sandbox name as
 * `NEMOCLAW_SANDBOX_NAME` for every sandbox at create time (it was previously
 * injected only for LangChain Deep Agents Code), and the entrypoint bakes it
 * into the generated /tmp/nemoclaw-proxy-env.sh as
 * `_NEMOCLAW_SANDBOX_LABEL` for the renderer to fall back to.
 *
 * These tests run the real generator (`write_runtime_shell_env`) under the env
 * the entrypoint actually gets, then source its output in a shell where
 * `OPENSHELL_SANDBOX=1`, reproducing the connect shell exactly, rather than
 * asserting on source text. Both consumers of the label are covered: the
 * `openclaw channels add/remove` guard (#7292/#7295) and the policy-denial logs
 * breadcrumb (#5978).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { NAME_MAX_LENGTH, NAME_VALID_PATTERN } from "../../src/lib/name-validation.js";

const START_SCRIPT = path.resolve(import.meta.dirname, "..", "../scripts/nemoclaw-start.sh");

function runtimeShellEnvBlock(source: string): string {
  const start = source.indexOf("write_runtime_shell_env() {");
  const end = source.indexOf("# cleanup_on_signal", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/**
 * Run the real generator with the host-injected `NEMOCLAW_SANDBOX_NAME` set to
 * `injectedName` and return the generated connect-shell env file. The generator
 * also runs with `OPENSHELL_SANDBOX=1`, which is what OpenShell actually exports
 * to the entrypoint.
 */
function generateConnectEnv(tmpDir: string, injectedName: string | undefined): string {
  const proxyEnv = path.join(tmpDir, "proxy-env.sh");
  const source = fs.readFileSync(START_SCRIPT, "utf8");
  const block = `${runtimeShellEnvBlock(source)}\nwrite_runtime_shell_env`.replaceAll(
    "/tmp/nemoclaw-proxy-env.sh",
    proxyEnv,
  );
  const writer = path.join(tmpDir, "write-env.sh");
  fs.writeFileSync(
    writer,
    [
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
      '_CIAO_GUARD_SCRIPT="/tmp/ciao-guard.js"',
      "emit_messaging_connect_runtime_preload_exports() { :; }",
      "_TOOL_REDIRECTS=()",
      "set +u",
      block,
    ].join("\n"),
    { mode: 0o700 },
  );
  // Drop any inherited value first so `undefined` faithfully models the
  // "host injected no name" case; spread the injected one back in branch-free.
  const hostEnv: NodeJS.ProcessEnv = { ...process.env };
  delete hostEnv.NEMOCLAW_SANDBOX_NAME;
  const env: NodeJS.ProcessEnv = {
    ...hostEnv,
    OPENSHELL_SANDBOX: "1",
    ...(injectedName === undefined ? {} : { NEMOCLAW_SANDBOX_NAME: injectedName }),
  };
  const result = spawnSync("bash", [writer], { encoding: "utf8", timeout: 5_000, env });
  expect(result.status, result.stderr).toBe(0);
  return fs.readFileSync(proxyEnv, "utf8");
}

/**
 * Source the generated env file in a shell that mirrors the connect shell
 * (`OPENSHELL_SANDBOX=1`) and run `snippet`. Returns the merged output.
 */
function inConnectShell(
  tmpDir: string,
  snippet: string,
  extraEnv: NodeJS.ProcessEnv = {},
): { output: string; status: number } {
  const proxyEnv = path.join(tmpDir, "proxy-env.sh");
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-c", `source ${JSON.stringify(proxyEnv)}; ${snippet}`],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        // The exact value `openshell sandbox connect` exports (#7795).
        OPENSHELL_SANDBOX: "1",
        HTTPS_PROXY: "http://127.0.0.1:3128",
        ...extraEnv,
      },
    },
  );
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    status: result.status ?? -1,
  };
}

function withTmpDir<T>(fn: (tmpDir: string) => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-7795-"));
  try {
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("connect-shell sandbox label for host-side hints (#7795)", () => {
  it("names the sandbox in the channels guard hint when the connect shell has OPENSHELL_SANDBOX=1", () => {
    withTmpDir((tmpDir) => {
      generateConnectEnv(tmpDir, "my-assistant");
      const { output, status } = inConnectShell(tmpDir, "openclaw channels add discord");
      expect(status).toBe(1);
      expect(output).toContain("Run 'nemoclaw my-assistant channels add discord' on the host.");
      expect(output).not.toContain("nemoclaw <name> channels");
    });
  });

  it("names the sandbox in the policy-denial logs breadcrumb under the same conditions (#5978)", () => {
    withTmpDir((tmpDir) => {
      generateConnectEnv(tmpDir, "my-assistant");
      const { output } = inConnectShell(tmpDir, "_nemoclaw_policy_denial_hint_text");
      expect(output).toContain("nemoclaw my-assistant logs --tail 50");
      expect(output).not.toContain("nemoclaw <name> logs");
    });
  });

  it("bakes the validated name into the generated connect env", () => {
    withTmpDir((tmpDir) => {
      const envFile = generateConnectEnv(tmpDir, "my-assistant");
      expect(envFile).toContain("export _NEMOCLAW_SANDBOX_LABEL='my-assistant'");
    });
  });

  // Regression lock: the pre-#7795 source must keep priority, so a caller that
  // does carry the name in OPENSHELL_SANDBOX still renders it (#5978, #7295).
  it("still prefers a usable runtime OPENSHELL_SANDBOX over the baked label", () => {
    withTmpDir((tmpDir) => {
      generateConnectEnv(tmpDir, "baked-name");
      const { output } = inConnectShell(tmpDir, "_nemoclaw_policy_denial_hint_text", {
        OPENSHELL_SANDBOX: "runtime-name",
      });
      expect(output).toContain("nemoclaw runtime-name logs --tail 50");
    });
  });

  // With no usable name from either source, keep the placeholder used before
  // #7795.
  it.each([
    "1",
    "true",
    "0",
    "false",
    "",
  ])("falls back to <name> for the unusable injected value %j", (containerValue) => {
    withTmpDir((tmpDir) => {
      const envFile = generateConnectEnv(tmpDir, containerValue);
      expect(envFile).toContain("unset _NEMOCLAW_SANDBOX_LABEL");
      expect(envFile).not.toContain("export _NEMOCLAW_SANDBOX_LABEL");
      const { output } = inConnectShell(tmpDir, "_nemoclaw_policy_denial_hint_text");
      expect(output).toContain("nemoclaw <name> logs --tail 50");
    });
  });

  it("falls back to <name> when the host injected no sandbox name", () => {
    withTmpDir((tmpDir) => {
      const envFile = generateConnectEnv(tmpDir, undefined);
      expect(envFile).toContain("unset _NEMOCLAW_SANDBOX_LABEL");
      const { output } = inConnectShell(tmpDir, "_nemoclaw_policy_denial_hint_text");
      expect(output).toContain("nemoclaw <name> logs --tail 50");
    });
  });

  // The baked value crosses the same trust boundary as the runtime one: it comes
  // from container-level configuration, so the generator allowlists it before it
  // can reach a copyable command.
  it.each([
    ["shell metacharacters", "qa-7795; rm -rf /"],
    ["ANSI escape and newline", "qa\u001b[31m-7795\nINJECTED"],
    ["command substitution", "$(touch /tmp/pwned-7795)"],
    ["uppercase leading", "Qa-7795"],
    ["digit leading", "9abc"],
    ["underscore", "qa_7795"],
    ["trailing hyphen", "qa-7795-"],
    ["consecutive hyphens", "qa--7795"],
  ])("rejects an invalid injected sandbox name (%s) instead of interpolating it", (_label, value) => {
    withTmpDir((tmpDir) => {
      const envFile = generateConnectEnv(tmpDir, value);
      expect(envFile).toContain("unset _NEMOCLAW_SANDBOX_LABEL");
      expect(envFile).not.toContain("export _NEMOCLAW_SANDBOX_LABEL");
      const { output } = inConnectShell(tmpDir, "openclaw channels add discord");
      expect(output).toContain("Run 'nemoclaw <name> channels add discord' on the host.");
      expect(output).not.toContain("\u001b");
      expect(output).not.toContain("INJECTED");
      expect(output).not.toContain("rm -rf");
    });
  });

  it("rejects an injected name longer than the sandbox name limit", () => {
    withTmpDir((tmpDir) => {
      const tooLong = `a${"b".repeat(NAME_MAX_LENGTH)}`;
      expect(tooLong.length).toBeGreaterThan(NAME_MAX_LENGTH);
      const envFile = generateConnectEnv(tmpDir, tooLong);
      expect(envFile).toContain("unset _NEMOCLAW_SANDBOX_LABEL");
      const { output } = inConnectShell(tmpDir, "_nemoclaw_policy_denial_hint_text");
      expect(output).toContain("nemoclaw <name> logs --tail 50");
    });
  });

  // The generated file is sourced into a shell the sandbox controls, so the
  // renderer must not trust a label the sandbox supplies itself.
  it("re-allowlists the label, so a sandbox-set value cannot inject a host command", () => {
    withTmpDir((tmpDir) => {
      generateConnectEnv(tmpDir, "my-assistant");
      const { output } = inConnectShell(
        tmpDir,
        "_NEMOCLAW_SANDBOX_LABEL='evil; rm -rf /'; _nemoclaw_policy_denial_hint_text",
      );
      expect(output).toContain("nemoclaw <name> logs --tail 50");
      expect(output).not.toContain("rm -rf");
    });
  });

  // Without the explicit unset branch a pre-set value would survive into the
  // copyable command whenever no trusted name is available.
  it("unsets a pre-existing label when the host injected no usable name", () => {
    withTmpDir((tmpDir) => {
      generateConnectEnv(tmpDir, "1");
      const { output } = inConnectShell(tmpDir, "_nemoclaw_policy_denial_hint_text", {
        _NEMOCLAW_SANDBOX_LABEL: "smuggled-name",
      });
      expect(output).toContain("nemoclaw <name> logs --tail 50");
      expect(output).not.toContain("smuggled-name");
    });
  });

  // Anti-drift: the shell allowlist and the TypeScript validator must agree, so
  // a name the CLI accepts is a name the hint renders.
  // A fresh tmp dir per name: the generator chmods its output 444, so the same
  // directory cannot be regenerated into.
  it.each([
    "a",
    "qa-7795",
    "my-assistant",
    "a1",
    "x".repeat(NAME_MAX_LENGTH),
  ])("agrees with NAME_VALID_PATTERN for %j, a name the CLI accepts", (name) => {
    expect(NAME_VALID_PATTERN.test(name), `${name} should be a valid sandbox name`).toBe(true);
    withTmpDir((tmpDir) => {
      const envFile = generateConnectEnv(tmpDir, name);
      expect(envFile).toContain(`export _NEMOCLAW_SANDBOX_LABEL='${name}'`);
    });
  });
});
