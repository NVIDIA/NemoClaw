// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  OpenShellProviderAdapter,
  OpenShellProviderError,
  OpenShellProviderMetadata,
} from "../../adapters/openshell/provider-adapter";
import { selectedOpenShellGateway } from "../../adapters/openshell/sandbox-observer";
import { matchesGatewayCredentialFamilyProviderBinding } from "../../onboard/gateway-provider-metadata";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import type { SandboxMessagingCredentialBindingPlan, SandboxMessagingPlan } from "../manifest";
import {
  messagingCredentialProviderProfilePath,
  MESSAGING_CREDENTIAL_PROVIDER_TYPE,
} from "../provider-profile";
import type { MessagingCredentialApplyOptions, MessagingCredentialApplyResult } from "./types";
import { filterEnabledPlanEntries } from "./plan-filter";

type MessagingCredentialApplyEntry = MessagingCredentialApplyResult["upserted"][number];
type MessagingCredentialReuseEntry = MessagingCredentialApplyResult["reused"][number];
type MessagingMissingCredentialEntry = MessagingCredentialApplyResult["missing"][number];
type MessagingCredentialBindingLike = Pick<
  SandboxMessagingCredentialBindingPlan,
  "channelId" | "credentialId" | "providerName" | "providerEnvKey"
>;

export async function applyCredentialsAtOpenShell(
  plan: SandboxMessagingPlan,
  options: MessagingCredentialApplyOptions,
): Promise<MessagingCredentialApplyResult> {
  const env = options.env ?? process.env;
  const adapter = options.providerAdapter;
  const target = selectedOpenShellGateway();
  const upserted: MessagingCredentialApplyEntry[] = [];
  const reused: MessagingCredentialReuseEntry[] = [];
  const missing: MessagingMissingCredentialEntry[] = [];
  const activeBindings = filterEnabledPlanEntries(plan, plan.credentialBindings);

  if (activeBindings.length > 0) {
    const profile = await adapter.ensureEndpointlessProviderProfile({
      target,
      profilePath: messagingCredentialProviderProfilePath(REPOSITORY_ROOT),
      profileType: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
      inferenceCapable: false,
    });
    if (!profile.ok) throw profileFailure(profile.error);
  }

  for (const binding of activeBindings) {
    const credential = readCredentialEnv(env, binding.providerEnvKey);
    const observed = await adapter.getProvider({
      target,
      providerName: binding.providerName,
    });
    const providerState = classifyProviderBinding(observed, binding);
    if (providerState === "indeterminate") {
      throw new Error(`Could not inspect messaging provider '${binding.providerName}'.`);
    }
    if (providerState === "collision") {
      throw new Error(
        `Messaging provider '${binding.providerName}' does not match the required endpointless credential binding.`,
      );
    }
    if (!credential) {
      if (providerState === "exact") {
        reused.push(toReuseEntry(binding));
      } else {
        missing.push(toMissingEntry(binding));
      }
      continue;
    }

    const action = providerState === "exact" ? "update" : "create";
    const credentials = [{ name: binding.providerEnvKey, value: credential }];
    const result =
      action === "create"
        ? await adapter.createProvider({
            target,
            name: binding.providerName,
            type: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
            credentials,
            config: [],
            fromExisting: false,
          })
        : await adapter.updateProvider({
            target,
            providerName: binding.providerName,
            credentials,
            config: [],
          });
    if (!result.ok) {
      throw new Error(
        `Failed to ${action} messaging provider '${binding.providerName}': ${result.error.message}`,
      );
    }
    const verification = await adapter.getProvider({
      target,
      providerName: binding.providerName,
    });
    const verified = classifyProviderBinding(verification, binding);
    if (verified !== "exact") {
      throw new Error(
        `OpenShell did not confirm messaging provider '${binding.providerName}' after ${action}.`,
      );
    }
    upserted.push({
      channelId: binding.channelId,
      credentialId: binding.credentialId,
      providerName: binding.providerName,
      envKey: binding.providerEnvKey,
      action,
    });
  }

  const providerNames = uniqueStrings([
    ...upserted.map((entry) => entry.providerName),
    ...reused.map((entry) => entry.providerName),
  ]);

  return {
    upserted,
    reused,
    missing,
    providerNames,
    sandboxCreateProviderArgs: providerNames.flatMap((providerName) => [
      "--provider",
      providerName,
    ]),
  };
}

function readCredentialEnv(env: NodeJS.ProcessEnv, envKey: string): string | null {
  const raw = env[envKey];
  if (typeof raw !== "string") return null;
  const normalized = raw.replace(/\r/g, "").trim();
  return normalized || null;
}

function toReuseEntry(binding: MessagingCredentialBindingLike): MessagingCredentialReuseEntry {
  return {
    channelId: binding.channelId,
    credentialId: binding.credentialId,
    providerName: binding.providerName,
    envKey: binding.providerEnvKey,
  };
}

function toMissingEntry(binding: MessagingCredentialBindingLike): MessagingMissingCredentialEntry {
  return {
    channelId: binding.channelId,
    credentialId: binding.credentialId,
    providerName: binding.providerName,
    envKey: binding.providerEnvKey,
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function profileFailure(error: OpenShellProviderError): Error {
  if (error.kind === "command" && error.reason === "profile_import_failed") {
    return new Error("Could not import the OpenShell messaging credential profile.");
  }
  if (error.kind === "command" && error.reason === "profile_export_failed") {
    return new Error(
      `OpenShell provider profile '${MESSAGING_CREDENTIAL_PROVIDER_TYPE}' could not be exported for validation.`,
    );
  }
  if (error.kind === "command" && error.reason === "profile_incompatible") {
    return new Error(
      `OpenShell provider profile '${MESSAGING_CREDENTIAL_PROVIDER_TYPE}' already exists but does not match NemoClaw's endpointless messaging credential contract.`,
    );
  }
  return new Error(`Could not prepare the OpenShell messaging credential profile: ${error.message}`);
}

function classifyProviderBinding(
  result:
    | Readonly<{ ok: true; value: OpenShellProviderMetadata }>
    | Readonly<{ ok: false; error: OpenShellProviderError }>,
  binding: MessagingCredentialBindingLike,
): "collision" | "exact" | "indeterminate" | "missing" {
  if (!result.ok) {
    return result.error.kind === "command" && result.error.reason === "not_found"
      ? "missing"
      : "indeterminate";
  }
  return matchesGatewayCredentialFamilyProviderBinding(result.value, {
    name: binding.providerName,
    type: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
    credentialKey: binding.providerEnvKey,
  })
    ? "exact"
    : "collision";
}
