// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { validateName } from "../../dist/lib/runner";
import {
  buildDeployEnvLines,
  executeDeploy,
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

describe("executeDeploy", () => {
  it("exits before reading credentials when instance name is invalid (#575)", async () => {
    const getCredential = vi.fn(() => "should-not-use");
    const error = vi.fn();
    const exit = vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }) as (code: number) => never;

    await expect(
      executeDeploy({
        instanceName: "foo;bar",
        env: {},
        rootDir: "/tmp",
        getCredential,
        validateName,
        shellQuote: (value: string) => `'${value}'`,
        run: vi.fn(),
        runInteractive: vi.fn(),
        execFileSync: vi.fn(() => ""),
        spawnSync: vi.fn(() => ({ status: 0 })),
        log: vi.fn(),
        error,
        stdoutWrite: vi.fn(),
        exit,
      }),
    ).rejects.toThrow("exit:1");

    expect(getCredential).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    expect(String(error.mock.calls[0]?.[0])).toMatch(/Invalid instance name/);
  });
});
