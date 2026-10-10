// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { inspectPolicyMutationContext, setPolicyDocument } from "../../policy";
import { parseOpenShellPolicy } from "../../adapters/openshell/policy-boundary";
import { profileFromCustomAttachment, type NativeCustomProviderAttachment } from "./index";

export function buildNativeCustomSandboxPolicy(
  basePolicy: string,
  receipt: NativeCustomProviderAttachment,
): string {
  const parsed = { ...parseOpenShellPolicy(basePolicy).policy };
  const key = "native_custom_inference";
  const entry = nativeCustomPolicyEntry(receipt);
  const existing = parsed.network_policies?.[key];
  if (existing !== undefined && !isDeepStrictEqual(existing, entry)) {
    throw new Error(
      "Native custom inference policy conflicts with the selected endpoint contract.",
    );
  }
  if (existing !== undefined) return basePolicy;
  parsed.network_policies = { ...parsed.network_policies, [key]: entry };
  return YAML.stringify(parsed);
}

function nativeCustomPolicyEntry(receipt: NativeCustomProviderAttachment) {
  const { profile } = profileFromCustomAttachment(receipt);
  return {
    name: "native_custom_inference",
    endpoints: profile.endpoints.map(({ allowed_ips, ...endpoint }) => ({
      ...endpoint,
      ...(allowed_ips.length > 0 ? { allowed_ips } : {}),
    })),
    binaries: profile.binaries.map((path) => ({ path })),
  };
}

/** Replace only the endpoint entry proven by the prior or selected attachment. */
function replaceNativeCustomSandboxPolicy(
  basePolicy: string,
  previous: NativeCustomProviderAttachment | undefined,
  next: NativeCustomProviderAttachment | undefined,
): string {
  const parsed = { ...parseOpenShellPolicy(basePolicy).policy };
  const key = "native_custom_inference";
  const existing = parsed.network_policies?.[key];
  const prior = previous ? nativeCustomPolicyEntry(previous) : undefined;
  const desired = next ? nativeCustomPolicyEntry(next) : undefined;
  if (
    existing !== undefined &&
    !isDeepStrictEqual(existing, prior) &&
    !isDeepStrictEqual(existing, desired)
  )
    throw new Error("Native custom inference policy ownership could not be verified.");
  if (isDeepStrictEqual(existing, desired)) return basePolicy;
  parsed.network_policies = { ...parsed.network_policies };
  if (desired) parsed.network_policies[key] = desired;
  else delete parsed.network_policies[key];
  return YAML.stringify(parsed);
}

/** Verify the live policy change and return an ownership-checked rollback. */
export async function reconcileNativeCustomSandboxPolicy(
  input: {
    sandboxName: string;
    gatewayName: string;
    previous?: NativeCustomProviderAttachment;
    next?: NativeCustomProviderAttachment;
  },
  backend = { inspectPolicyMutationContext, setPolicyDocument },
): Promise<() => Promise<void>> {
  if (
    [input.previous, input.next].some(
      (receipt) => receipt && receipt.sandboxName !== input.sandboxName,
    )
  )
    throw new Error("Native custom inference policy belongs to another sandbox.");
  const apply = async (
    previous: NativeCustomProviderAttachment | undefined,
    next: NativeCustomProviderAttachment | undefined,
  ) => {
    const context = await backend.inspectPolicyMutationContext(
      input.sandboxName,
      "reconcile native custom inference policy",
      input.gatewayName,
    );
    const desired = replaceNativeCustomSandboxPolicy(context.basePolicyDocument, previous, next);
    if (desired === context.basePolicyDocument) return;
    if (
      !(await backend.setPolicyDocument(input.sandboxName, desired, {
        nonFatal: true,
        gatewayName: input.gatewayName,
        context,
        operation: "reconcile native custom inference policy",
      }))
    )
      throw new Error("Native custom inference sandbox policy update is unconfirmed.");
  };
  try {
    await apply(input.previous, input.next);
  } catch {
    try {
      await apply(input.next, input.previous);
    } catch {
      throw new Error(
        "Native custom inference sandbox policy recovery could not be verified. Reconcile the selected sandbox before retrying; provider authority is retained.",
      );
    }
    throw new Error(
      "Native custom inference sandbox policy update failed. The previous policy was verified before returning.",
    );
  }
  return () => apply(input.next, input.previous);
}
