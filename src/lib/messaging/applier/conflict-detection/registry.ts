// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../../manifest";
import { detectAllOverlapsInEntries, findConflictsInEntries } from "./entries";
import { planToConflictChannelRequests } from "./plan";
import type {
  ChannelConflictRequest,
  ConflictMatch,
  ConflictReason,
  ConflictRegistry,
  ConflictRequest,
} from "./types";

function normalizeRequest(request: ChannelConflictRequest): ConflictRequest | null {
  if (typeof request === "string") {
    return request ? { channel: request, credentialHashes: {} } : null;
  }
  if (!request || typeof request.channel !== "string" || request.channel.length === 0) return null;
  return request;
}

/**
 * Registry-backed conflict lookup for callers that do not already have a
 * compiled plan request list.
 */
export function findChannelConflicts(
  currentSandbox: string | null,
  enabledChannels: ChannelConflictRequest[],
  registry: ConflictRegistry,
): ConflictMatch[] {
  if (!Array.isArray(enabledChannels) || enabledChannels.length === 0) return [];
  const requests = enabledChannels
    .map(normalizeRequest)
    .filter((request): request is ConflictRequest => request !== null);
  if (requests.length === 0) return [];
  const { sandboxes } = registry.listSandboxes();
  return findConflictsInEntries(currentSandbox, requests, sandboxes);
}

/**
 * Plan-driven variant of `findChannelConflicts`. Derives the channel request
 * list from a compiled `SandboxMessagingPlan`.
 */
export function findChannelConflictsFromPlan(
  currentSandbox: string | null,
  plan: SandboxMessagingPlan,
  registry: ConflictRegistry,
): ConflictMatch[] {
  return findChannelConflicts(currentSandbox, planToConflictChannelRequests(plan), registry);
}

/**
 * Registry-backed overlap lookup used by status.
 */
export function findAllOverlaps(
  registry: ConflictRegistry,
): Array<{ channel: string; sandboxes: [string, string]; reason: ConflictReason }> {
  const { sandboxes } = registry.listSandboxes();
  return detectAllOverlapsInEntries(sandboxes);
}
