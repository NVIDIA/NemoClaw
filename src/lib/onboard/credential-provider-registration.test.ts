// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxMessagingPlan } from "../messaging/manifest";
import type { Session } from "../state/onboard-session";
import { requiredMessagingProviderBindings } from "./checkpoint-replay";
import {
  type CredentialProviderRegistrationDeps,
  createCredentialProviderRegistration,
} from "./credential-provider-registration";
import type { MessagingTokenDef } from "./messaging-prep";

const BRAVE_SECRET = "brv-resume-secret";
const DISCORD_SECRET = "discord-resume-secret";
const refuseAuthorityChange = (): never => {
  throw new Error("authority changed");
};

const DISCORD_STATIC_PROFILE = {
  id: "discord-hermes-static-v1",
  credentials: [
    {
      name: "bot_token",
      env_vars: ["DISCORD_BOT_TOKEN"],
      required: true,
      auth_style: "header",
      header_name: "Authorization",
      query_param: "",
    },
  ],
  endpoints: [],
  binaries: [],
  inference_capable: false,
};

function providerMetadata(
  name: string,
  type: string,
  credentialKey: string,
): { status: number; stdout: string; stderr: string } {
  return {
    status: 0,
    stdout: [
      `Id: provider-${name}`,
      `Name: ${name}`,
      `Type: ${type}`,
      "Resource version: 1",
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
    getGatewayName: () => "test-gateway",
    getCredential: () => null,
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
    { condition: "matches", endpoints: [], expected: true },
    {
      condition: "has endpoint authority",
      endpoints: [{ host: "gateway.discord.gg", port: 443 }],
      expected: false,
    },
  ])(
    "reuses a tokenless Hermes Discord provider only when its static profile $condition",
    ({ endpoints, expected }) => {
      const session = { stagedCredentialProviders: [] } as unknown as Session;
      const runOpenshell = vi.fn((args: string[]) =>
        args.includes("profile") && args.includes("export")
          ? {
              status: 0,
              stdout: JSON.stringify({ ...DISCORD_STATIC_PROFILE, endpoints }),
              stderr: "",
            }
          : providerMetadata(
              "alpha-discord-bridge",
              "discord-hermes-static-v1",
              "DISCORD_BOT_TOKEN",
            ),
      );
      const deps = registrationDeps(runOpenshell, session);
      deps.root = process.cwd();
      const registration = createCredentialProviderRegistration(deps);

      expect(
        registration.providerMatchesGatewayCredential(
          "alpha-discord-bridge",
          "discord-hermes-static-v1",
          "DISCORD_BOT_TOKEN",
        ),
      ).toBe(expected);
      expect(runOpenshell).toHaveBeenCalledWith(
        [
          "provider",
          "profile",
          "-g",
          "test-gateway",
          "export",
          "discord-hermes-static-v1",
          "--output",
          "json",
        ],
        expect.objectContaining({ suppressOutput: true }),
      );
      expect(
        runOpenshell.mock.calls
          .map(([args]) => args)
          .filter((args) => args[0] === "provider" && ["create", "update"].includes(args[1] ?? "")),
      ).toEqual([]);
    },
  );

  it("uses one selected gateway for static profile and provider identity", () => {
    const session = { stagedCredentialProviders: [] } as unknown as Session;
    const commandResults = new Map([
      [
        "provider profile -g test-gateway export discord-hermes-static-v1 --output json",
        { status: 0, stdout: JSON.stringify(DISCORD_STATIC_PROFILE), stderr: "" },
      ],
      [
        "provider get -g test-gateway alpha-discord-bridge",
        providerMetadata("alpha-discord-bridge", "discord-hermes-static-v1", "DISCORD_BOT_TOKEN"),
      ],
    ]);
    const ambientProfileMismatch = {
      status: 0,
      stdout: JSON.stringify({
        ...DISCORD_STATIC_PROFILE,
        endpoints: [{ host: "gateway.discord.gg", port: 443 }],
      }),
      stderr: "",
    };
    const runOpenshell = vi.fn(
      (args: string[]) => commandResults.get(args.join(" ")) ?? ambientProfileMismatch,
    );
    const deps = registrationDeps(runOpenshell, session);
    deps.root = process.cwd();
    const registration = createCredentialProviderRegistration(deps);

    expect(
      registration.providerMatchesGatewayCredential(
        "alpha-discord-bridge",
        "discord-hermes-static-v1",
        "DISCORD_BOT_TOKEN",
      ),
    ).toBe(true);
    const commands = runOpenshell.mock.calls.map(([args]) => args);
    expect(commands).toContainEqual([
      "provider",
      "profile",
      "-g",
      "test-gateway",
      "export",
      "discord-hermes-static-v1",
      "--output",
      "json",
    ]);
    expect(commands).toContainEqual([
      "provider",
      "get",
      "-g",
      "test-gateway",
      "alpha-discord-bridge",
    ]);
  });

  it.each([
    {
      condition: "a gateway command failure",
      result: () => ({ status: 2, stderr: "gateway unavailable" }),
      expected: { kind: "indeterminate" as const },
    },
    {
      condition: "malformed provider metadata",
      result: () => ({ status: 0, stdout: "unexpected output" }),
      expected: { kind: "collision" as const },
    },
    {
      condition: "a thrown gateway command",
      result: () => {
        throw new Error("gateway unavailable");
      },
      expected: { kind: "indeterminate" as const },
    },
  ])("preserves $condition when inspecting a credential binding", ({ result, expected }) => {
    const session = { stagedCredentialProviders: [] } as unknown as Session;
    const registration = createCredentialProviderRegistration(
      registrationDeps(vi.fn(result), session),
    );

    expect(
      registration.inspectGatewayCredential(
        "alpha-telegram-bridge",
        "nemoclaw-mcp-v1",
        "TELEGRAM_BOT_TOKEN",
      ),
    ).toEqual(expected);
  });

  it("treats a failed static profile inspection as indeterminate", () => {
    const session = { stagedCredentialProviders: [] } as unknown as Session;
    const runOpenshell = vi.fn((args: string[]) =>
      args.includes("profile")
        ? { status: 2, stderr: "gateway unavailable" }
        : providerMetadata("alpha-discord-bridge", "discord-hermes-static-v1", "DISCORD_BOT_TOKEN"),
    );
    const deps = registrationDeps(runOpenshell, session);
    deps.root = process.cwd();
    const registration = createCredentialProviderRegistration(deps);

    expect(
      registration.inspectGatewayCredential(
        "alpha-discord-bridge",
        "discord-hermes-static-v1",
        "DISCORD_BOT_TOKEN",
      ),
    ).toEqual({ kind: "indeterminate" });
  });

  it("rejects tokenless Hermes Discord profile drift before provider mutation", async () => {
    const session = { stagedCredentialProviders: [] } as unknown as Session;
    const runOpenshell = vi.fn((args: string[]) =>
      args.includes("profile") && args.includes("export")
        ? {
            status: 0,
            stdout: JSON.stringify({
              ...DISCORD_STATIC_PROFILE,
              binaries: ["/usr/bin/curl"],
            }),
            stderr: "",
          }
        : providerMetadata("alpha-discord-bridge", "discord-hermes-static-v1", "DISCORD_BOT_TOKEN"),
    );
    const deps = registrationDeps(runOpenshell, session);
    deps.root = process.cwd();
    const registration = createCredentialProviderRegistration(deps);
    const tokenDef: MessagingTokenDef = {
      name: "alpha-discord-bridge",
      envKey: "DISCORD_BOT_TOKEN",
      token: null,
      providerType: "discord-hermes-static-v1",
    };

    await expect(
      registration.stageSandboxCredentialProviders(
        sandboxInput(requiredBindings([tokenDef])),
        async () => ({ messagingTokenDefs: [tokenDef] }),
      ),
    ).rejects.toThrow("existing credential provider does not match");

    expect(deps.updateSession).not.toHaveBeenCalled();
    expect(
      runOpenshell.mock.calls
        .map(([args]) => args)
        .filter((args) => args[0] === "provider" && ["create", "update"].includes(args[1] ?? "")),
    ).toEqual([]);
  });

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
  ])(
    "records migration according to the value sent when $condition",
    ({ env, ambientValue, expectedMigrated }) => {
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
    },
  );

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

  it("registers one static Hermes Discord provider from the checkpoint binding", async () => {
    const session = { stagedCredentialProviders: [] } as unknown as Session;
    const missing = { status: 1, stdout: "", stderr: "not found" };
    const success = { status: 0, stdout: "", stderr: "" };
    const runOpenshell = vi.fn((args: string[]) =>
      (args[0] === "provider" && args.includes("profile") && args.includes("export")) ||
      (args[0] === "provider" && args[1] === "get")
        ? missing
        : success,
    );
    const registration = createCredentialProviderRegistration(
      registrationDeps(runOpenshell, session),
    );
    const plan: SandboxMessagingPlan = {
      schemaVersion: 1,
      sandboxName: "alpha",
      agent: "hermes",
      workflow: "onboard",
      channels: [
        {
          channelId: "discord",
          displayName: "Discord",
          authMode: "token-paste",
          active: true,
          selected: true,
          configured: true,
          disabled: false,
          inputs: [],
          hooks: [],
        },
      ],
      disabledChannels: [],
      credentialBindings: [
        {
          channelId: "discord",
          credentialId: "discordBotToken",
          sourceInput: "botToken",
          providerName: "alpha-discord-bridge",
          providerEnvKey: "DISCORD_BOT_TOKEN",
          placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
          credentialAvailable: true,
        },
      ],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [],
      buildSteps: [],
      stateUpdates: [],
      healthChecks: [],
    };
    const required = requiredMessagingProviderBindings("alpha", plan);
    const tokenDefs: MessagingTokenDef[] = [
      {
        name: "alpha-discord-bridge",
        envKey: "DISCORD_BOT_TOKEN",
        token: DISCORD_SECRET,
        providerType: "discord-hermes-static-v1",
      },
    ];

    const registered = await registration.stageSandboxCredentialProviders(
      {
        sandboxName: "alpha",
        enabledChannels: ["discord"],
        webSearchConfig: null,
        agent: { name: "hermes" },
        requiredBindings: required,
      },
      async () => ({ messagingTokenDefs: tokenDefs }),
    );

    expect(required).toEqual([
      {
        name: "alpha-discord-bridge",
        type: "discord-hermes-static-v1",
        credentialEnv: "DISCORD_BOT_TOKEN",
      },
    ]);
    expect(registered).toEqual(required);
    expect(runOpenshell).toHaveBeenCalledWith(
      [
        "provider",
        "create",
        "-g",
        "test-gateway",
        "--name",
        "alpha-discord-bridge",
        "--type",
        "discord-hermes-static-v1",
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
  ])(
    "rejects partial Slack credentials before mutation when $condition (#7718)",
    async ({ appProvider, error }) => {
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
          .filter(
            (args) => args[0] === "provider" && (args[1] === "create" || args[1] === "update"),
          ),
      ).toEqual([]);
    },
  );

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
  ])(
    "rejects a credential plan with a different $mismatch before gateway mutation (#7701)",
    async ({ required }) => {
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
    },
  );

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

  it("refuses authority drift after credential-provider planning without side effects (#9833)", async () => {
    const session = { stagedCredentialProviders: [] } as unknown as Session;
    const runOpenshell = vi.fn();
    const deps = registrationDeps(runOpenshell, session);
    const registration = createCredentialProviderRegistration(deps);
    const tokenDef: MessagingTokenDef = {
      name: "alpha-discord-bridge",
      envKey: "DISCORD_BOT_TOKEN",
      token: DISCORD_SECRET,
    };
    const prepare = vi.fn(async () => ({ messagingTokenDefs: [tokenDef] }));

    await expect(
      registration.stageSandboxCredentialProviders(
        {
          ...sandboxInput(requiredBindings([tokenDef])),
          revalidateSandboxIdentity: () => {
            throw new Error("authority changed");
          },
        },
        prepare,
      ),
    ).rejects.toThrow("authority changed");

    expect(prepare).toHaveBeenCalledOnce();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(deps.updateSession).not.toHaveBeenCalled();
    expect(session.stagedCredentialProviders).toEqual([]);
  });

  it("stops provider registration when authority changes after the first provider (#9833)", async () => {
    const session = { stagedCredentialProviders: [] } as unknown as Session;
    const runOpenshell = vi.fn((args: string[]) =>
      args[1] === "get"
        ? { status: 1, stdout: "", stderr: "not found" }
        : { status: 0, stdout: "", stderr: "" },
    );
    const deps = registrationDeps(runOpenshell, session);
    const registration = createCredentialProviderRegistration(deps);
    const tokenDefs: MessagingTokenDef[] = [
      { name: "alpha-first", envKey: "FIRST_TOKEN", token: "first-secret" },
      { name: "alpha-second", envKey: "SECOND_TOKEN", token: "second-secret" },
    ];
    const revalidateSandboxIdentity = vi.fn((operation: string) =>
      operation === 'inspect or change provider "alpha-second"'
        ? refuseAuthorityChange()
        : undefined,
    );

    await expect(
      registration.stageSandboxCredentialProviders(
        {
          ...sandboxInput(requiredBindings(tokenDefs)),
          revalidateSandboxIdentity,
        },
        async () => ({ messagingTokenDefs: tokenDefs }),
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/authority changed.*alpha-first.*inspect.*before retrying/isu),
      mutatedProviderNames: ["alpha-first"],
    });

    expect(
      runOpenshell.mock.calls
        .map(([args]) => args)
        .filter((args) => args[0] === "provider" && args[1] === "create"),
    ).toHaveLength(1);
    expect(session.stagedCredentialProviders).toEqual([]);
  });

  it("rechecks before persisting migrated messaging credentials (#9833)", () => {
    const session = { stagedCredentialProviders: [] } as unknown as Session;
    const runOpenshell = vi.fn((args: string[]) =>
      args[1] === "get"
        ? { status: 1, stdout: "", stderr: "not found" }
        : { status: 0, stdout: "", stderr: "" },
    );
    const deps = registrationDeps(runOpenshell, session);
    deps.stagedLegacyValues = new Map([["DISCORD_BOT_TOKEN", DISCORD_SECRET]]);
    const registration = createCredentialProviderRegistration(deps);
    const revalidateSandboxIdentity = vi
      .fn<(operation: string) => void>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(refuseAuthorityChange);

    expect(() =>
      registration.upsertMessagingProviders(
        [
          {
            name: "alpha-discord-bridge",
            envKey: "DISCORD_BOT_TOKEN",
            token: DISCORD_SECRET,
          },
        ],
        { revalidateSandboxIdentity },
      ),
    ).toThrow("authority changed");

    expect(deps.migratedLegacyKeys).toEqual(new Set());
    expect(deps.persistMigratedLegacyKeys).not.toHaveBeenCalled();
  });
});
