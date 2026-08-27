// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

type RunResult = { status: number; stdout?: string; stderr?: string };
type RunOptions = { env?: Record<string, string | undefined> };
type RunOpenshell = (command: string[], options?: RunOptions) => RunResult;

const {
  finalizePostPolicyMessagingProviderSync,
  synchronizeMessagingProvidersAfterPolicy,
  upsertMessagingProviders,
} = require("../providers") as {
  finalizePostPolicyMessagingProviderSync(
    input: {
      sandboxName: string;
      gatewayName: string;
      envKeys: readonly string[];
      advanceProviderRefresh?(phase: string): void;
    },
    deps: {
      runOpenshell: RunOpenshell;
      sleepSeconds(seconds: number): void;
      waitForSandboxReady(name: string, attempts?: number, delaySeconds?: number): boolean;
      revalidateSandboxIdentity?(operation: string): void;
    },
  ): void;
  synchronizeMessagingProvidersAfterPolicy(
    input: Record<string, unknown>,
    deps: Record<string, unknown>,
  ): Promise<void>;
  upsertMessagingProviders(
    tokenDefs: Array<{
      name: string;
      envKey: string;
      token: string | null;
      providerType?: string;
      additionalCredentials?: Array<{ envKey: string; token: string | null }>;
    }>,
    runOpenshell: RunOpenshell,
    options?: { bestEffort?: boolean; requireExactBindings?: boolean },
  ): string[];
};

const ENDPOINTLESS_PROFILE = JSON.stringify({
  id: "nemoclaw-mcp-v1",
  credentials: [],
  endpoints: [],
  binaries: [],
  inference_capable: false,
});

