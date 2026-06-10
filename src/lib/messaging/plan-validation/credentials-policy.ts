// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  SandboxMessagingCredentialBindingPlan,
  SandboxMessagingNetworkPolicyEntryPlan,
  SandboxMessagingPlan,
} from "../manifest";
import { assertBoolean, assertRecord, assertString, assertStringArray, fail } from "./assertions";
import {
  credentialBindingMatches,
  networkPolicyEntryMatches,
  normalizePolicyPreset,
  policyEntriesForManifest,
  requirePlanManifest,
} from "./manifest-matchers";
import type { PlanManifestMap } from "./types";

export function validateCredentialBindings(
  plan: SandboxMessagingPlan,
  manifests: PlanManifestMap,
): void {
  plan.credentialBindings.forEach((binding, index) => {
    const path = `$.credentialBindings[${index}]`;
    assertCredentialBindingShape(binding, path);
    const manifest = requirePlanManifest(manifests, binding.channelId, `${path}.channelId`);
    const expected = manifest.credentials.find((credential) =>
      credentialBindingMatches(plan, binding, credential),
    );
    if (!expected) fail(path, "credential binding is not declared by the channel manifest");
  });
}

export function validateNetworkPolicy(
  plan: SandboxMessagingPlan,
  manifests: PlanManifestMap,
): void {
  const allowedPresets = new Set(
    Array.from(manifests.values()).flatMap((manifest) =>
      (manifest.policyPresets ?? []).map((preset) => normalizePolicyPreset(preset).name),
    ),
  );
  plan.networkPolicy.presets.forEach((preset, index) => {
    const path = `$.networkPolicy.presets[${index}]`;
    assertString(preset, path);
    if (!allowedPresets.has(preset)) fail(path, "policy preset is not declared by a plan channel");
  });

  plan.networkPolicy.entries.forEach((entry, index) => {
    const path = `$.networkPolicy.entries[${index}]`;
    assertNetworkPolicyEntryShape(entry, path);
    const manifest = requirePlanManifest(manifests, entry.channelId, `${path}.channelId`);
    const expected = policyEntriesForManifest(manifest, plan.agent).find((candidate) =>
      networkPolicyEntryMatches(entry, candidate),
    );
    if (!expected) fail(path, "policy entry is not declared by the channel manifest");
  });
}

function assertCredentialBindingShape(
  binding: unknown,
  path: string,
): asserts binding is SandboxMessagingCredentialBindingPlan {
  const record = assertRecord(binding, path);
  assertString(record.channelId, `${path}.channelId`);
  assertString(record.credentialId, `${path}.credentialId`);
  assertString(record.sourceInput, `${path}.sourceInput`);
  assertString(record.providerName, `${path}.providerName`);
  assertString(record.providerEnvKey, `${path}.providerEnvKey`);
  assertString(record.placeholder, `${path}.placeholder`);
  assertBoolean(record.credentialAvailable, `${path}.credentialAvailable`);
  if (record.credentialHash !== undefined)
    assertString(record.credentialHash, `${path}.credentialHash`);
}

function assertNetworkPolicyEntryShape(
  entry: unknown,
  path: string,
): asserts entry is SandboxMessagingNetworkPolicyEntryPlan {
  const record = assertRecord(entry, path);
  assertString(record.channelId, `${path}.channelId`);
  assertString(record.presetName, `${path}.presetName`);
  assertStringArray(record.policyKeys, `${path}.policyKeys`);
  if (record.source !== "agent-alias" && record.source !== "manifest") {
    fail(`${path}.source`, "expected manifest or agent-alias");
  }
}
