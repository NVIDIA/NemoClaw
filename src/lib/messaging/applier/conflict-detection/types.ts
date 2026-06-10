// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxMessagingPlan } from "../../manifest";

export type ProbeResult = "present" | "absent" | "error";
export type ConflictReason = "matching-token" | "unknown-token";

export interface MessagingConflictProbe {
  // Tri-state: "error" is distinct from "absent" so a transient gateway
  // failure does not get collapsed into "provider not attached" and then
  // persisted as bogus empty messagingChannels.
  providerExists: (name: string) => ProbeResult;
}

export interface MessagingConflictProbeGatewayDeps {
  /** Run `openshell sandbox list`; return true if the gateway answered. */
  checkGatewayLiveness: () => boolean;
  /** Check if the named OpenShell provider exists; assumes gateway is alive. */
  providerExists: (name: string) => boolean;
}

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
  readonly messagingChannels?: readonly string[] | null;
  readonly disabledChannels?: readonly string[] | null;
  // OpenShell gateway registration name this sandbox is bound to. Used by the
  // gateway-scoped Slack Socket Mode conflict detection (#4953). A missing name
  // normalizes to the default `nemoclaw` gateway (see slack-socket-mode.ts).
  readonly gatewayName?: string | null;
}

export interface ConflictRegistry {
  listSandboxes: () => {
    sandboxes: ConflictRegistryEntry[];
    defaultSandbox?: string | null;
  };
  updateSandbox: (name: string, updates: { messagingChannels?: string[] }) => boolean;
}
