// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function selectManagedListenerPid(
  portKind: string,
  findListenerPid: () => number | null,
): number | null {
  return portKind === "gateway" ? findListenerPid() : null;
}

export function selectGatewayPortCheckOptions<T>(
  portKind: string,
  getOptions: () => T,
): T | undefined {
  return portKind === "gateway" ? getOptions() : undefined;
}

export function acceptManagedListener(
  listenerPid: number | null,
  accept: (pid: number) => void,
): boolean {
  if (listenerPid === null) return false;
  accept(listenerPid);
  return true;
}

export function requireGatewayBinding<T>(binding: T | null): T {
  if (binding === null) throw new Error("Authoritative rebuild preflight has no gateway");
  return binding;
}

export function hasGatewayBinding(binding: unknown): boolean {
  return binding !== null && binding !== undefined;
}

export function clearGatewayEnvironmentWithoutBinding(
  binding: unknown,
  env: NodeJS.ProcessEnv,
): void {
  if (!hasGatewayBinding(binding)) delete env.OPENSHELL_GATEWAY;
}

export function applyGatewayBindingIfPresent<T>(
  binding: T | null | undefined,
  apply: (binding: T) => void,
): void {
  if (binding !== null && binding !== undefined) apply(binding);
}

export function selectResumeSandboxName(
  resume: boolean,
  recordedName: string | null,
  requestedName: string | null,
  checkpointedName: string | null,
): string | null {
  return resume ? (recordedName ?? requestedName ?? checkpointedName) : null;
}

export function readSandboxForGatewayBinding<T>(
  sandboxName: string | null,
  readSandbox: (name: string) => T,
): T | null {
  return sandboxName ? readSandbox(sandboxName) : null;
}

export function restoreGatewayEnvironment(
  env: NodeJS.ProcessEnv,
  previousGateway: string | undefined,
): void {
  if (previousGateway === undefined) delete env.OPENSHELL_GATEWAY;
  else env.OPENSHELL_GATEWAY = previousGateway;
}