describe("post-policy messaging provider synchronization", () => {
  it("co-locates namespaced extension credentials on the canonical provider", () => {
    const tokens = {
      canonical: "telegram-canonical-must-not-leak",
      agentA: "telegram-agent-a-must-not-leak",
      agentB: "telegram-agent-b-must-not-leak",
    };
    const calls: Array<{ command: string[]; env?: Record<string, string | undefined> }> = [];
    let created = false;
    const providers = upsertMessagingProviders(
      [
        {
          name: "alpha-telegram-bridge",
          envKey: "TELEGRAM_BOT_TOKEN",
          token: tokens.canonical,
          providerType: "nemoclaw-mcp-v1",
          additionalCredentials: [
            { envKey: "TELEGRAM_BOT_TOKEN_AGENT_A", token: tokens.agentA },
            { envKey: "TELEGRAM_BOT_TOKEN_AGENT_B", token: tokens.agentB },
          ],
        },
      ],
      (command, options) => {
        calls.push({ command, env: options?.env });
        switch (command[1]) {
          case "profile":
            return { status: 0, stdout: ENDPOINTLESS_PROFILE };
          case "get":
            return created
              ? {
                  status: 0,
                  stdout: [
                    "Name: alpha-telegram-bridge",
                    "Type: nemoclaw-mcp-v1",
                    "Credential keys: TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_TOKEN_AGENT_A, TELEGRAM_BOT_TOKEN_AGENT_B",
                    "Config keys: <none>",
                    "",
                  ].join("\n"),
                }
              : { status: 1, stdout: "", stderr: "provider not found" };
          case "create":
            created = true;
            return { status: 0, stdout: "", stderr: "" };
          default:
            return { status: 0, stdout: "", stderr: "" };
        }
      },
    );

    expect(providers).toEqual(["alpha-telegram-bridge"]);
    expect(calls.find(({ command }) => command[1] === "create")).toEqual({
      command: [
        "provider",
        "create",
        "--name",
        "alpha-telegram-bridge",
        "--type",
        "nemoclaw-mcp-v1",
        "--credential",
        "TELEGRAM_BOT_TOKEN",
        "--credential",
        "TELEGRAM_BOT_TOKEN_AGENT_A",
        "--credential",
        "TELEGRAM_BOT_TOKEN_AGENT_B",
      ],
      env: {
        TELEGRAM_BOT_TOKEN: tokens.canonical,
        TELEGRAM_BOT_TOKEN_AGENT_A: tokens.agentA,
        TELEGRAM_BOT_TOKEN_AGENT_B: tokens.agentB,
      },
    });
    expect(calls.flatMap(({ command }) => command)).not.toEqual(
      expect.arrayContaining(Object.values(tokens)),
    );
  });

  it("proves stable placeholders before and after the post-policy sandbox relaunch", () => {
    const placeholderOutput = [
      "TELEGRAM_BOT_TOKEN\topenshell:resolve:env:v12_TELEGRAM_BOT_TOKEN",
      "TELEGRAM_BOT_TOKEN_AGENT_A\topenshell:resolve:env:v12_TELEGRAM_BOT_TOKEN_AGENT_A",
    ].join("\n");
    const runOpenshell = vi.fn((args: string[]) => ({
      status: 0,
      stdout: args[1] === "exec" ? placeholderOutput : "",
    }));
    const sleepSeconds = vi.fn();
    const waitForSandboxReady = vi.fn(() => true);

    finalizePostPolicyMessagingProviderSync(
      {
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        envKeys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN_AGENT_A"],
      },
      { runOpenshell, sleepSeconds, waitForSandboxReady },
    );

    expect(runOpenshell.mock.calls.map(([args]) => args.slice(0, 3))).toEqual([
      ["sandbox", "exec", "-g"],
      ["sandbox", "exec", "-g"],
      ["sandbox", "stop", "-g"],
      ["sandbox", "start", "-g"],
      ["sandbox", "exec", "-g"],
      ["sandbox", "exec", "-g"],
    ]);
    expect(sleepSeconds).toHaveBeenCalledTimes(2);
    expect(waitForSandboxReady).toHaveBeenCalledWith("alpha", 30, 2);
  });

  it("records every identity-checked refresh phase before registry publication (#10153)", async () => {
    const placeholder = "TELEGRAM_BOT_TOKEN\topenshell:resolve:env:v12_TELEGRAM_BOT_TOKEN";
    const phases: string[] = [];
    const revalidateSandboxIdentity = vi.fn();
    const checkpoint = {
      schemaVersion: 1,
      state: "verified-create",
      policyAuthority: "nemoclaw-managed",
      observedPolicyAuthority: "owner-unknown",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sandboxName: "alpha",
      lifecycleGeneration: "generation-1",
      sandboxIdentityFingerprint: "a".repeat(64),
      route: "native",
      policyHash: "sha256:policy",
      policyVersion: 1,
      policyCreationReceipt: {},
    };

    await synchronizeMessagingProvidersAfterPolicy(
      {
        sandboxName: "alpha",
        enabledChannels: ["telegram"],
        agent: null,
        webSearchConfig: null,
        pendingPolicyVerification: checkpoint,
      },
      {
        rebindMessagingCapabilities: vi.fn(async () => ({
          messagingTokenDefs: [
            {
              name: "alpha-telegram-bridge",
              envKey: "TELEGRAM_BOT_TOKEN",
              token: "token",
              providerType: "nemoclaw-mcp-v1",
            },
          ],
          reusableMessagingProviders: [],
        })),
        upsertMessagingProviders: vi.fn(),
        runGatewayOpenshell: vi.fn(),
        runOpenshell: vi.fn((args: string[]) => ({
          status: 0,
          stdout: args[1] === "exec" ? placeholder : "",
        })),
        sleepSeconds: vi.fn(),
        waitForSandboxReady: vi.fn(() => true),
        gatewayName: "nemoclaw",
        revalidateSandboxIdentity,
        advancePendingSandboxProviderRefresh: vi.fn(
          (_name: string, expected: typeof checkpoint, providerRefresh: { phase: string }) => {
            phases.push(providerRefresh.phase);
            return { ...expected, providerRefresh };
          },
        ),
      },
    );

    expect(phases).toEqual(["attaching", "stopping", "stopped", "started", "ready"]);
    expect(revalidateSandboxIdentity).toHaveBeenCalled();
  });

  it("does not relaunch when a post-policy credential never appears", () => {
    const runOpenshell = vi.fn((_args: string[]) => ({ status: 0, stdout: "" }));

    expect(() =>
      finalizePostPolicyMessagingProviderSync(
        { sandboxName: "alpha", gatewayName: "nemoclaw", envKeys: ["TELEGRAM_BOT_TOKEN"] },
        {
          runOpenshell,
          sleepSeconds: vi.fn(),
          waitForSandboxReady: vi.fn(() => true),
        },
      ),
    ).toThrow(/missing: TELEGRAM_BOT_TOKEN/u);
    expect(runOpenshell.mock.calls.some(([args]) => args[1] === "stop")).toBe(false);
  });

  it("completes the refresh journal when no credential projection is required (#10153)", () => {
    const advanceProviderRefresh = vi.fn();
    const runOpenshell = vi.fn();

    finalizePostPolicyMessagingProviderSync(
      {
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        envKeys: [],
        advanceProviderRefresh,
      },
      {
        runOpenshell,
        sleepSeconds: vi.fn(),
        waitForSandboxReady: vi.fn(() => true),
      },
    );

    expect(advanceProviderRefresh).toHaveBeenCalledWith("ready");
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("rejects invalid post-policy credential keys before sandbox execution", () => {
    const runOpenshell = vi.fn();

    expect(() =>
      finalizePostPolicyMessagingProviderSync(
        { sandboxName: "alpha", gatewayName: "nemoclaw", envKeys: ["BAD-KEY"] },
        {
          runOpenshell,
          sleepSeconds: vi.fn(),
          waitForSandboxReady: vi.fn(() => true),
        },
      ),
    ).toThrow(/invalid credential env key/u);
    expect(runOpenshell).not.toHaveBeenCalled();
  });

  it("rejects an unrequested namespaced credential before provider mutation (#10153)", () => {
    const commands: string[] = [];

    expect(() =>
      upsertMessagingProviders(
        [
          {
            name: "alpha-telegram-bridge",
            envKey: "TELEGRAM_BOT_TOKEN",
            token: null,
            providerType: "nemoclaw-mcp-v1",
          },
        ],
        (command) => {
          commands.push(command.join(" "));
          return {
            status: 0,
            stdout: [
              "Name: alpha-telegram-bridge",
              "Type: nemoclaw-mcp-v1",
              "Credential keys: TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_TOKEN_OLD",
              "Config keys: <none>",
              "",
            ].join("\n"),
            stderr: "",
          };
        },
        { bestEffort: true, requireExactBindings: true },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "NEMOCLAW_MESSAGING_PROVIDER_BINDING_CONFLICT",
        mutatedProviderNames: [],
      }),
    );
    expect(commands.some((command) => command.includes("provider update"))).toBe(false);
  });
});
