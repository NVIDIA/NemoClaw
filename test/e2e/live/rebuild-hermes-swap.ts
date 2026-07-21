// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero as expectExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/index.ts";
import { expect } from "../fixtures/e2e-test.ts";
import {
  HERMES_REBUILD_SWAP_BYTES,
  needsHermesRebuildSwap,
  parseActiveSwapBytes,
} from "../fixtures/hermes-rebuild-swap.ts";

const HERMES_REBUILD_SWAP_FILE = "/mnt/nemoclaw-hermes-rebuild.swap";

export async function ensureHermesRebuildSwap(host: HostCliClient): Promise<void> {
  const githubActions = process.env.GITHUB_ACTIONS === "true";
  if (!githubActions) return;

  const probeOptions = {
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  };
  const current = await host.command(
    "swapon",
    ["--show", "--bytes", "--noheadings", "--output", "SIZE"],
    {
      ...probeOptions,
      artifactName: "prereq-hermes-rebuild-swap-before",
    },
  );
  expectExitZero(current, "inspect active swap before Hermes rebuild");
  if (
    !needsHermesRebuildSwap({
      activeSwapBytes: parseActiveSwapBytes(current.stdout),
      githubActions,
    })
  ) {
    return;
  }

  const provision = await host.command(
    "sudo",
    [
      "bash",
      "-c",
      `set -euo pipefail
swap_file="$1"
swap_size_bytes="$2"
swapoff "$swap_file" 2>/dev/null || true
rm -f "$swap_file"
fallocate -l "$swap_size_bytes" "$swap_file"
chmod 0600 "$swap_file"
mkswap "$swap_file"
swapon "$swap_file"`,
      "hermes-rebuild-swap",
      HERMES_REBUILD_SWAP_FILE,
      String(HERMES_REBUILD_SWAP_BYTES),
    ],
    {
      ...probeOptions,
      artifactName: "prereq-hermes-rebuild-swap-provision",
      timeoutMs: 2 * 60_000,
    },
  );
  expectExitZero(provision, "provision swap for Hermes rebuild");

  const verified = await host.command(
    "swapon",
    ["--show", "--bytes", "--noheadings", "--output", "SIZE"],
    {
      ...probeOptions,
      artifactName: "prereq-hermes-rebuild-swap-after",
    },
  );
  expectExitZero(verified, "inspect active swap after Hermes rebuild provisioning");
  expect(parseActiveSwapBytes(verified.stdout)).toBeGreaterThanOrEqual(HERMES_REBUILD_SWAP_BYTES);
}
