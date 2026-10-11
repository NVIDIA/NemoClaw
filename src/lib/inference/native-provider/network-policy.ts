// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { parseCheckedInProviderProfileContract } from "../../adapters/openshell/provider-profile";
import { parseOpenShellPolicy } from "../../adapters/openshell/policy-boundary";
import { nativeProviderLifecycle } from "./index";
import { boundHermesNativeProfile } from "./hermes-profile";
import type { NativeProviderAttachment } from "./contract";
import type { HostedProviderDefinition } from "./hosted";
import {
  hostedNativeProviderForName,
  hostedNativeProviderForAttachment,
} from "./hosted-attachment";

export const NATIVE_HOSTED_INFERENCE_POLICY_KEY = "native_hosted_inference";

export function buildNativeHostedSandboxPolicy(
  basePolicy: string,
  providerName: string,
  receipt?: NativeProviderAttachment,
): string {
  const definition: HostedProviderDefinition | undefined = receipt
    ? hostedNativeProviderForAttachment(receipt)
    : hostedNativeProviderForName(providerName);
  if (!definition || definition.providerName !== providerName)
    throw new Error("Unknown native hosted inference provider");
  const profile = parseCheckedInProviderProfileContract(
    definition.endpointUrl
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
  const existing = policies[NATIVE_HOSTED_INFERENCE_POLICY_KEY];
  if (existing !== undefined && !isDeepStrictEqual(existing, entry)) {
    throw new Error(
      "The native hosted inference policy conflicts with the selected provider profile",
    );
  }
  if (existing !== undefined) return basePolicy;
  policy.network_policies = { ...policies, [NATIVE_HOSTED_INFERENCE_POLICY_KEY]: entry };
  return YAML.stringify(policy);
}
