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
    normalizeCredentialValue: (value) => (typeof value === "string" ? value.trim() : ""),
    updateSession,
    stagedLegacyValues: new Map(),
    migratedLegacyKeys: new Set(),
    persistMigratedLegacyKeys: vi.fn(),
  };
}

function sandboxInput() {
  return {
    sandboxName: "alpha",
    enabledChannels: ["discord"],
    webSearchConfig: null,
    agent: {},
  };
}

describe("credential provider registration", () => {
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
      sandboxInput(),
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

    const registered = await registration.stageSandboxCredentialProviders(
      sandboxInput(),
      async () => ({
        messagingTokenDefs: [
          {
            name: "alpha-discord-bridge",
            envKey: "DISCORD_BOT_TOKEN",
            token: DISCORD_SECRET,
          },
        ],
      }),
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

  it("does not update or receipt a mismatched existing provider (#6743)", async () => {
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

    const registered = await registration.stageSandboxCredentialProviders(
      sandboxInput(),
      async () => ({
        messagingTokenDefs: [
          {
            name: "alpha-brave-search",
            envKey: "BRAVE_API_KEY",
            token: BRAVE_SECRET,
            providerType: "brave",
          },
        ],
      }),
    );

    expect(registered).toEqual([]);
    expect(session.stagedCredentialProviders).toEqual([]);
    expect(runOpenshell.mock.calls.map(([args]) => args.join(" "))).not.toContain(
      "provider update -g test-gateway alpha-brave-search --credential BRAVE_API_KEY",
    );
  });
});
