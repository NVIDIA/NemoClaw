// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { PROVIDER_SUFFIXES } from "./manifest-metadata";
import type {
  ConflictRegistry,
  ConflictRegistryEntry,
  MessagingConflictProbe,
  ProbeResult,
} from "./types";

/**
 * For pre-plan entries missing `messagingChannels`, probe OpenShell to infer
 * which channels the sandbox was onboarded with. Plan-backed entries are
 * skipped even when the flat legacy field is absent. Probe errors abort the
 * write for that sandbox so future calls can retry.
 */
export function backfillLegacyEntryChannels(
  entries: readonly ConflictRegistryEntry[],
  probe: MessagingConflictProbe,
  updateEntry: (name: string, channels: string[]) => void,
  providerSuffixes: Record<string, string[]>,
): void {
  for (const entry of entries) {
    if (entry.messaging?.plan || Array.isArray(entry.messagingChannels)) continue;
    const discovered: string[] = [];
    let probeFailed = false;
    for (const channel of Object.keys(providerSuffixes)) {
      let channelPresent = false;
      for (const suffix of providerSuffixes[channel]) {
        let state: ProbeResult;
        try {
          state = probe.providerExists(`${entry.name}${suffix}`);
        } catch {
          state = "error";
        }
        if (state === "present") {
          channelPresent = true;
          break;
        }
        if (state === "error") {
          probeFailed = true;
          break;
        }
      }
      if (probeFailed) break;
      if (channelPresent) discovered.push(channel);
    }
    if (!probeFailed) {
      updateEntry(entry.name, discovered);
    }
  }
}

/**
 * Backfill pre-plan registry entries using built-in manifest provider names.
 * This infers channel presence only; it must not restore legacy credential
 * hashes. Remove with the `messagingChannels`/`disabledChannels` fallback once
 * pre-plan registry rows are no longer supported.
 */
export function backfillMessagingChannels(
  registry: ConflictRegistry,
  probe: MessagingConflictProbe,
): void {
  const { sandboxes } = registry.listSandboxes();
  backfillLegacyEntryChannels(
    sandboxes,
    probe,
    (name, channels) => {
      registry.updateSandbox(name, { messagingChannels: channels });
    },
    PROVIDER_SUFFIXES,
  );
}
