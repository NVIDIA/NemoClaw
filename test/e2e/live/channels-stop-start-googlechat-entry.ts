// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AddSandboxChannelDependencies } from "../../../src/lib/actions/sandbox/policy-channel.ts";
import * as policyChannelDependenciesModule from "../../../src/lib/actions/sandbox/policy-channel-dependencies.ts";
import * as policyChannelModule from "../../../src/lib/actions/sandbox/policy-channel.ts";
import * as openshellRuntimeModule from "../../../src/lib/adapters/openshell/runtime.ts";
import * as messagingBridgeProviderModule from "../../../src/lib/onboard/messaging-bridge-provider.ts";
import * as statePathsModule from "../../../src/lib/state/paths.ts";
import { assertChannelsStopStartSandboxName } from "./channels-stop-start-safety.ts";
import type { AgentKind } from "./phase6-messaging-helpers.ts";

type PolicyChannelModule = typeof import("../../../src/lib/actions/sandbox/policy-channel.ts");
type PolicyChannelDependenciesModule =
  typeof import("../../../src/lib/actions/sandbox/policy-channel-dependencies.ts");
type OpenshellRuntimeModule = typeof import("../../../src/lib/adapters/openshell/runtime.ts");
type MessagingBridgeProviderModule =
  typeof import("../../../src/lib/onboard/messaging-bridge-provider.ts");
type StatePathsModule = typeof import("../../../src/lib/state/paths.ts");

const policyChannel = (
  "default" in policyChannelModule ? policyChannelModule.default : policyChannelModule
) as PolicyChannelModule;
const { addSandboxChannel } = policyChannel;
const policyChannelDependenciesNamespace = (
  "default" in policyChannelDependenciesModule
    ? policyChannelDependenciesModule.default
    : policyChannelDependenciesModule
) as PolicyChannelDependenciesModule;
const { policyChannelDependencies } = policyChannelDependenciesNamespace;
const openshellRuntime = (
  "default" in openshellRuntimeModule ? openshellRuntimeModule.default : openshellRuntimeModule
) as OpenshellRuntimeModule;
const { runOpenshell } = openshellRuntime;
const messagingBridgeProvider = (
  "default" in messagingBridgeProviderModule
    ? messagingBridgeProviderModule.default
    : messagingBridgeProviderModule
) as MessagingBridgeProviderModule;
const { ensureMessagingBridgeProfiles } = messagingBridgeProvider;
const statePaths = (
  "default" in statePathsModule ? statePathsModule.default : statePathsModule
) as StatePathsModule;
const { ROOT } = statePaths;

interface GooglechatLiveE2eComposition {
  readonly sandboxName: string;
  readonly agent: AgentKind;
  readonly audience: string;
}

interface GooglechatLiveE2eDependencies {
  readonly addSandboxChannel: (
    sandboxName: string,
    options: { readonly channel: string },
    dependencies: AddSandboxChannelDependencies,
  ) => Promise<void>;
  readonly installCredentialFixture: (sandboxName: string, agent: AgentKind) => () => void;
}

interface GooglechatCredentialFixtureDependencies {
  readonly ensureProfiles?: typeof ensureMessagingBridgeProfiles;
  readonly policyDependencies?: Pick<typeof policyChannelDependencies, "upsertMessagingProviders">;
  readonly root?: string;
  readonly run?: typeof runOpenshell;
}

export const GOOGLECHAT_E2E_ACCESS_TOKEN = "e2e-fake-googlechat-access-token";

const PROVIDER_TYPE_BY_AGENT: Readonly<Record<AgentKind, string>> = {
  openclaw: "google-chat-bridge",
  hermes: "google-chat-hermes-bridge",
};

/**
 * Replace Google Chat's asynchronous Google OAuth mint only inside this live-test
 * composition root. The fixed value is not a credential. Creating the real
 * OpenShell provider with it still exercises provider identity, revision-scoped
 * sandbox injection, endpoint binding, L7 rewrite, and removal without requiring
 * a Google service account in CI.
 */
