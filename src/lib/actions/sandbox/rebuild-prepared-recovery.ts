// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";

import { RD as _RD, R } from "../../cli/terminal-style";
import * as registry from "../../state/registry";
import * as sandboxState from "../../state/sandbox";
import type { RebuildBail } from "./rebuild-credential-preflight";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";

export interface RebuildSandboxExecutionOptions {
  throwOnError?: boolean;
  /** Internal installer recovery input; never exposed as a CLI option. */
  recoveryManifest?: sandboxState.RebuildManifest;
  /** Per-row capability granted only after explicit legacy managed-image confirmation. */
  allowLegacyManagedImageRecovery?: boolean;
}

function failPreparedRecoveryPreDelete(
  detail: string,
  errorMessage: string,
  bail: RebuildBail,
): never {
  console.error("");
  console.error(`  ${_RD}Recovery pre-delete check failed:${R} ${detail}.`);
  console.error("  Sandbox is untouched — no data was lost.");
  return bail(errorMessage);
}

function registryEntryWithoutOpenClawPluginProvenance(
  entry: RebuildSandboxEntry,
): Omit<RebuildSandboxEntry, "openclawImagePluginInstalls"> {
  const { openclawImagePluginInstalls: _provenance, ...rest } = entry;
  return rest;
}

function isPreparedRecoveryImageAllowed(
  manifest: sandboxState.RebuildManifest,
  entry: RebuildSandboxEntry,
  allowLegacyManagedImageRecovery: boolean,
): boolean {
  return (
    sandboxState.hasAuthoritativeOpenClawImagePluginProvenance(manifest) ||
    sandboxState.isManagedImageRecoveryAllowed(entry, allowLegacyManagedImageRecovery)
  );
}

export function validatePreparedRecoveryManifest(
  sandboxName: string,
  sandboxEntry: RebuildSandboxEntry,
  candidate: sandboxState.RebuildManifest | undefined,
  allowLegacyManagedImageRecovery: boolean,
  bail: RebuildBail,
): sandboxState.RebuildManifest | null {
  if (!candidate) return null;
  const validation = sandboxState.validateRebuildRecoveryManifest(
    sandboxName,
    sandboxEntry.agent,
    candidate,
  );
  if (!validation.ok) {
    console.error("");
    console.error(`  ${_RD}Recovery preflight failed:${R} ${validation.reason}.`);
    console.error("  Sandbox is untouched — no data was lost.");
    bail(`Invalid recovery manifest: ${validation.reason}`);
    return null;
  }
  if (
    !isPreparedRecoveryImageAllowed(
      validation.manifest,
      sandboxEntry,
      allowLegacyManagedImageRecovery,
    )
  ) {
    console.error("");
    console.error(
      `  ${_RD}Recovery preflight failed:${R} registry has no NemoClaw-managed image fingerprint.`,
    );
    console.error("  Pre-fingerprint and custom-image sandboxes are not recreated automatically.");
    console.error("  Sandbox is untouched — no data was lost.");
    bail("Recovery registry entry has no NemoClaw-managed image fingerprint.");
    return null;
  }
  return validation.manifest;
}

export function revalidatePreparedRecoveryBeforeDelete(
  sandboxName: string,
  initialEntry: RebuildSandboxEntry,
  candidate: sandboxState.RebuildManifest | null,
  registrySnapshot: registry.SandboxRegistry | null,
  allowLegacyManagedImageRecovery: boolean,
  bail: RebuildBail,
): {
  manifest: sandboxState.RebuildManifest | null;
  registrySnapshot: registry.SandboxRegistry | null;
} {
  if (!candidate) return { manifest: null, registrySnapshot };

  const refreshedRegistrySnapshot = registry.load();
  const currentEntry = refreshedRegistrySnapshot.sandboxes[sandboxName];
  if (!currentEntry) {
    return failPreparedRecoveryPreDelete(
      "registry entry no longer exists",
      "Recovery registry identity changed during preflight.",
      bail,
    );
  }
  const authoritativePluginProvenance =
    sandboxState.hasAuthoritativeOpenClawImagePluginProvenance(candidate);
  const registryConfigurationMatches = authoritativePluginProvenance
    ? isDeepStrictEqual(
        registryEntryWithoutOpenClawPluginProvenance(currentEntry),
        registryEntryWithoutOpenClawPluginProvenance(initialEntry),
      )
    : isDeepStrictEqual(currentEntry, initialEntry);
  if (!registryConfigurationMatches) {
    return failPreparedRecoveryPreDelete(
      "registered sandbox configuration changed during preflight",
      "Recovery registry configuration changed during preflight.",
      bail,
    );
  }

  const latestManifest = sandboxState.getLatestBackup(sandboxName);
  // candidate and latestManifest are two reads of the same prepared backup,
  // enforced by the identity check below. Their plugin IDs are therefore one
  // provenance domain; fresh-vs-previous ownership is validated later by the
  // restore planner after the replacement image has been created.
  if (
    !latestManifest ||
    latestManifest.timestamp !== candidate.timestamp ||
    latestManifest.backupPath !== candidate.backupPath
  ) {
    return failPreparedRecoveryPreDelete(
      "latest prepared backup changed during preflight",
      "Recovery backup identity changed during preflight.",
      bail,
    );
  }

  const validation = sandboxState.validateRebuildRecoveryManifest(
    sandboxName,
    currentEntry.agent,
    latestManifest,
  );
  if (!validation.ok) {
    return failPreparedRecoveryPreDelete(
      validation.reason,
      `Invalid recovery manifest: ${validation.reason}`,
      bail,
    );
  }
  if (
    !isPreparedRecoveryImageAllowed(
      validation.manifest,
      currentEntry,
      allowLegacyManagedImageRecovery,
    )
  ) {
    return failPreparedRecoveryPreDelete(
      "registry no longer has a NemoClaw-managed image fingerprint",
      "Recovery registry entry has no NemoClaw-managed image fingerprint.",
      bail,
    );
  }

  return {
    manifest: validation.manifest,
    registrySnapshot: refreshedRegistrySnapshot,
  };
}
