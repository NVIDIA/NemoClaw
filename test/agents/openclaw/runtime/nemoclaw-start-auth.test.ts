// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.resolve(import.meta.dirname, "../../../../scripts/nemoclaw-start.sh");

describe("write_auth_profile (#1332)", () => {
  // Invokes write_auth_profile from the production start script in an isolated
  // HOME, then asserts on the resulting auth-profiles.json — observable
  // behavior, not source-text shape.
  const wrapper = [
    "set -euo pipefail",
    extractShellFunctionFromSource(
      fs.readFileSync(START_SCRIPT, "utf-8"),
      "is_managed_inference_route",
    ),
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

  it("writes profile under the route identifier from NEMOCLAW_INFERENCE_PROVIDER_ID", () => {
    const { home, authPath, status, stderr } = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "secret",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
    });
    try {
      expect(status, stderr).toBe(0);
      const profile = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      expect(profile).toEqual({
        "openai:manual": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", id: "NVIDIA_INFERENCE_API_KEY" },
          profileId: "openai:manual",
        },
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to 'inference' when neither route identifier is set", () => {
    const { home, authPath, status, stderr } = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "secret",
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
      NVIDIA_INFERENCE_API_KEY: "secret",
    });
    try {
      expect(status).toBe(0);
      const profile = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      expect(Object.keys(profile).every((key) => !/^nvidia:/.test(key))).toBe(true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("treats provider_key as a literal (no shell command substitution)", () => {
    // If the provider_key were interpolated into the heredoc instead of
    // passed as argv, $(...) inside the value would execute and replace it.
    const { home, authPath, status, stderr } = runWriteAuthProfile({
      NVIDIA_INFERENCE_API_KEY: "secret",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "$(echo pwned)",
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

  it("is a no-op when NVIDIA_INFERENCE_API_KEY is unset", () => {
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
      NVIDIA_INFERENCE_API_KEY: "secret",
      NEMOCLAW_INFERENCE_PROVIDER_ID: "openai",
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

describe("run_step_down_as_sandbox", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const helper = [
    extractShellFunctionFromSource(src, "_step_down_extract_function"),
    extractShellFunctionFromSource(src, "run_step_down_as_sandbox"),
  ].join("\n");

  it("dispatches via a temp script and cleans up after success", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-step-down-helper-"));
    const stepDownLog = path.join(tmpDir, "step-down.log");
    const marker = path.join(tmpDir, "marker");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `STEP_DOWN_PREFIX_SANDBOX=(bash -c 'printf "%s\\n" "$2" >${JSON.stringify(stepDownLog)}; exec "$@"' sandbox-step-down)`,
        `payload_fn() { printf 'ran\\n' >${JSON.stringify(marker)}; }`,
        helper,
        "run_step_down_as_sandbox 'payload_fn' payload_fn",
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(fs.readFileSync(marker, "utf-8").trim()).toBe("ran");
      const tempScriptPath = fs.readFileSync(stepDownLog, "utf-8").trim();
      expect(tempScriptPath).toMatch(/^\/tmp\/nemoclaw-step-down-[A-Za-z0-9]{6}\.sh$/);
      expect(fs.existsSync(tempScriptPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("removes the temp script even when the step-down body fails", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-step-down-fail-"));
    const stepDownLog = path.join(tmpDir, "step-down.log");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        `STEP_DOWN_PREFIX_SANDBOX=(bash -c 'printf "%s\\n" "$2" >${JSON.stringify(stepDownLog)}; exec "$@"' sandbox-step-down)`,
        "failing_fn() { return 7; }",
        helper,
        "run_step_down_as_sandbox 'failing_fn' failing_fn",
        'printf "EXIT=%s\\n" "$?"',
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("EXIT=7");
      const tempScriptPath = fs.readFileSync(stepDownLog, "utf-8").trim();
      expect(tempScriptPath).toMatch(/^\/tmp\/nemoclaw-step-down-[A-Za-z0-9]{6}\.sh$/);
      expect(fs.existsSync(tempScriptPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("survives a heredoc used as an if-condition's command without bash declare -f reordering the then-body into the heredoc", () => {
    // Regression: bash `declare -f` serialises a function whose `if`
    // condition is a heredoc-bearing command by placing the indented
    // `then`-body command BEFORE the heredoc closer. When the
    // step-down shell re-parses that output, it consumes the displaced
    // command as part of the heredoc body, leaves the `then` block
    // empty, and aborts on the closing `fi` with
    //   syntax error near unexpected token `fi'
    // (the exact text NV QA reported on v0.0.58 after the earlier fix
    // that handled only the heredoc-as-last-statement shape). The new
    // helper bypasses `declare -f` and reads the function source
    // verbatim from disk via `shopt -s extdebug` + `declare -F`, so
    // every here-doc placement survives intact.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-step-down-heredoc-if-"));
    const stepDownLog = path.join(tmpDir, "step-down.log");
    const sentinel = path.join(tmpDir, "ran.txt");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `STEP_DOWN_PREFIX_SANDBOX=(bash -c 'printf "%s\\n" "$2" >${JSON.stringify(stepDownLog)}; exec "$@"' sandbox-step-down)`,
        `SENTINEL=${JSON.stringify(sentinel)}`,
        // Mirror seed_default_workspace_templates' broken shape exactly:
        // a heredoc-bearing `node` invocation as the `if` condition,
        // with a `then`-body command, followed by `fi`. This is the
        // shape `declare -f` mangles in bash 5.x.
        "heredoc_in_if_condition() {",
        '  local marker="$1"',
        "  if ! node - \"$marker\" <<'NODE' >/dev/null 2>&1; then",
        'const fs = require("fs");',
        "const target = process.argv[2];",
        'fs.writeFileSync(target, "ran-via-heredoc-if\\n");',
        "process.exit(0);",
        "NODE",
        "    return 0",
        "  fi",
        "}",
        helper,
        "run_step_down_as_sandbox 'heredoc_in_if_condition \"$SENTINEL\"' heredoc_in_if_condition",
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        env: { ...process.env, SENTINEL: sentinel },
        timeout: 5000,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stderr).not.toContain("syntax error near unexpected token `fi'");
      expect(result.stderr).not.toContain("bash -n syntax check");
      // The heredoc body ran in the step-down shell: it wrote the sentinel.
      expect(fs.existsSync(sentinel)).toBe(true);
      expect(fs.readFileSync(sentinel, "utf-8")).toBe("ran-via-heredoc-if\n");
      const tempScriptPath = fs.readFileSync(stepDownLog, "utf-8").trim();
      expect(tempScriptPath).toMatch(/^\/tmp\/nemoclaw-step-down-[A-Za-z0-9]{6}\.sh$/);
      expect(fs.existsSync(tempScriptPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("survives heredoc-bearing function bodies through the temp-script round-trip", () => {
    // The production caller passes functions whose bodies contain a
    // `<<'TAG'` heredoc (e.g. `python3 - <<'PYAUTH' ...`). This test
    // mirrors that shape with two adjacent heredocs to exercise the
    // declare-f → file → bash dispatch and assert both bodies run
    // end-to-end without the `syntax error near unexpected token 'fi'`
    // that the older `bash -c "$(declare -f ...) ..."` route reported.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-step-down-heredoc-"));
    const stepDownLog = path.join(tmpDir, "step-down.log");
    const outPath = path.join(tmpDir, "out.txt");
    const altPath = path.join(tmpDir, "alt.txt");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `STEP_DOWN_PREFIX_SANDBOX=(bash -c 'printf "%s\\n" "$2" >${JSON.stringify(stepDownLog)}; exec "$@"' sandbox-step-down)`,
        `OUT_PATH=${JSON.stringify(outPath)}`,
        `ALT_PATH=${JSON.stringify(altPath)}`,
        // Mimic write_auth_profile's `python3 - <<'PYAUTH'` shape, including
        // a second function with its own heredoc, to ensure declare -f
        // round-trips both bodies through the temp script intact.
        "heredoc_one() {",
        '  if [ -z "${OUT_PATH:-}" ]; then',
        "    return",
        "  fi",
        "  python3 - \"$OUT_PATH\" <<'PYONE'",
        "import sys",
        "with open(sys.argv[1], 'w') as fh:",
        "    fh.write('heredoc-one-ok\\n')",
        "PYONE",
        "}",
        "heredoc_two() {",
        '  if [ -z "${ALT_PATH:-}" ]; then',
        "    return",
        "  fi",
        "  python3 - \"$ALT_PATH\" <<'PYTWO'",
        "import sys",
        "with open(sys.argv[1], 'w') as fh:",
        "    fh.write('heredoc-two-ok\\n')",
        "PYTWO",
        "}",
        helper,
        "run_step_down_as_sandbox 'heredoc_one; heredoc_two' heredoc_one heredoc_two",
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        env: { ...process.env, OUT_PATH: outPath, ALT_PATH: altPath },
        timeout: 5000,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(fs.readFileSync(outPath, "utf-8")).toBe("heredoc-one-ok\n");
      expect(fs.readFileSync(altPath, "utf-8")).toBe("heredoc-two-ok\n");
      const tempScriptPath = fs.readFileSync(stepDownLog, "utf-8").trim();
      expect(tempScriptPath).toMatch(/^\/tmp\/nemoclaw-step-down-[A-Za-z0-9]{6}\.sh$/);
      expect(fs.existsSync(tempScriptPath)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("setup_auth_profile_as_sandbox", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  const helper = [
    extractShellFunctionFromSource(src, "is_managed_inference_route"),
    extractShellFunctionFromSource(src, "_step_down_extract_function"),
    extractShellFunctionFromSource(src, "run_step_down_as_sandbox"),
  ].join("\n");
  const setup = extractShellFunctionFromSource(src, "setup_auth_profile_as_sandbox");
  it("runs the auth-profile setup under HOME=/sandbox even when the parent env has HOME=/root", () => {
    // setpriv preserves HOME; profile setup must replace /root with /sandbox.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-setup-auth-profile-"));
    const observedHome = path.join(tmpDir, "observed-home");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "export HOME=/root",
        "STEP_DOWN_PREFIX_SANDBOX=(env)",
        `write_auth_profile() { printf '%s\\n' "$HOME" >${JSON.stringify(observedHome)}; }`,
        "harden_auth_profiles() { :; }",
        helper,
        setup,
        "setup_auth_profile_as_sandbox",
      ].join("\n"),
      { mode: 0o700 },
    );
    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 5000,
      });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(fs.readFileSync(observedHome, "utf-8").trim()).toBe("/sandbox");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
