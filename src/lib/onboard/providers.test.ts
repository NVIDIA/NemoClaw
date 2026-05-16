// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

type RunResult = { status: number; stdout?: string; stderr?: string };
type RunOptions = { env?: Record<string, string | undefined> };
type RunOpenshell = (command: string[], opts?: RunOptions) => RunResult;

const { buildProviderArgs, providerExistsInGateway, upsertProvider } = require(
  "../../../dist/lib/onboard/providers",
) as {
  buildProviderArgs: (
    action: "create" | "update",
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
  ) => string[];
  providerExistsInGateway: (name: string, runOpenshell: RunOpenshell) => boolean;
  upsertProvider: (
    name: string,
    type: string,
    credentialEnv: string,
    baseUrl: string | null,
    env: Record<string, string | undefined>,
    runOpenshell: RunOpenshell,
  ) => { ok: boolean; status?: number; message?: string };
};

describe("onboard provider helpers", () => {
  it("builds create arguments for generic providers", () => {
    const args = buildProviderArgs(
      "create",
      "discord-bridge",
      "generic",
      "DISCORD_BOT_TOKEN",
      null,
    );
    expect(args).toEqual([
      "provider",
      "create",
      "--name",
      "discord-bridge",
      "--type",
      "generic",
      "--credential",
      "DISCORD_BOT_TOKEN",
    ]);
  });

  it("builds update arguments", () => {
    const args = buildProviderArgs("update", "inference", "openai", "NVIDIA_API_KEY", null);
    expect(args).toEqual(["provider", "update", "inference", "--credential", "NVIDIA_API_KEY"]);
  });

  it("appends OPENAI_BASE_URL config for openai providers with a base URL", () => {
    const args = buildProviderArgs(
      "create",
      "inference",
      "openai",
      "NVIDIA_API_KEY",
      "https://api.example.com/v1",
    );
    expect(args).toContain("--config");
    expect(args).toContain("OPENAI_BASE_URL=https://api.example.com/v1");
  });

  it("appends ANTHROPIC_BASE_URL config for anthropic providers with a base URL", () => {
    const args = buildProviderArgs(
      "create",
      "inference",
      "anthropic",
      "ANTHROPIC_API_KEY",
      "https://api.anthropic.example.com",
    );
    expect(args).toContain("--config");
    expect(args).toContain("ANTHROPIC_BASE_URL=https://api.anthropic.example.com");
  });

  it("ignores base URL for generic providers", () => {
    const args = buildProviderArgs(
      "create",
      "slack-bridge",
      "generic",
      "SLACK_BOT_TOKEN",
      "https://ignored.example.com",
    );
    expect(args).not.toContain("--config");
  });

  it("checks whether providers exist in the gateway", () => {
    expect(providerExistsInGateway("discord-bridge", () => ({ status: 0 }))).toBe(true);
    expect(providerExistsInGateway("missing-bridge", () => ({ status: 1 }))).toBe(false);
  });

  it("creates a new provider and returns ok on success", () => {
    const commands: string[] = [];
    const result = upsertProvider(
      "discord-bridge",
      "generic",
      "DISCORD_BOT_TOKEN",
      null,
      { DISCORD_BOT_TOKEN: "fake" },
      (command) => {
        const normalized = command.join(" ");
        commands.push(normalized);
        if (normalized.includes("provider get")) return { status: 1, stdout: "", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    );

    expect(result).toEqual({ ok: true });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatch(/provider get/);
    expect(commands[1]).toMatch(/provider create --name discord-bridge/);
    expect(commands[1]).toMatch(/--credential DISCORD_BOT_TOKEN/);
  });

  it("does not add its own log line on top of runner output (#1506)", () => {
    let stdoutWrites = 0;
    const result = upsertProvider(
      "test-bridge",
      "generic",
      "TEST_TOKEN",
      null,
      { TEST_TOKEN: "tok" },
      (command) => {
        if (command.includes("get")) return { status: 1, stdout: "", stderr: "" };
        stdoutWrites += 1;
        return { status: 0, stdout: "✓ Created provider test-bridge", stderr: "" };
      },
    );

    expect(result).toEqual({ ok: true });
    expect(stdoutWrites).toBe(1);
  });

  it("updates existing providers instead of creating (#1155)", () => {
    const commands: string[] = [];
    const result = upsertProvider(
      "inference",
      "openai",
      "NVIDIA_API_KEY",
      "https://integrate.api.nvidia.com/v1",
      {},
      (command) => {
        commands.push(command.join(" "));
        return { status: 0, stdout: "", stderr: "" };
      },
    );

    expect(result).toEqual({ ok: true });
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatch(/provider get/);
    expect(commands[1]).toMatch(/provider update/);
    expect(commands[1]).toMatch(/--config OPENAI_BASE_URL=https:\/\/integrate\.api\.nvidia\.com\/v1/);
  });

  it("returns redacted error details when create or update fails", () => {
    const result = upsertProvider("bad-provider", "generic", "SOME_KEY", null, {}, (command) => {
      if (command.includes("get")) return { status: 1, stdout: "", stderr: "" };
      return { status: 1, stdout: "", stderr: "gateway unreachable" };
    });

    expect(result).toEqual({ ok: false, status: 1, message: "gateway unreachable" });
  });
});
