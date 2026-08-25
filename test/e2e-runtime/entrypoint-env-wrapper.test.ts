// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { sliceBlock } from "../helpers/corporate-ca-support";

const HELPER = path.join(import.meta.dirname, "..", "..", "scripts", "lib", "entrypoint-env-wrapper.sh");
const OPENCLAW_START = path.join(import.meta.dirname, "..", "..", "scripts", "nemoclaw-start.sh");

function runNormalizer(argv: readonly string[]) {
  const harness = [
    "set -euo pipefail",
    'helper="$1"',
    "shift",
    'source "$helper"',
    'nemoclaw_normalize_entrypoint_env_wrapper "$@"',
    'if [ "$NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGC" -eq 0 ]; then',
    "  set --",
    "else",
    '  set -- "${NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGV[@]}"',
    "fi",
    `printf 'UID=%s\\n' "$(id -u)"`,
    "printf 'PROFILE=%s\\n' \"${NEMOCLAW_STARTUP_PROFILE_B64-__UNSET__}\"",
    "printf 'CA=%s\\n' \"${NEMOCLAW_CORPORATE_CA_B64-__UNSET__}\"",
    "printf 'HTTP_PROXY=%s\\n' \"${HTTP_PROXY-__UNSET__}\"",
    "printf 'NO_PROXY=%s\\n' \"${NO_PROXY-__UNSET__}\"",
    "printf 'FAST_REENTRY_INTERVAL=%s\\n' \"${NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS-__UNSET__}\"",
    "printf 'FAST_REENTRY_POLLS=%s\\n' \"${NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS-__UNSET__}\"",
    "printf 'HERMES_API_PORT=%s\\n' \"${NEMOCLAW_HERMES_API_PORT-__UNSET__}\"",
    `printf 'ARG=%s\\n' "$@"`,
  ].join("\n");
  return spawnSync("/bin/bash", ["-c", harness, "entrypoint-env-wrapper-test", HELPER, ...argv], {
    encoding: "utf8",
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
    },
  });
}

