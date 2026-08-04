// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ManagedStartupAgent } from "../../src/lib/onboard/managed-startup/profile.ts";

export const PROTECTED_MANAGED_IMAGE_AGENTS = [
  "openclaw",
  "hermes",
  "langchain-deepagents-code",
] as const satisfies readonly ManagedStartupAgent[];

export const PROTECTED_MANAGED_IMAGE_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;

export type ProtectedManagedImagePlatform = (typeof PROTECTED_MANAGED_IMAGE_PLATFORMS)[number];

export type ProtectedManagedImageContract = {
  readonly agent: ManagedStartupAgent;
  readonly baseReference: string;
  readonly digest: string;
  readonly localContentId: string;
  readonly platform: ProtectedManagedImagePlatform;
  readonly reference: string;
};

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const BASE_REPOSITORIES: Readonly<Record<ManagedStartupAgent, string>> = Object.freeze({
  openclaw: "ghcr.io/nvidia/nemoclaw/sandbox-base",
  hermes: "ghcr.io/nvidia/nemoclaw/hermes-sandbox-base",
  "langchain-deepagents-code": "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
});

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("protected managed-image contract entry must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>): void {
  const actual = Object.keys(value).sort();
  const expected = [
    "agent",
    "baseReference",
    "digest",
    "localContentId",
    "platform",
    "reference",
  ].sort();
  if (actual.some((key, index) => key !== expected[index]) || actual.length !== expected.length) {
    throw new Error("protected managed-image contract entry has unexpected fields");
  }
}

function parseEntry(
  value: unknown,
  expectedPlatform: ProtectedManagedImagePlatform,
): ProtectedManagedImageContract {
  const entry = record(value);
  exactKeys(entry);
  if (
    typeof entry.agent !== "string" ||
    !PROTECTED_MANAGED_IMAGE_AGENTS.includes(entry.agent as ManagedStartupAgent)
  ) {
    throw new Error("protected managed-image contract entry has an invalid agent");
  }
  if (entry.platform !== expectedPlatform) {
    throw new Error("protected managed-image contract entry has the wrong platform");
  }
  if (
    typeof entry.digest !== "string" ||
    !DIGEST_PATTERN.test(entry.digest) ||
    typeof entry.localContentId !== "string" ||
    !DIGEST_PATTERN.test(entry.localContentId)
  ) {
    throw new Error("protected managed-image contract entry has an invalid content identity");
  }
  const expectedRepository = `localhost:5000/nemoclaw-managed-protected/${entry.agent}`;
  if (entry.reference !== `${expectedRepository}@${entry.digest}`) {
    throw new Error("protected managed-image contract entry is not the exact agent digest");
  }
  const basePrefix = `${BASE_REPOSITORIES[entry.agent as ManagedStartupAgent]}@`;
  if (
    typeof entry.baseReference !== "string" ||
    !entry.baseReference.startsWith(basePrefix) ||
    !DIGEST_PATTERN.test(entry.baseReference.slice(basePrefix.length))
  ) {
    throw new Error("protected managed-image contract entry has an invalid base reference");
  }
  return {
    agent: entry.agent as ManagedStartupAgent,
    baseReference: entry.baseReference,
    digest: entry.digest,
    localContentId: entry.localContentId,
    platform: expectedPlatform,
    reference: entry.reference,
  };
}

export function parseProtectedManagedImageContracts(
  value: unknown,
  expectedPlatform: ProtectedManagedImagePlatform,
): ProtectedManagedImageContract[] {
  if (!Array.isArray(value) || value.length !== PROTECTED_MANAGED_IMAGE_AGENTS.length) {
    throw new Error("protected managed-image contract must contain exactly all shipped agents");
  }
  const contracts = value.map((entry) => parseEntry(entry, expectedPlatform));
  const actualAgents = contracts.map(({ agent }) => agent).sort();
  const expectedAgents = [...PROTECTED_MANAGED_IMAGE_AGENTS].sort();
  if (actualAgents.some((agent, index) => agent !== expectedAgents[index])) {
    throw new Error("protected managed-image contract must contain each shipped agent once");
  }
  if (
    new Set(contracts.map(({ reference }) => reference)).size !== contracts.length ||
    new Set(contracts.map(({ localContentId }) => localContentId)).size !== contracts.length
  ) {
    throw new Error("protected managed-image contract must contain unique immutable images");
  }
  return contracts;
}
