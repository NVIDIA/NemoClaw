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

export type LegacySandboxForwardRow = {
  /** PID column, or `null` when it is unparseable. */
  pid: number | null;
  /** STATUS column as OpenShell prints it, for example `running` or `dead`. */
  status: string;
};

/**
 * The exact sandbox+port entry in OpenShell's legacy forward registry, or
 * `undefined` when no such row is listed. One lookup answers "listed", "which
 * process", and "does OpenShell still consider it running".
 */
export function legacySandboxForwardRow(
  output: string | null | undefined,
  sandboxName: string,
  port: number,
): LegacySandboxForwardRow | undefined {
  const row = legacyForwardRows(output, sandboxName).find((columns) => Number(columns[2]) === port);
  if (!row) return undefined;
  const pid = Number(row[3]);
  return { pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null, status: row[4] ?? "" };
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