describe("OCI entrypoint env-wrapper normalization", () => {
  it("promotes the exact managed handoff before preserving the command tail", () => {
    const uid = String(process.getuid?.() ?? "");
    const result = runNormalizer([
      "env",
      "NEMOCLAW_STARTUP_PROFILE_B64=eyJzY2hlbWFWZXJzaW9uIjoxfQ",
      "NEMOCLAW_CORPORATE_CA_B64=Y2E=",
      "HTTP_PROXY=http://user:pass@proxy.example.test:18080",
      "NO_PROXY=localhost,127.0.0.1",
      "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS=0.25",
      "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS=3",
      "NEMOCLAW_HERMES_API_PORT=8645",
      "nemoclaw-start",
      "/bin/sh",
      "-c",
      "printf managed command",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`UID=${uid}`);
    expect(result.stdout).toContain("PROFILE=eyJzY2hlbWFWZXJzaW9uIjoxfQ");
    expect(result.stdout).toContain("CA=Y2E=");
    expect(result.stdout).toContain("HTTP_PROXY=http://user:pass@proxy.example.test:18080");
    expect(result.stdout).toContain("NO_PROXY=localhost,127.0.0.1");
    expect(result.stdout).toContain("FAST_REENTRY_INTERVAL=0.25");
    expect(result.stdout).toContain("FAST_REENTRY_POLLS=3");
    expect(result.stdout).toContain("HERMES_API_PORT=8645");
    expect(result.stdout).toContain("ARG=/bin/sh\nARG=-c\nARG=printf managed command\n");
  });

  it("strips a direct self invocation without interpreting its command arguments", () => {
    const result = runNormalizer(["/usr/local/bin/nemoclaw-start", "env", "FOO=bar", "printenv"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PROFILE=__UNSET__");
    expect(result.stdout).toContain("ARG=env\nARG=FOO=bar\nARG=printenv\n");
  });

  it("leaves an unrelated explicit env command untouched", () => {
    const result = runNormalizer(["env", "FOO=bar", "printenv", "FOO"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ARG=env\nARG=FOO=bar\nARG=printenv\nARG=FOO\n");
  });

  it("leaves a user command tail that only looks like a managed assignment (#8595)", () => {
    const result = runNormalizer([
      "env",
      "FOO=bar",
      "/bin/sh",
      "-c",
      "NEMOCLAW_SANDBOX_NAME=probe",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "ARG=env\nARG=FOO=bar\nARG=/bin/sh\nARG=-c\nARG=NEMOCLAW_SANDBOX_NAME=probe\n",
    );
  });

  it.each([
    {
      name: "rejects an interpreter variable outside the supported set",
      argv: ["env", "NODE_OPTIONS=--require=/sandbox/untrusted.cjs", "nemoclaw-start"],
      message: "unsupported variable 'NODE_OPTIONS'",
    },
    {
      name: "rejects a repeated assignment",
      argv: [
        "env",
        "NEMOCLAW_STARTUP_PROFILE_B64=first",
        "NEMOCLAW_STARTUP_PROFILE_B64=second",
        "nemoclaw-start",
      ],
      message: "repeats variable 'NEMOCLAW_STARTUP_PROFILE_B64'",
    },
    {
      name: "rejects a startup profile handed to another command",
      argv: ["env", "NEMOCLAW_STARTUP_PROFILE_B64=profile", "/usr/bin/true"],
      message: "Malformed managed startup env wrapper",
    },
    {
      name: "rejects a break token between assignments and the terminator",
      argv: ["env", "NEMOCLAW_CORPORATE_CA_B64=Y2E=", "not-an-assignment", "nemoclaw-start"],
      message: "Malformed managed startup env wrapper",
    },
    {
      name: "rejects a managed name in the leading assignment run",
      argv: ["env", "NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS=5", "/bin/sh"],
      message: "Malformed managed startup env wrapper",
    },
    {
      name: "rejects a managed name after an unmanaged assignment",
      argv: ["env", "FOO=bar", "OPENCLAW_HOME=/sandbox", "/bin/sh", "-c", ":"],
      message: "Malformed managed startup env wrapper",
    },
    {
      name: "rejects a corporate CA payload in the user command tail",
      argv: ["env", "FOO=bar", "/bin/sh", "-c", "NEMOCLAW_CORPORATE_CA_B64=Y2E="],
      message: "Malformed managed startup env wrapper",
    },
  ])("fails closed for malformed or unsafe root handoff: $name (#8595)", ({ argv, message }) => {
    const result = runNormalizer(argv);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toBe("");
  });

  it("unwraps the sandbox-create env self-wrapper and applies dashboard port defaults", () => {
    const normalizer = fs.readFileSync(
      path.join(import.meta.dirname, "..", "..", "scripts", "lib", "entrypoint-env-wrapper.sh"),
      "utf-8",
    );
    const openClawPortBlock = sliceBlock(
      OPENCLAW_START,
      'NEMOCLAW_CMD=("$@")',
      "# ── Config integrity check",
    );
    const snippet = [
      normalizer,
      'nemoclaw_normalize_entrypoint_env_wrapper "$@"',
      'if [ "$NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGC" -eq 0 ]; then set --; ' +
        'else set -- "${NEMOCLAW_ENTRYPOINT_NORMALIZED_ARGV[@]}"; fi',
      openClawPortBlock,
    ].join("\n");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-wrapper-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "run.sh");
    function runScenario(setArgs: string, extraEnv: Record<string, string> = {}) {
      const baseEnv = { ...process.env };
      delete baseEnv.NEMOCLAW_DASHBOARD_PORT;
      delete baseEnv.CHAT_UI_URL;
      const script = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        setArgs,
        snippet,
        'printf "CHAT_UI_URL=%s\\n" "$CHAT_UI_URL"',
        'printf "PUBLIC_PORT=%s\\n" "$PUBLIC_PORT"',
        'printf "OPENCLAW_GATEWAY_PORT=%s\\n" "$OPENCLAW_GATEWAY_PORT"',
        'printf "OPENCLAW_GATEWAY_URL=%s\\n" "$OPENCLAW_GATEWAY_URL"',
        'printf "SANDBOX_HOME=%s\\n" "$_SANDBOX_HOME"',
        'printf "OPENCLAW_HOME=%s\\n" "$OPENCLAW_HOME"',
        'printf "OPENCLAW_STATE_DIR=%s\\n" "$OPENCLAW_STATE_DIR"',
        'printf "OPENCLAW_CONFIG_PATH=%s\\n" "$OPENCLAW_CONFIG_PATH"',
        'printf "OPENCLAW_OAUTH_DIR=%s\\n" "$OPENCLAW_OAUTH_DIR"',
        'printf "CMD=%s\\n" "${NEMOCLAW_CMD[*]}"',
      ].join("\n");
      fs.writeFileSync(scriptPath, script, { mode: 0o700 });
      return spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        timeout: 5000,
        env: {
          ...baseEnv,
          PATH: `${fakeBin}:${process.env.PATH || ""}`,
          ...extraEnv,
        },
      });
    }

    vi.stubEnv("NEMOCLAW_DASHBOARD_PORT", "19999");
    vi.stubEnv("CHAT_UI_URL", "https://ambient.example.test/ui");

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
      expect(injected.stdout).toContain("OPENCLAW_GATEWAY_PORT=19000");
      expect(injected.stdout).toContain("OPENCLAW_GATEWAY_URL=ws://127.0.0.1:19000");
      expect(injected.stdout).toContain("SANDBOX_HOME=/sandbox");
      expect(injected.stdout).toContain("OPENCLAW_HOME=/sandbox");
      expect(injected.stdout).toContain("OPENCLAW_STATE_DIR=/sandbox/.openclaw");
      expect(injected.stdout).toContain("OPENCLAW_CONFIG_PATH=/sandbox/.openclaw/openclaw.json");
      expect(injected.stdout).toContain("OPENCLAW_OAUTH_DIR=/sandbox/.openclaw/credentials");
      expect(injected.stdout).toContain("CMD=openclaw agent --agent main");

      const bakedCustomPort = runScenario("set -- nemoclaw-start openclaw agent", {
        CHAT_UI_URL: "http://127.0.0.1:18790",
      });
      expect(bakedCustomPort.status).toBe(0);
      expect(bakedCustomPort.stdout).toContain("CHAT_UI_URL=http://127.0.0.1:18790");
      expect(bakedCustomPort.stdout).toContain("PUBLIC_PORT=18790");
      expect(bakedCustomPort.stdout).toContain("OPENCLAW_GATEWAY_PORT=18790");
      expect(bakedCustomPort.stdout).toContain("OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18790");
      expect(bakedCustomPort.stdout).toContain("OPENCLAW_STATE_DIR=/sandbox/.openclaw");
      expect(bakedCustomPort.stdout).toContain("OPENCLAW_OAUTH_DIR=/sandbox/.openclaw/credentials");
      expect(bakedCustomPort.stdout).toContain("CMD=openclaw agent");

      const baked = runScenario("set -- nemoclaw-start openclaw agent", {
        CHAT_UI_URL: "https://baked.example.test/ui",
      });
      expect(baked.status).toBe(0);
      expect(baked.stdout).toContain("CHAT_UI_URL=https://baked.example.test/ui");
      expect(baked.stdout).toContain("PUBLIC_PORT=18789");
      expect(baked.stdout).toContain("OPENCLAW_GATEWAY_PORT=18789");
      expect(baked.stdout).toContain("OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789");
      expect(baked.stdout).toContain("SANDBOX_HOME=/sandbox");
      expect(baked.stdout).toContain("OPENCLAW_STATE_DIR=/sandbox/.openclaw");
      expect(baked.stdout).toContain("CMD=openclaw agent");

      const defaults = runScenario("set -- nemoclaw-start openclaw agent");
      expect(defaults.status).toBe(0);
      expect(defaults.stdout).toContain("CHAT_UI_URL=http://127.0.0.1:18789");
      expect(defaults.stdout).toContain("PUBLIC_PORT=18789");

      const invalidHighPort = runScenario("set -- nemoclaw-start openclaw agent", {
        NEMOCLAW_DASHBOARD_PORT: "70000",
      });
      expect(invalidHighPort.status).toBe(1);
      expect(invalidHighPort.stderr).toContain("Invalid NEMOCLAW_DASHBOARD_PORT='70000'");
      expect(invalidHighPort.stderr).toContain("must be an integer between 1024 and 65535");
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
