// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { inspectGatewayCredentialOnlyProviderBinding } from "../../onboard/gateway-provider-metadata";
import { REPOSITORY_ROOT } from "../../core/repository-root";
import { redact } from "../../security/redact";
import type { SandboxMessagingCredentialBindingPlan, SandboxMessagingPlan } from "../manifest";
import {
  ensureMessagingCredentialProviderProfile,
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

export function applyCredentialsAtOpenShell(
  plan: SandboxMessagingPlan,
  options: MessagingCredentialApplyOptions,
): MessagingCredentialApplyResult {
  const env = options.env ?? process.env;
  const runOpenshell = options.runOpenshell;
  const upserted: MessagingCredentialApplyEntry[] = [];
  const reused: MessagingCredentialReuseEntry[] = [];
  const missing: MessagingMissingCredentialEntry[] = [];
  const activeBindings = filterEnabledPlanEntries(plan, plan.credentialBindings);

  if (activeBindings.length > 0) {
    ensureMessagingCredentialProviderProfile({
      root: REPOSITORY_ROOT,
      runOpenshell: (args, runOptions) => runOpenshell(args, runOptions),
    });
  }

  for (const binding of activeBindings) {
    const credential = readCredentialEnv(env, binding.providerEnvKey);
    const providerState = inspectGatewayCredentialOnlyProviderBinding(
      {
        name: binding.providerName,
        type: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
        credentialKey: binding.providerEnvKey,
      },
      runOpenshell,
    );
    if (providerState.kind === "indeterminate") {
      throw new Error(`Could not inspect messaging provider '${binding.providerName}'.`);
    }
    if (providerState.kind === "collision") {
      throw new Error(
        `Messaging provider '${binding.providerName}' does not match the required endpointless credential binding.`,
      );
    }
    if (!credential) {
      if (providerState.kind === "exact") {
        reused.push(toReuseEntry(binding));
      } else {
        missing.push(toMissingEntry(binding));
      }
      continue;
    }

    const action = providerState.kind === "exact" ? "update" : "create";
    const result = runOpenshell(
      buildProviderArgs(action, binding.providerName, binding.providerEnvKey),
      {
        ignoreError: true,
        env: { [binding.providerEnvKey]: credential },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.status !== 0) {
      throw new Error(
        `Failed to ${action} messaging provider '${binding.providerName}': ${compactOutput(result)}`,
      );
    }
    const verified = inspectGatewayCredentialOnlyProviderBinding(
      {
        name: binding.providerName,
        type: MESSAGING_CREDENTIAL_PROVIDER_TYPE,
        credentialKey: binding.providerEnvKey,
      },
      runOpenshell,
    );
    if (verified.kind !== "exact") {
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

function buildProviderArgs(
  action: "create" | "update",
  providerName: string,
  credentialEnv: string,
): string[] {
  return action === "create"
    ? [
        "provider",
        "create",
        "--name",
        providerName,
        "--type",
        MESSAGING_CREDENTIAL_PROVIDER_TYPE,
        "--credential",
        credentialEnv,
      ]
    : ["provider", "update", providerName, "--credential", credentialEnv];
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

function compactOutput(result: { readonly stdout?: unknown; readonly stderr?: unknown }): string {
  const output = redact(`${String(result.stderr ?? "")}${String(result.stdout ?? "")}`)
    .replace(/\r/g, "")
    .trim();
  return output || "OpenShell command failed.";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
