// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isValidName } from "../../name-validation";

const RELEASE_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function legacyForwardRows(output: string | null | undefined, sandboxName: string): string[][] {
  if (!output) return [];
  return output
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .filter((columns) => columns[0] === sandboxName);
}

function legacyForwardPorts(output: string | null | undefined, sandboxName: string): number[] {
  return legacyForwardRows(output, sandboxName)
    .map((columns) => Number(columns[2]))
    .filter((port) => Number.isInteger(port));
}

/**
 * PID column of the exact sandbox+port entry in OpenShell's legacy forward
 * registry: `undefined` when no such row is listed, `null` when the row's PID
 * is unparseable. One lookup answers both "listed" and "which process".
 */
export function legacySandboxForwardPid(
  output: string | null | undefined,
  sandboxName: string,
  port: number,
): number | null | undefined {
  const row = legacyForwardRows(output, sandboxName).find((columns) => Number(columns[2]) === port);
  if (!row) return undefined;
  const pid = Number(row[3]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export interface LegacyForwardMigrationDeps {
  readonly assertAuthority?: (ports: readonly number[]) => void;
  readonly capture: (gatewayName: string) => {
    readonly error?: unknown;
    readonly output?: string | null;
    readonly signal?: NodeJS.Signals | null;
    readonly status?: number | null;
  };
  readonly isReachable: (port: number) => boolean;
  readonly run: (
    gatewayName: string,
    sandboxName: string,
    port: number,
  ) => { readonly status?: number | null };
  readonly sleep?: (milliseconds: number) => void;
}

/** Retire only registered NemoClaw ports from the old OpenShell forward registry. */
export function retireLegacySandboxForwards(
  gatewayName: string,
  sandboxName: string,
  ports: readonly number[],
  deps: LegacyForwardMigrationDeps,
): number {
  if (!/^nemoclaw(?:-[1-9]\d{0,4})?$/u.test(gatewayName) || !isValidName(sandboxName)) {
    throw new Error("Legacy OpenShell forward target is invalid");
  }
  const registeredPorts = new Set(
    ports.filter((port) => Number.isInteger(port) && port >= 1 && port <= 65_535),
  );
  const listed = deps.capture(gatewayName);
  if (listed.error || listed.signal || listed.status !== 0) {
    throw new Error("Cannot enumerate legacy OpenShell forwards during ForwardTcp migration");
  }
  const legacyPorts = [
    ...new Set(
      legacyForwardPorts(listed.output, sandboxName).filter((port) => registeredPorts.has(port)),
    ),
  ];
  if (legacyPorts.length > 0) deps.assertAuthority?.(legacyPorts);
  for (const port of legacyPorts) {
    if (deps.run(gatewayName, sandboxName, port).status !== 0) {
      throw new Error(`Legacy OpenShell forward ${String(port)} could not be retired`);
    }
    const deadline = Date.now() + RELEASE_TIMEOUT_MS;
    while (deps.isReachable(port) && Date.now() < deadline) {
      (deps.sleep ?? ((milliseconds) => Atomics.wait(sleepBuffer, 0, 0, milliseconds)))(
        POLL_INTERVAL_MS,
      );
    }
    if (deps.isReachable(port)) {
      throw new Error(`Legacy OpenShell forward ${String(port)} did not release its host port`);
    }
  }
  return legacyPorts.length;
}