export function installGooglechatCredentialFixture(
  sandboxName: string,
  agent: AgentKind,
  dependencies: GooglechatCredentialFixtureDependencies = {},
): () => void {
  assertChannelsStopStartSandboxName(sandboxName, agent);
  const ensureProfiles = dependencies.ensureProfiles ?? ensureMessagingBridgeProfiles;
  const policyDependencies = dependencies.policyDependencies ?? policyChannelDependencies;
  const root = dependencies.root ?? ROOT;
  const run = dependencies.run ?? runOpenshell;
  const expectedName = `${sandboxName}-googlechat-bridge`;
  const expectedType = PROVIDER_TYPE_BY_AGENT[agent];
  const original = policyDependencies.upsertMessagingProviders;

  policyDependencies.upsertMessagingProviders = (tokenDefs) => {
    if (
      tokenDefs.length !== 1 ||
      tokenDefs[0]?.name !== expectedName ||
      tokenDefs[0]?.envKey !== "GOOGLE_CHAT_ACCESS_TOKEN" ||
      tokenDefs[0]?.providerType !== expectedType
    ) {
      throw new Error("Google Chat live fixture received an unexpected provider definition");
    }

    ensureProfiles(tokenDefs, {
      root,
      runOpenshell: run,
      redact: (value) => value.replaceAll(GOOGLECHAT_E2E_ACCESS_TOKEN, "[redacted]"),
    });
    const existing = run(["provider", "get", expectedName], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (existing.status === 0) {
      throw new Error(`Google Chat live fixture provider '${expectedName}' survived pre-clean`);
    }
    const created = run(
      [
        "provider",
        "create",
        "--name",
        expectedName,
        "--type",
        expectedType,
        "--credential",
        "GOOGLE_CHAT_ACCESS_TOKEN",
      ],
      {
        env: { GOOGLE_CHAT_ACCESS_TOKEN: GOOGLECHAT_E2E_ACCESS_TOKEN },
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (created.status !== 0) {
      throw new Error(`Google Chat live fixture could not create provider '${expectedName}'`);
    }
    return [expectedName];
  };

  return () => {
    policyDependencies.upsertMessagingProviders = original;
  };
}

const DEFAULT_DEPENDENCIES: GooglechatLiveE2eDependencies = {
  addSandboxChannel,
  installCredentialFixture: installGooglechatCredentialFixture,
};

/**
 * The sole composition root that grants non-interactive Google Chat audience
 * enrollment. Production CLI composition does not receive this capability.
 */
export async function addGooglechatForChannelsStopStartLiveE2e(
  input: GooglechatLiveE2eComposition,
  dependencies: GooglechatLiveE2eDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  assertChannelsStopStartSandboxName(input.sandboxName, input.agent);
  const audience = input.audience.trim();
  if (!audience) {
    throw new Error("GOOGLECHAT_AUDIENCE is required for the channels-stop-start live target");
  }

  const restore = dependencies.installCredentialFixture(input.sandboxName, input.agent);
  try {
    await dependencies.addSandboxChannel(
      input.sandboxName,
      { channel: "googlechat" },
      input.agent === "openclaw"
        ? {
            googlechatNonInteractiveAudienceCapability: Object.freeze({ audience }),
          }
        : {},
    );
  } finally {
    restore();
  }
}

async function main(): Promise<void> {
  const agent = (process.env.NEMOCLAW_CHANNELS_STOP_START_AGENT ?? process.env.NEMOCLAW_AGENT) as
    | AgentKind
    | undefined;
  if (agent !== "openclaw" && agent !== "hermes") {
    throw new Error("NEMOCLAW_CHANNELS_STOP_START_AGENT must be openclaw or hermes");
  }
  await addGooglechatForChannelsStopStartLiveE2e({
    sandboxName: process.argv[2] ?? "",
    agent,
    audience: process.env.GOOGLECHAT_AUDIENCE ?? "",
  });
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
