// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../../manifest";

export type ConflictReason = "matching-token" | "unknown-token";

export interface ConflictRequest {
  readonly channel: string;
  readonly credentialHashes?: Record<string, string | null | undefined>;
}

export interface ConflictMatch {
  readonly channel: string;
  readonly sandbox: string;
  readonly reason: ConflictReason;
}

export type ChannelConflictRequest =
  | string
  | { channel: string; credentialHashes?: Record<string, string | null | undefined> };

/**
 * Minimal shape of a registry entry that conflict detection needs.
 * Satisfied by `SandboxEntry` from `./state/registry`.
 */
export interface ConflictRegistryEntry {
  readonly name: string;
  readonly messaging?: { readonly plan: SandboxMessagingPlan } | null;
}

export interface ConflictRegistry {
  listSandboxes: () => {
    sandboxes: ConflictRegistryEntry[];
    defaultSandbox?: string | null;
  };
}
