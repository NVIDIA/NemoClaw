// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildDeployEnvLines,
  findBrevInstanceStatus,
  inferDeployProvider,
  isBrevInstanceFailed,
  isBrevInstanceReady,
} from "../../dist/lib/deploy";

describe("inferDeployProvider", () => {
  it("prefers an explicit provider override", () => {
    const provider = inferDeployProvider("openai", {
      NVIDIA_API_KEY: "nvapi-test",
    });

    expect(provider).toBe("openai");
  });

  it("infers the provider from a single matching credential", () => {
    const provider = inferDeployProvider("", {
      ANTHROPIC_API_KEY: "sk-ant-test",
    });

    expect(provider).toBe("anthropic");
  });

  it("returns null when multiple provider credentials are present without an override", () => {
    const provider = inferDeployProvider("", {
      NVIDIA_API_KEY: "nvapi-test",
      OPENAI_API_KEY: "sk-openai-test",
    });

    expect(provider).toBeNull();
  });
});

describe("buildDeployEnvLines", () => {
  it("includes standard non-interactive deploy env plus passthrough values", () => {
    const envLines = buildDeployEnvLines({
      env: {
        CHAT_UI_URL: "https://chat.example.com",
        NEMOCLAW_POLICY_MODE: "suggested",
      },
      sandboxName: "my-assistant",
      provider: "build",
      credentials: {
        NVIDIA_API_KEY: "nvapi-test",
      },
      shellQuote: (value: string) => `'${value}'`,
    });

    expect(envLines).toContain("NEMOCLAW_NON_INTERACTIVE=1");
    expect(envLines).toContain("NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1");
    expect(envLines).toContain("NEMOCLAW_SANDBOX_NAME='my-assistant'");
    expect(envLines).toContain("NEMOCLAW_PROVIDER='build'");
    expect(envLines).toContain("CHAT_UI_URL='https://chat.example.com'");
    expect(envLines).toContain("NEMOCLAW_POLICY_MODE='suggested'");
    expect(envLines).toContain("NVIDIA_API_KEY='nvapi-test'");
  });

  it("passes ALLOWED_CHAT_IDS through when Telegram is configured", () => {
    const envLines = buildDeployEnvLines({
      env: {},
      sandboxName: "my-assistant",
      provider: "build",
      credentials: {
        TELEGRAM_BOT_TOKEN: "123456:telegram-token",
        ALLOWED_CHAT_IDS: "111,222",
      },
      shellQuote: (value: string) => `'${value}'`,
    });

    expect(envLines).toContain("TELEGRAM_BOT_TOKEN='123456:telegram-token'");
    expect(envLines).toContain("ALLOWED_CHAT_IDS='111,222'");
  });

  it("omits ALLOWED_CHAT_IDS when Telegram is not configured", () => {
    const envLines = buildDeployEnvLines({
      env: {},
      sandboxName: "my-assistant",
      provider: "build",
      credentials: {
        ALLOWED_CHAT_IDS: "111,222",
      },
      shellQuote: (value: string) => `'${value}'`,
    });

    expect(envLines).not.toContain("ALLOWED_CHAT_IDS='111,222'");
  });
});

describe("Brev status helpers", () => {
  it("finds the matching instance from brev ls json", () => {
    const status = findBrevInstanceStatus(
      JSON.stringify([
        { name: "other", status: "RUNNING" },
        { name: "target", status: "FAILURE", build_status: "PENDING", shell_status: "NOT READY" },
      ]),
      "target",
    );

    expect(status).toMatchObject({
      name: "target",
      status: "FAILURE",
      build_status: "PENDING",
      shell_status: "NOT READY",
    });
  });

  it("classifies Brev failure states", () => {
    expect(
      isBrevInstanceFailed({
        status: "FAILURE",
        build_status: "PENDING",
        shell_status: "NOT READY",
      }),
    ).toBe(true);
    expect(
      isBrevInstanceFailed({
        status: "RUNNING",
        build_status: "COMPLETED",
        shell_status: "READY",
      }),
    ).toBe(false);
  });

  it("only classifies Brev readiness when running, completed, and ready", () => {
    expect(
      isBrevInstanceReady({
        status: "RUNNING",
        build_status: "COMPLETED",
        shell_status: "READY",
      }),
    ).toBe(true);
    expect(
      isBrevInstanceReady({
        status: "RUNNING",
        build_status: "BUILDING",
        shell_status: "NOT READY",
      }),
    ).toBe(false);
  });
});

describe("executeDeploy — instance name validation (#575)", () => {
  // Helper: build a minimal DeployExecutionOptions that tracks calls
  function makeMockOpts(instanceName: string) {
    const calls: string[] = [];
    let exitCode: number | undefined;
    let exitError: Error | undefined;

    return {
      opts: {
        instanceName,
        env: { NEMOCLAW_GPU: "a2-highgpu-1g:nvidia-tesla-a100:1" },
        rootDir: "/fake/root",
        getCredential: () => null,
        validateName: (name: string, label: string) => {
          if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
            throw new Error(
              `Invalid ${label}: '${name}'. Must be lowercase alphanumeric with optional internal hyphens.`,
            );
          }
          return name;
        },
        shellQuote: (value: string) => `'${value.replace(/'/g, "'\''")}'`,
        run: (command: string) => {
          calls.push(`run:${command}`);
        },
        runInteractive: (command: string) => {
          calls.push(`runInteractive:${command}`);
        },
        execFileSync: (file: string, args: string[], _opts?: Record<string, unknown>) => {
          calls.push(`execFileSync:${file} ${args.join(" ")}`);
          return "";
        },
        spawnSync: (file: string, args: string[], _opts?: Record<string, unknown>) => {
          calls.push(`spawnSync:${file} ${args.join(" ")}`);
        },
        log: () => {},
        error: () => {},
        stdoutWrite: () => {},
        exit: ((code: number) => {
          exitCode = code;
          exitError = new Error(`exit(${code})`);
          throw exitError;
        }) as (code: number) => never,
      },
      calls,
      getExitCode: () => exitCode,
      getExitError: () => exitError,
    };
  }

  const maliciousNames = [
    "foo;rm -rf /",
    "foo|cat /etc/passwd",
    "$(whoami)",
    "`whoami`",
    "foo && echo pwned",
    "foo'inject",
    'foo"inject',
    "../traversal",
    "UPPERCASE",
    "has spaces",

  ];

  for (const name of maliciousNames) {
    it(`rejects malicious instance name: ${JSON.stringify(name)}`, async () => {
      const { executeDeploy } = await import("../../dist/lib/deploy");
      const { opts, calls } = makeMockOpts(name);

      await expect(executeDeploy(opts)).rejects.toThrow(/Invalid instance name|instance name is required/i);

      // No shell commands should have been executed
      expect(calls).toHaveLength(0);
    });
  }

  it("accepts a valid instance name", async () => {
    const { executeDeploy } = await import("../../dist/lib/deploy");
    const { opts, getExitCode } = makeMockOpts("my-valid-instance");

    // This will fail at the provider detection step (no credentials),
    // but it should NOT fail at validation — proving the name was accepted.
    // Catch any thrown error and explicitly assert it wasn't a name-validation
    // failure, so a future regression can't silently pass this test.
    const caught = await executeDeploy(opts)
      .then(() => null)
      .catch((error: unknown) => error);
    if (caught) {
      expect(String(caught)).not.toMatch(
        /Invalid instance name|instance name is required/i,
      );
    }

    // If it exited, it should be because of missing provider/brev, not name validation
    if (getExitCode() !== undefined) {
      expect(getExitCode()).toBe(1);
    }
  });
});
