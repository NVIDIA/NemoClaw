// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { Session } from "../state/onboard-session";
import {
  type CredentialProviderRegistrationDeps,
  createCredentialProviderRegistration,
} from "./credential-provider-registration";
import type { MessagingTokenDef } from "./messaging-prep";

const BRAVE_SECRET = "brv-resume-secret";
const DISCORD_SECRET = "discord-resume-secret";

function providerMetadata(
  name: string,
  type: string,
  credentialKey: string,
): { status: number; stdout: string; stderr: string } {
  return {
    status: 0,
    stdout: [
      `Name: ${name}`,
      `Type: ${type}`,
      `Credential keys: ${credentialKey}`,
      "Config keys: <none>",
    ].join("\n"),
    stderr: "",
  };
}

function registrationDeps(
  runOpenshellMock: ReturnType<typeof vi.fn>,
  session: Session,
): CredentialProviderRegistrationDeps {
  const updateSession = vi.fn(
    (mutator: (current: Session) => Session | void): Session => mutator(session) ?? session,
  );
  return {
    root: "/repo",
    runOpenshell: runOpenshellMock as unknown as CredentialProviderRegistrationDeps["runOpenshell"],
    redact: (input) => input,
    getGatewayName: () => "test-gateway",
    getCredential: () => null,
    normalizeCredentialValue: (value) => (typeof value === "string" ? value.trim() : ""),
    updateSession,
    stagedLegacyValues: new Map(),
    migratedLegacyKeys: new Set(),
    persistMigratedLegacyKeys: vi.fn(),
  };
}

function requiredBindings(tokenDefs: readonly MessagingTokenDef[]) {
  return tokenDefs.map((tokenDef) => ({
    name: tokenDef.name,
    type: tokenDef.providerType || "generic",
    credentialEnv: tokenDef.envKey,
  }));
}

function sandboxInput(bindings: ReturnType<typeof requiredBindings>) {
  return {
    sandboxName: "alpha",
    enabledChannels: ["discord"],
    webSearchConfig: null,
    agent: {},
    requiredBindings: bindings,
  };
}

