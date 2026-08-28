// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AddSandboxChannelDependencies } from "../../../src/lib/actions/sandbox/policy-channel.ts";
import * as policyChannelDependenciesModule from "../../../src/lib/actions/sandbox/policy-channel-dependencies.ts";
import * as policyChannelModule from "../../../src/lib/actions/sandbox/policy-channel.ts";
import * as openshellRuntimeModule from "../../../src/lib/adapters/openshell/runtime.ts";
import * as messagingBridgeProviderModule from "../../../src/lib/onboard/messaging-bridge-provider.ts";
import * as onboardProvidersModule from "../../../src/lib/onboard/providers.ts";
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
type ProviderUpsertOptions = {
  readonly replaceExisting?: boolean;
  readonly revalidatePolicyRequirements?: (operation: string) => void;
};
type ProviderDependencies = {
  upsertMessagingProviders(
    tokenDefs: Parameters<typeof policyChannelDependencies.upsertMessagingProviders>[0],
    run: typeof runOpenshell,
    options?: ProviderUpsertOptions,
  ): string[];
};

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
const onboardProviders = (
  "default" in onboardProvidersModule ? onboardProvidersModule.default : onboardProvidersModule
) as ProviderDependencies;
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
  readonly rebuildSandbox?: (sandboxName: string, args: string[]) => Promise<unknown>;
}

interface GooglechatCredentialFixtureDependencies {
  readonly ensureProfiles?: typeof ensureMessagingBridgeProfiles;
  readonly providerDependencies?: ProviderDependencies;
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
  const providerDependencies = dependencies.providerDependencies ?? onboardProviders;
  const root = dependencies.root ?? ROOT;
  const run = dependencies.run ?? runOpenshell;
  const expectedName = `${sandboxName}-googlechat-bridge`;
  const expectedType = PROVIDER_TYPE_BY_AGENT[agent];
  const original = providerDependencies.upsertMessagingProviders;

