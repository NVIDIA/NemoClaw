// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { wrapExecCommandWithRuntimeEnv } from "./runtime-env";

describe("wrapExecCommandWithRuntimeEnv", () => {
  it("sources the trusted runtime env and preserves each original argv element (#4504)", () => {
    const command = ["openclaw", "agent", "-m", "hello world", "quote'and\"double"];
    const wrapped = wrapExecCommandWithRuntimeEnv(command);

    expect(wrapped).toEqual([
      "/bin/bash",
      "--noprofile",
      "--norc",
      "-p",
      "-c",
      'if [ -r "/tmp/nemoclaw-proxy-env.sh" ]; then builtin source "/tmp/nemoclaw-proxy-env.sh" || exit $?; fi; builtin unset OPENCLAW_GATEWAY_TOKEN; builtin exec -- "$@"',
      "nemoclaw-runtime-env",
      ...command,
    ]);
    expect(wrapped[5]).not.toMatch(/[\r\n]/);
  });

  it("removes OPENCLAW_GATEWAY_TOKEN from the executed command environment (#6291)", () => {
    const wrapped = wrapExecCommandWithRuntimeEnv([
      "/bin/sh",
      "-c",
      'printf "TOKEN=[%s]" "${OPENCLAW_GATEWAY_TOKEN:-}"',
    ]);
    const result = spawnSync(wrapped[0], wrapped.slice(1), {
      encoding: "utf-8",
      env: { ...process.env, OPENCLAW_GATEWAY_TOKEN: "super-secret-gateway-token" },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("TOKEN=[]");
    expect(result.stdout).not.toContain("super-secret-gateway-token");
  });

  it("preserves required non-credential proxy and gateway routing metadata", () => {
    const wrapped = wrapExecCommandWithRuntimeEnv([
      "/bin/sh",
      "-c",
      'printf "%s|%s|%s" "$HTTP_PROXY" "$NEMOCLAW_OPENCLAW_GATEWAY_URL" "$NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS"',
    ]);
    const result = spawnSync(wrapped[0], wrapped.slice(1), {
      encoding: "utf-8",
      env: {
        ...process.env,
        HTTP_PROXY: "http://10.200.0.1:3128",
        NEMOCLAW_OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
        NEMOCLAW_OPENCLAW_GATEWAY_URL: "ws://10.200.0.2:18789",
        OPENCLAW_GATEWAY_TOKEN: "super-secret-gateway-token",
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("http://10.200.0.1:3128|ws://10.200.0.2:18789|1");
    expect(result.stdout).not.toContain("super-secret-gateway-token");
  });

  it("ignores ambient BASH_ENV before sourcing the trusted runtime env (#4504)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-exec-bash-env-"));
    const bashEnv = path.join(root, "bash-env.sh");
    fs.writeFileSync(bashEnv, 'printf "BASH_ENV_RAN"\n');
    const wrapped = wrapExecCommandWithRuntimeEnv(["/usr/bin/printf", "%s", "COMMAND_RAN"]);

    try {
      const result = spawnSync(wrapped[0], wrapped.slice(1), {
        encoding: "utf-8",
        env: { ...process.env, BASH_ENV: bashEnv },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("COMMAND_RAN");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not reinterpret a command-leading exec option (#4504)", () => {
    const wrapped = wrapExecCommandWithRuntimeEnv([
      "-a",
      "spoofed-argv-zero",
      "/usr/bin/printf",
      "SHOULD_NOT_RUN",
    ]);
    const result = spawnSync(wrapped[0], wrapped.slice(1), { encoding: "utf-8" });

    expect(result.status).toBe(127);
    expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
  });
});