describe("credential provider registration", () => {
  it.each([
    {
      condition: "the explicit environment contains the staged value",
      env: { COMPATIBLE_API_KEY: "legacy-key" },
      ambientValue: "other-key",
      expectedMigrated: true,
    },
    {
      condition: "the inherited environment contains the staged value",
      env: {},
      ambientValue: "legacy-key",
      expectedMigrated: true,
    },
    {
      condition: "the provider receives a replacement value",
      env: { COMPATIBLE_API_KEY: "replacement-key" },
      ambientValue: "legacy-key",
      expectedMigrated: false,
    },
  ])("records migration according to the value sent when $condition", ({
    env,
    ambientValue,
    expectedMigrated,
  }) => {
    const session = { stagedCredentialProviders: [] } as unknown as Session;
    const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const deps = registrationDeps(runOpenshell, session);
    deps.getCredential = vi.fn(() => ambientValue);
    deps.stagedLegacyValues = new Map([["COMPATIBLE_API_KEY", "legacy-key"]]);
    deps.migratedLegacyKeys.add("COMPATIBLE_API_KEY");
    const registration = createCredentialProviderRegistration(deps);

    const result = registration.upsertProvider(
      "compatible-endpoint",
      "openai",
      "COMPATIBLE_API_KEY",
      "https://inference.example.com/v1",
      env,
      "alternate-gateway",
    );

    expect(result).toEqual({ ok: true });
    expect(deps.migratedLegacyKeys.has("COMPATIBLE_API_KEY")).toBe(expectedMigrated);
    expect(deps.persistMigratedLegacyKeys).toHaveBeenCalledOnce();
    expect(runOpenshell).toHaveBeenCalledWith(
      expect.arrayContaining(["-g", "alternate-gateway"]),
      expect.any(Object),
    );
  });

  it("does not record migration when provider registration fails", () => {
    const session = { stagedCredentialProviders: [] } as unknown as Session;
    const runOpenshell = vi.fn((args: string[]) => ({
      status: args[1] === "get" ? 1 : 9,
      stdout: "",
      stderr: "registration failed",
    }));
    const deps = registrationDeps(runOpenshell, session);
    deps.stagedLegacyValues = new Map([["COMPATIBLE_API_KEY", "legacy-key"]]);
    const registration = createCredentialProviderRegistration(deps);

    const result = registration.upsertProvider(
      "compatible-endpoint",
      "openai",
      "COMPATIBLE_API_KEY",
      "https://inference.example.com/v1",
      { COMPATIBLE_API_KEY: "legacy-key" },
    );

    expect(result.ok).toBe(false);
    expect(deps.migratedLegacyKeys).toEqual(new Set());
    expect(deps.persistMigratedLegacyKeys).not.toHaveBeenCalled();
  });

  it("updates exact Brave and messaging providers and records secret-free receipts (#6743)", async () => {
    const session = { stagedCredentialProviders: [] } as unknown as Session;
    const commandResults = new Map([
      [
        "provider get -g test-gateway alpha-brave-search",
        providerMetadata("alpha-brave-search", "brave", "BRAVE_API_KEY"),
      ],
      [
        "provider get -g test-gateway alpha-discord-bridge",
        providerMetadata("alpha-discord-bridge", "generic", "DISCORD_BOT_TOKEN"),
      ],
    ]);
    const defaultResult = { status: 0, stdout: "", stderr: "" };
    const runOpenshell = vi.fn(
      (args: string[]) => commandResults.get(args.join(" ")) ?? defaultResult,
    );
    const registration = createCredentialProviderRegistration(
      registrationDeps(runOpenshell, session),
    );
    const tokenDefs: MessagingTokenDef[] = [
      {
        name: "alpha-brave-search",
        envKey: "BRAVE_API_KEY",
        token: BRAVE_SECRET,
        providerType: "brave",
      },
      {
        name: "alpha-discord-bridge",
        envKey: "DISCORD_BOT_TOKEN",
        token: DISCORD_SECRET,
      },
    ];

    const registered = await registration.stageSandboxCredentialProviders(
      sandboxInput(requiredBindings(tokenDefs)),
      async () => ({ messagingTokenDefs: tokenDefs }),
    );

    expect(registered).toEqual([
      { name: "alpha-brave-search", type: "brave", credentialEnv: "BRAVE_API_KEY" },
      { name: "alpha-discord-bridge", type: "generic", credentialEnv: "DISCORD_BOT_TOKEN" },
    ]);
    expect(session.stagedCredentialProviders).toEqual([
      "alpha-brave-search",
      "alpha-discord-bridge",
    ]);
    expect(runOpenshell).toHaveBeenCalledWith(
      [
        "provider",
        "update",
        "-g",
        "test-gateway",
        "alpha-brave-search",
        "--credential",
        "BRAVE_API_KEY",
      ],
      expect.objectContaining({ env: { BRAVE_API_KEY: BRAVE_SECRET } }),
    );
    expect(runOpenshell).toHaveBeenCalledWith(
      [
        "provider",
        "update",
        "-g",
        "test-gateway",
        "alpha-discord-bridge",
        "--credential",
        "DISCORD_BOT_TOKEN",
      ],
      expect.objectContaining({ env: { DISCORD_BOT_TOKEN: DISCORD_SECRET } }),
    );

    const argv = runOpenshell.mock.calls.flatMap(([args]) => args);
    const commandOutput = runOpenshell.mock.results
      .flatMap(({ value }) => [value.stdout, value.stderr])
      .join("\n");
    expect(argv).not.toContain(BRAVE_SECRET);
    expect(argv).not.toContain(DISCORD_SECRET);
    expect(commandOutput).not.toContain(BRAVE_SECRET);
    expect(commandOutput).not.toContain(DISCORD_SECRET);
  });

  it("creates a missing messaging provider and records its receipt (#6743)", async () => {
    const session = { stagedCredentialProviders: [] } as unknown as Session;
    const missing = { status: 1, stdout: "", stderr: "not found" };
    const success = { status: 0, stdout: "", stderr: "" };
    const runOpenshell = vi.fn((args: string[]) =>
      args[0] === "provider" && args[1] === "get" ? missing : success,
    );
    const registration = createCredentialProviderRegistration(
      registrationDeps(runOpenshell, session),
    );

    const tokenDefs: MessagingTokenDef[] = [
      {
        name: "alpha-discord-bridge",
        envKey: "DISCORD_BOT_TOKEN",
        token: DISCORD_SECRET,
      },
    ];
    const registered = await registration.stageSandboxCredentialProviders(
      sandboxInput(requiredBindings(tokenDefs)),
      async () => ({ messagingTokenDefs: tokenDefs }),
    );

    expect(registered).toEqual([
      { name: "alpha-discord-bridge", type: "generic", credentialEnv: "DISCORD_BOT_TOKEN" },
    ]);
    expect(session.stagedCredentialProviders).toEqual(["alpha-discord-bridge"]);
    expect(runOpenshell).toHaveBeenCalledWith(
      [
        "provider",
        "create",
        "-g",
        "test-gateway",
        "--name",
        "alpha-discord-bridge",
        "--type",
        "generic",
        "--credential",
        "DISCORD_BOT_TOKEN",
      ],
      expect.objectContaining({ env: { DISCORD_BOT_TOKEN: DISCORD_SECRET } }),
    );
  });

  it("rejects a mismatched existing provider before updating it (#6743)", async () => {
    const session = {
      stagedCredentialProviders: ["alpha-brave-search"],
    } as unknown as Session;
    const mismatchedMetadata = providerMetadata("alpha-brave-search", "generic", "BRAVE_API_KEY");
    const commandResults = new Map([
      ["provider get -g test-gateway alpha-brave-search", mismatchedMetadata],
    ]);
    const defaultResult = { status: 0, stdout: "", stderr: "" };
    const runOpenshell = vi.fn(
      (args: string[]) => commandResults.get(args.join(" ")) ?? defaultResult,
    );
    const registration = createCredentialProviderRegistration(
      registrationDeps(runOpenshell, session),
    );

    const tokenDefs: MessagingTokenDef[] = [
      {
        name: "alpha-brave-search",
        envKey: "BRAVE_API_KEY",
        token: BRAVE_SECRET,
        providerType: "brave",
      },
    ];
    await expect(
      registration.stageSandboxCredentialProviders(
        sandboxInput(requiredBindings(tokenDefs)),
        async () => ({ messagingTokenDefs: tokenDefs }),
      ),
    ).rejects.toThrow("An existing credential provider does not match the required binding.");

    expect(session.stagedCredentialProviders).toEqual(["alpha-brave-search"]);
    expect(runOpenshell.mock.calls.map(([args]) => args.join(" "))).not.toContain(
      "provider update -g test-gateway alpha-brave-search --credential BRAVE_API_KEY",
    );
  });

  it("rejects a conflicting Slack binding before writing any provider in the batch (#7701)", async () => {
    const session = {
      stagedCredentialProviders: ["alpha-slack-bridge", "alpha-slack-app"],
    } as unknown as Session;
    const missing = { status: 1, stdout: "", stderr: "not found" };
    const success = { status: 0, stdout: "", stderr: "" };
    const responses = new Map([
      [
        "provider get -g test-gateway alpha-slack-bridge",
        providerMetadata("alpha-slack-bridge", "slack", "SLACK_BOT_TOKEN"),
      ],
      ["provider get -g test-gateway alpha-slack-app", missing],
    ]);
    const runOpenshell = vi.fn((args: string[]) => responses.get(args.join(" ")) ?? success);
    const deps = registrationDeps(runOpenshell, session);
    const registration = createCredentialProviderRegistration(deps);
    const tokenDefs: MessagingTokenDef[] = [
      {
        name: "alpha-slack-bridge",
        envKey: "SLACK_BOT_TOKEN",
        token: "xoxb-current-token",
      },
      {
        name: "alpha-slack-app",
        envKey: "SLACK_APP_TOKEN",
        token: "xapp-current-token",
      },
    ];

    await expect(
      registration.stageSandboxCredentialProviders(
        sandboxInput(requiredBindings(tokenDefs)),
        async () => ({ messagingTokenDefs: tokenDefs }),
      ),
    ).rejects.toThrow("An existing credential provider does not match the required binding.");

    expect(session.stagedCredentialProviders).toEqual(["alpha-slack-bridge", "alpha-slack-app"]);
    expect(deps.updateSession).not.toHaveBeenCalled();
    expect(
      runOpenshell.mock.calls
        .map(([args]) => args)
        .filter((args) => args[0] === "provider" && (args[1] === "create" || args[1] === "update")),
    ).toEqual([]);
  });

  it("ignores a tokenless provider outside the required plan (#7718)", async () => {
    const session = { stagedCredentialProviders: [] } as unknown as Session;
    const required: MessagingTokenDef = {
      name: "alpha-discord-bridge",
      envKey: "DISCORD_BOT_TOKEN",
      token: null,
    };
    const runOpenshell = vi.fn(() =>
      providerMetadata("alpha-discord-bridge", "generic", "DISCORD_BOT_TOKEN"),
    );
    const deps = registrationDeps(runOpenshell, session);
    const registration = createCredentialProviderRegistration(deps);

    const registered = await registration.stageSandboxCredentialProviders(
      sandboxInput(requiredBindings([required])),
      async () => ({
        messagingTokenDefs: [
          required,
          {
            name: "alpha-extra-team-token",
            envKey: "TEAM_TOKEN",
            token: null,
          },
        ],
      }),
    );

    expect(registered).toEqual([]);
    expect(deps.updateSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      condition: "the app provider is missing",
      appProvider: { status: 1, stdout: "", stderr: "not found" },
      error:
        "A required credential provider is missing and no credential is available to recreate it.",
    },
    {
      condition: "the app provider binding differs",
      appProvider: providerMetadata("alpha-slack-app", "generic", "OTHER_SLACK_APP_TOKEN"),
      error: "An existing credential provider does not match the required binding.",
    },
  ])("rejects partial Slack credentials before mutation when $condition (#7718)", async ({
    appProvider,
    error,
  }) => {
    const session = {
      stagedCredentialProviders: ["alpha-slack-bridge", "alpha-slack-app"],
    } as unknown as Session;
    const missing = { status: 1, stdout: "", stderr: "not found" };
    const success = { status: 0, stdout: "", stderr: "" };
    const responses = new Map([
      ["provider get -g test-gateway alpha-slack-bridge", missing],
      ["provider get -g test-gateway alpha-slack-app", appProvider],
    ]);
    const runOpenshell = vi.fn((args: string[]) => responses.get(args.join(" ")) ?? success);
    const deps = registrationDeps(runOpenshell, session);
    const registration = createCredentialProviderRegistration(deps);
    const tokenDefs: MessagingTokenDef[] = [
      {
        name: "alpha-slack-bridge",
        envKey: "SLACK_BOT_TOKEN",
        token: "xoxb-current-token",
      },
      {
        name: "alpha-slack-app",
        envKey: "SLACK_APP_TOKEN",
        token: null,
      },
    ];

    await expect(
      registration.stageSandboxCredentialProviders(
        {
          ...sandboxInput(requiredBindings(tokenDefs)),
          enabledChannels: ["slack"],
        },
        async () => ({ messagingTokenDefs: tokenDefs }),
      ),
    ).rejects.toThrow(error);

    expect(session.stagedCredentialProviders).toEqual(["alpha-slack-bridge", "alpha-slack-app"]);
    expect(deps.updateSession).not.toHaveBeenCalled();
    expect(
      runOpenshell.mock.calls
        .map(([args]) => args)
        .filter((args) => args[0] === "provider" && (args[1] === "create" || args[1] === "update")),
    ).toEqual([]);
  });

  it.each([
    {
      mismatch: "name",
      required: {
        name: "other-discord-bridge",
        type: "generic",
        credentialEnv: "DISCORD_BOT_TOKEN",
      },
    },
    {
      mismatch: "type",
      required: {
        name: "alpha-discord-bridge",
        type: "discord",
        credentialEnv: "DISCORD_BOT_TOKEN",
      },
    },
    {
      mismatch: "credential key",
      required: {
        name: "alpha-discord-bridge",
        type: "generic",
        credentialEnv: "OTHER_DISCORD_TOKEN",
      },
    },
  ])("rejects a credential plan with a different $mismatch before gateway mutation (#7701)", async ({
    required,
  }) => {
    const session = { stagedCredentialProviders: [] } as unknown as Session;
    const runOpenshell = vi.fn();
    const deps = registrationDeps(runOpenshell, session);
    const registration = createCredentialProviderRegistration(deps);
    const tokenDefs: MessagingTokenDef[] = [
      {
        name: "alpha-discord-bridge",
        envKey: "DISCORD_BOT_TOKEN",
        token: DISCORD_SECRET,
      },
    ];

    await expect(
      registration.stageSandboxCredentialProviders(sandboxInput([required]), async () => ({
        messagingTokenDefs: tokenDefs,
      })),
    ).rejects.toThrow("Credential provider plan does not match the required bindings.");

    expect(runOpenshell).not.toHaveBeenCalled();
    expect(deps.updateSession).not.toHaveBeenCalled();
    expect(session.stagedCredentialProviders).toEqual([]);
  });

  it("rejects duplicate planned provider names before gateway mutation (#7701)", async () => {
    const session = { stagedCredentialProviders: [] } as unknown as Session;
    const runOpenshell = vi.fn();
    const deps = registrationDeps(runOpenshell, session);
    const registration = createCredentialProviderRegistration(deps);
    const tokenDef: MessagingTokenDef = {
      name: "alpha-discord-bridge",
      envKey: "DISCORD_BOT_TOKEN",
      token: DISCORD_SECRET,
    };

    await expect(
      registration.stageSandboxCredentialProviders(
        sandboxInput(requiredBindings([tokenDef])),
        async () => ({ messagingTokenDefs: [tokenDef, tokenDef] }),
      ),
    ).rejects.toThrow("Credential provider plan does not match the required bindings.");

    expect(runOpenshell).not.toHaveBeenCalled();
    expect(deps.updateSession).not.toHaveBeenCalled();
  });
});