  providerDependencies.upsertMessagingProviders = (tokenDefs, providerRun, options = {}) => {
    const fixtureTokenDefs = tokenDefs.filter(({ name }) => name === expectedName);
    const fixtureTokenDef = fixtureTokenDefs[0];
    if (
      fixtureTokenDefs.length !== 1 ||
      fixtureTokenDef?.envKey !== "GOOGLE_CHAT_ACCESS_TOKEN" ||
      fixtureTokenDef?.providerType !== expectedType
    ) {
      throw new Error("Google Chat live fixture received an unexpected provider definition");
    }

    const delegatedTokenDefs = tokenDefs.filter(({ name }) => name !== expectedName);
    const delegatedProviderNames =
      delegatedTokenDefs.length === 0 ? [] : original(delegatedTokenDefs, providerRun, options);
    const baseRun = providerRun ?? run;
    const revalidate = () =>
      options.revalidatePolicyRequirements?.(
        `manage Google Chat live fixture provider '${expectedName}'`,
      );
    const effectiveRun: typeof runOpenshell = (args, runOptions) => {
      revalidate();
      return baseRun(args, runOptions);
    };
    ensureProfiles(fixtureTokenDefs, {
      root,
      runOpenshell: effectiveRun,
      redact: (value) => value.replaceAll(GOOGLECHAT_E2E_ACCESS_TOKEN, "[redacted]"),
    });
    const existing = effectiveRun(["provider", "get", expectedName], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (existing.status === 0 && options.replaceExisting) {
      const removed = effectiveRun(["provider", "delete", expectedName], {
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (removed.status !== 0) {
        throw new Error(`Google Chat live fixture could not replace provider '${expectedName}'`);
      }
    }
    const action = existing.status === 0 && !options.replaceExisting ? "update" : "create";
    const providerArgs =
      action === "update"
        ? ["provider", "update", expectedName, "--credential", "GOOGLE_CHAT_ACCESS_TOKEN"]
        : [
            "provider",
            "create",
            "--name",
            expectedName,
            "--type",
            expectedType,
            "--credential",
            "GOOGLE_CHAT_ACCESS_TOKEN",
          ];
    const mutated = effectiveRun(providerArgs, {
      env: { GOOGLE_CHAT_ACCESS_TOKEN: GOOGLECHAT_E2E_ACCESS_TOKEN },
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (mutated.status !== 0) {
      throw new Error(`Google Chat live fixture could not ${action} provider '${expectedName}'`);
    }
    const registered = new Set([...delegatedProviderNames, expectedName]);
    return tokenDefs.map(({ name }) => name).filter((name) => registered.has(name));
  };

  return () => {
    providerDependencies.upsertMessagingProviders = original;
  };
}

const DEFAULT_DEPENDENCIES: GooglechatLiveE2eDependencies = {
  addSandboxChannel,
  installCredentialFixture: installGooglechatCredentialFixture,
  rebuildSandbox: (sandboxName, args) =>
    policyChannelDependencies.rebuildSandbox(sandboxName, args),
};

function requireLiveAudience(input: GooglechatLiveE2eComposition): string {
  assertChannelsStopStartSandboxName(input.sandboxName, input.agent);
  const audience = input.audience.trim();
  if (!audience) {
    throw new Error("GOOGLECHAT_AUDIENCE is required for the channels-stop-start live target");
  }
  return audience;
}

async function addGooglechatWithInstalledFixture(
  input: GooglechatLiveE2eComposition,
  audience: string,
  dependencies: GooglechatLiveE2eDependencies,
): Promise<void> {
  await dependencies.addSandboxChannel(
    input.sandboxName,
    { channel: "googlechat" },
    input.agent === "openclaw"
      ? {
          googlechatNonInteractiveAudienceCapability: Object.freeze({
            audience,
          }),
        }
      : {},
  );
}

/**
 * The sole composition root that grants non-interactive Google Chat audience
 * enrollment. Production CLI composition does not receive this capability.
 */
export async function addGooglechatForChannelsStopStartLiveE2e(
  input: GooglechatLiveE2eComposition,
  dependencies: GooglechatLiveE2eDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  const audience = requireLiveAudience(input);

  const restore = dependencies.installCredentialFixture(input.sandboxName, input.agent);
  try {
    await addGooglechatWithInstalledFixture(input, audience, dependencies);
  } finally {
    restore();
  }
}

/** Keep the fake OAuth mint installed across both provider registrations. */
export async function addAndRebuildGooglechatForChannelsStopStartLiveE2e(
  input: GooglechatLiveE2eComposition,
  dependencies: GooglechatLiveE2eDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  const audience = requireLiveAudience(input);
  if (!dependencies.rebuildSandbox) {
    throw new Error("Google Chat live rebuild dependency is unavailable");
  }

  const restore = dependencies.installCredentialFixture(input.sandboxName, input.agent);
  try {
    await addGooglechatWithInstalledFixture(input, audience, dependencies);
    await dependencies.rebuildSandbox(input.sandboxName, ["--yes"]);
  } finally {
    restore();
  }
}

/** Keep the fake OAuth mint installed while a later lifecycle rebuild reconciles Google Chat. */
export async function rebuildGooglechatForChannelsStopStartLiveE2e(
  input: Pick<GooglechatLiveE2eComposition, "sandboxName" | "agent">,
  dependencies: GooglechatLiveE2eDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  if (!dependencies.rebuildSandbox) {
    throw new Error("Google Chat live rebuild dependency is unavailable");
  }

  const restore = dependencies.installCredentialFixture(input.sandboxName, input.agent);
  try {
    await dependencies.rebuildSandbox(input.sandboxName, ["--yes"]);
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
  const sandboxName = process.argv[2] ?? "";
  const mode = process.argv[3];
  if (mode === "--rebuild-only") {
    await rebuildGooglechatForChannelsStopStartLiveE2e({ sandboxName, agent });
    return;
  }
  if (mode) throw new Error(`unknown Google Chat live E2E mode '${mode}'`);
  await addAndRebuildGooglechatForChannelsStopStartLiveE2e({
    sandboxName,
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
