// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { parseCheckedInProviderProfileContract } from "../../adapters/openshell/provider-profile";
import {
  assertOpenShellPolicyEndpointPins,
  parseOpenShellPolicy,
} from "../../adapters/openshell/policy-boundary";
import { ROOT } from "../../state/paths";
import { nativeProviderLifecycle } from "./index";
import { boundHermesNativeProfile } from "./hermes-profile";
import { boundCustomNativeProfile } from "./custom";
import type { NativeProviderAttachment } from "./contract";
import type { HostedProviderDefinition } from "./hosted";
import {
  hostedNativeProviderForName,
  hostedNativeProviderForAttachment,
} from "./hosted-attachment";

export const NATIVE_HOSTED_INFERENCE_POLICY_KEY = "native_hosted_inference";

/** OpenClaw's attached profile owns canonical custom NVIDIA access for its entire lifetime. */
export function usesAttachedCustomNvidiaPolicy(
  providerName: string | null,
  receipt?: NativeProviderAttachment,
  agentName: string | null = "openclaw",
): boolean {
  const definition = hostedNativeProviderForAttachment(receipt);
  return Boolean(
    agentName === "openclaw" &&
    definition?.providerName === providerName &&
    definition?.custom &&
    definition.endpoint === "https://integrate.api.nvidia.com/v1",
  );
}

export function buildNativeHostedSandboxPolicy(
  basePolicy: string,
  providerName: string,
  receipt?: NativeProviderAttachment,
  agentName: string | null = "openclaw",
): string {
  const definition: HostedProviderDefinition | undefined = receipt
    ? hostedNativeProviderForAttachment(receipt)
    : hostedNativeProviderForName(providerName);
  if (!definition || definition.providerName !== providerName)
    throw new Error("Unknown native hosted inference provider");
  const profile = parseCheckedInProviderProfileContract(
    definition.custom
      ? boundCustomNativeProfile(
          definition,
          nativeProviderLifecycle(definition).nativeProviderProfilePath(),
        )
      : definition.endpointUrl
        ? boundHermesNativeProfile(definition)
        : fs.readFileSync(nativeProviderLifecycle(definition).nativeProviderProfilePath(), "utf8"),
  );
  if (
    !profile ||
    profile.profileId !== definition.profileId ||
    !profile.boundary.inference_capable
  ) {
    throw new Error("The checked-in native hosted provider profile is invalid");
  }
  const policy = { ...parseOpenShellPolicy(basePolicy).policy };
  const entry = {
    name: NATIVE_HOSTED_INFERENCE_POLICY_KEY,
    endpoints: profile.boundary.endpoints,
    binaries: profile.boundary.binaries.map((path) => ({ path })),
  };
  const policies = policy.network_policies ?? {};
  let replacedBundledRule = false;
  if (usesAttachedCustomNvidiaPolicy(providerName, receipt, agentName)) {
    const bundled = parseOpenShellPolicy(
      fs.readFileSync(
        path.join(ROOT, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
        "utf8",
      ),
    ).policy.network_policies?.nvidia;
    // The selected pinned profile supersedes only the unchanged bundled rule.
    // Operator-owned policies retain their authority and must pass admission.
    if (bundled !== undefined && isDeepStrictEqual(policies.nvidia, bundled)) {
      delete policies.nvidia;
      replacedBundledRule = true;
    }
    assertOpenShellPolicyEndpointPins(
      YAML.stringify(policy),
      definition.endpoint,
      definition.allowedIps ?? [],
    );
  }
  const existing = policies[NATIVE_HOSTED_INFERENCE_POLICY_KEY];
  if (existing !== undefined && !isDeepStrictEqual(existing, entry)) {
    throw new Error(
      "The native hosted inference policy conflicts with the selected provider profile",
    );
  }
  if (usesAttachedCustomNvidiaPolicy(providerName, receipt, agentName)) {
    // Sandbox creation attaches the verified profile, including its IP pins.
    // A second base grant would survive detachment and conflict with native NVIDIA.
    delete policies[NATIVE_HOSTED_INFERENCE_POLICY_KEY];
    return replacedBundledRule || existing !== undefined ? YAML.stringify(policy) : basePolicy;
  }
  if (existing !== undefined && !replacedBundledRule) return basePolicy;
  policy.network_policies = { ...policies, [NATIVE_HOSTED_INFERENCE_POLICY_KEY]: entry };
  return YAML.stringify(policy);
}
