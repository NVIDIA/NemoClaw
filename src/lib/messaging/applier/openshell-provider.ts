// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redact } from "../../security/redact";
import type { SandboxMessagingCredentialBindingPlan, SandboxMessagingPlan } from "../manifest";
import type {
  MessagingCredentialApplyOptions,
  MessagingCredentialApplyResult,
  MessagingOpenShellRunner,
} from "./types";
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

  for (const binding of filterEnabledPlanEntries(plan, plan.credentialBindings)) {
    const credential = readCredentialEnv(env, binding.providerEnvKey);
    if (!credential) {
      if (providerExistsInGateway(binding.providerName, runOpenshell)) {
        reused.push(toReuseEntry(binding));
      } else {
        missing.push(toMissingEntry(binding));
      }
      continue;
    }

    const action = providerExistsInGateway(binding.providerName, runOpenshell)
      ? "update"
      : "create";
    const result = runOpenshell(
      buildProviderArgs(action, binding.providerName, binding.providerEnvKey),
      {
        ignoreError: true,
        env: { [binding.providerEnvKey]: credential },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const status = result.status ?? 0;
    if (status !== 0) {
      throw new Error(
        `Failed to ${action} messaging provider '${binding.providerName}': ${compactOutput(result)}`,
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

function providerExistsInGateway(
  providerName: string,
  runOpenshell: MessagingOpenShellRunner,
): boolean {
  const result = runOpenshell(["provider", "get", providerName], {
    ignoreError: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return (result.status ?? 0) === 0;
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
        "generic",
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
