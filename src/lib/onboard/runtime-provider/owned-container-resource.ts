// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  RuntimeProviderCommandCapture,
  RuntimeProviderOwnedContainerCleanupOptions,
  RuntimeProviderOwnedContainerCleanupResult,
  RuntimeProviderOwnedContainerResource,
} from "./contract";

const CONTAINER_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;
const OWNERSHIP_LABEL = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;
const OWNERSHIP_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const FULL_CONTAINER_ID = /^[a-f0-9]{64}$/u;
const CLEANUP_DEFAULT_TIMEOUT_MS = 15_000;
const CLEANUP_OBSERVATION_INTERVAL_MS = 100;
const cleanupWaitArray = new Int32Array(new SharedArrayBuffer(4));

function waitForCleanupObservation(milliseconds: number): void {
  Atomics.wait(cleanupWaitArray, 0, 0, milliseconds);
}

function validateOwnedContainerResource(resource: RuntimeProviderOwnedContainerResource): void {
  if (!CONTAINER_NAME.test(resource.name)) {
    throw new Error("Provider-owned container name is invalid.");
  }
  if (!OWNERSHIP_LABEL.test(resource.ownership.label)) {
    throw new Error("Provider-owned container label is invalid.");
  }
  if (!OWNERSHIP_VALUE.test(resource.ownership.value)) {
    throw new Error("Provider-owned container label value is invalid.");
  }
}

export function ownedContainerRunArguments(
  resource: RuntimeProviderOwnedContainerResource,
): readonly string[] {
  validateOwnedContainerResource(resource);
  return [
    "--name",
    resource.name,
    "--label",
    `${resource.ownership.label}=${resource.ownership.value}`,
  ];
}

/** Discover by name plus ownership label, then remove only the immutable full ID. */
export function cleanupOwnedContainer(
  resource: RuntimeProviderOwnedContainerResource,
  exactNameFilter: string,
  capture: (args: readonly string[], timeoutMs?: number) => RuntimeProviderCommandCapture,
  options: RuntimeProviderOwnedContainerCleanupOptions,
): RuntimeProviderOwnedContainerCleanupResult {
  validateOwnedContainerResource(resource);
  const deadline = performance.now() + (options.timeoutMs ?? CLEANUP_DEFAULT_TIMEOUT_MS);
  for (;;) {
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs <= 0) return { status: "absent" };
    const discovery = capture(
      [
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        `name=${exactNameFilter}`,
        "--filter",
        `label=${resource.ownership.label}=${resource.ownership.value}`,
        "--format",
        "{{.ID}}\t{{.Names}}",
      ],
      remainingMs,
    );
    if (discovery.status !== 0) return { status: "failed" };
    const rows = discovery.stdout.trim() ? discovery.stdout.trim().split(/\r?\n/u) : [];
    if (rows.length === 0 && options.observation === "immediate") return { status: "absent" };
    if (rows.length > 0) {
      const fields = rows.length === 1 ? rows[0]!.split("\t") : [];
      const [containerId, observedName] = fields;
      if (
        fields.length !== 2 ||
        observedName !== resource.name ||
        !FULL_CONTAINER_ID.test(containerId ?? "")
      ) {
        return { status: "failed" };
      }
      return capture(
        ["rm", "-f", containerId!],
        Math.max(1, Math.floor(deadline - performance.now())),
      ).status === 0
        ? { status: "removed" }
        : { status: "failed" };
    }
    const observationRemainingMs = Math.floor(deadline - performance.now());
    if (observationRemainingMs <= 0) return { status: "absent" };
    waitForCleanupObservation(Math.min(CLEANUP_OBSERVATION_INTERVAL_MS, observationRemainingMs));
  }
}
