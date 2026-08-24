// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { assertExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/index.ts";
import {
  HERMES_REBUILD_SWAP_BYTES,
  needsHermesRebuildSwap,
  parseActiveSwapBytes,
} from "../fixtures/hermes-rebuild-swap.ts";

const HERMES_REBUILD_SWAP_FILE = "/mnt/nemoclaw-hermes-rebuild.swap";

async function createHermesRebuildSwap(host: HostCliClient): Promise<boolean> {
  const githubActions = process.env.GITHUB_ACTIONS === "true";
  if (!githubActions) return false;

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
  assertExitZero(current, "inspect active swap before Hermes rebuild");
  if (
    !needsHermesRebuildSwap({
      activeSwapBytes: parseActiveSwapBytes(current.stdout),
      githubActions,
    })
  ) {
    return false;
  }

  const provision = await host.command(
    "sudo",
    [
      "bash",
      "-c",
      `set -euo pipefail
swap_file="$1"
swap_size_bytes="$2"
if test -e "$swap_file"; then
  printf 'refusing to replace existing swap path: %s\n' "$swap_file" >&2
  exit 1
fi
cleanup_failed_provision() {
  status=$?
  trap - EXIT
  if ((status != 0)); then
    swapoff "$swap_file" >/dev/null 2>&1 || true
    rm -f -- "$swap_file" || true
  fi
  exit "$status"
}
trap cleanup_failed_provision EXIT
fallocate -l "$swap_size_bytes" "$swap_file"
chmod 0600 "$swap_file"
mkswap "$swap_file"
swapon "$swap_file"
trap - EXIT`,
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
  assertExitZero(provision, "provision swap for Hermes rebuild");
  return true;
}

async function verifyHermesRebuildSwap(host: HostCliClient): Promise<void> {
  const verified = await host.command(
    "swapon",
    ["--show", "--bytes", "--noheadings", "--output", "SIZE"],
    {
      artifactName: "prereq-hermes-rebuild-swap-after",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  assertExitZero(verified, "inspect active swap after Hermes rebuild provisioning");
  if (parseActiveSwapBytes(verified.stdout) < HERMES_REBUILD_SWAP_BYTES) {
    throw new Error("Hermes rebuild swap remains below the required capacity after provisioning");
  }
}

async function cleanupHermesRebuildSwap(host: HostCliClient): Promise<void> {
  const result = await host.command(
    "sudo",
    [
      "bash",
      "-c",
      `set -euo pipefail
swap_file="$1"
status=0
swapoff "$swap_file" || status=$?
rm -f -- "$swap_file" || status=$?
test ! -e "$swap_file" || status=1
if swapon --show --noheadings --output NAME | grep -Fqx -- "$swap_file"; then
  status=1
fi
exit "$status"`,
      "hermes-rebuild-swap-cleanup",
      HERMES_REBUILD_SWAP_FILE,
    ],
    {
      artifactName: "cleanup-hermes-rebuild-swap",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 2 * 60_000,
    },
  );
  assertExitZero(result, "remove Hermes rebuild swap");
}

export async function prepareHermesRebuildSwap(
  host: HostCliClient,
  cleanup: Pick<CleanupRegistry, "trackDisposable">,
): Promise<void> {
  const created = await createHermesRebuildSwap(host);
  if (!created) return;
  cleanup.trackDisposable("remove Hermes rebuild swap", () => cleanupHermesRebuildSwap(host));
  await verifyHermesRebuildSwap(host);
}
