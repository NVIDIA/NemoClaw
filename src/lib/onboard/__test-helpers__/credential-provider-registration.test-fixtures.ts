// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type { Session } from "../../state/onboard-session";
import type { CredentialProviderRegistrationDeps } from "../credential-provider-registration";
import type { MessagingTokenDef } from "../messaging-prep";

export function providerMetadata(name: string, type: string, credentialKey: string) {
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

export function providerMissing(name: string) {
  return { status: 1, stdout: "", stderr: `provider '${name}' not found` };
}

export function registrationDeps(
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
  };
}

export function requiredBindings(tokenDefs: readonly MessagingTokenDef[]) {
  return tokenDefs.map((tokenDef) => ({
    name: tokenDef.name,
    type: tokenDef.providerType || "generic",
    credentialEnv: tokenDef.envKey,
  }));
}

export function sandboxInput(bindings: ReturnType<typeof requiredBindings>) {
  return {
    sandboxName: "alpha",
    enabledChannels: ["discord"],
    webSearchConfig: null,
    agent: {},
    requiredBindings: bindings,
  };
}
