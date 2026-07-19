// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Process-wide registry of the long-running sub-stage that currently owns
 * onboarding progress output.
 *
 * Some onboarding phases run work that far outlives the decision the phase
 * is named after: in non-interactive onboarding the provider-selection state
 * drives the whole managed vLLM install, so the phase heartbeat kept
 * printing "Still working on Provider selection…" through an hour-long model
 * download and vLLM launch (#7156). Sub-stages register an accurate label
 * here for their lifetime; the heartbeat prints the innermost registered
 * label instead of its own phase label.
 */

const activeEntries: { label: string }[] = [];

/**
 * Record a long-running sub-stage. Returns a release function that must be
 * called exactly once when the sub-stage settles; duplicate releases are
 * ignored so error paths can call it defensively.
 */
export function markPhaseActivity(label: string): () => void {
  const entry = { label };
  activeEntries.push(entry);
  return () => {
    const index = activeEntries.indexOf(entry);
    if (index === -1) return;
    activeEntries.splice(index, 1);
  };
}

/** Innermost registered sub-stage label, or null when none is active. */
export function currentPhaseActivityLabel(): string | null {
  return activeEntries.length > 0 ? activeEntries[activeEntries.length - 1].label : null;
}
