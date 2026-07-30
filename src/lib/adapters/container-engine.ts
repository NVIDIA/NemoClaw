// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host container-engine command selected for the current operation.
 *
 * The existing Docker adapter surface is intentionally retained for callers
 * while this command seam keeps the executable, endpoint, argument
 * translation, and authority proof runtime-pluggable. Docker remains the
 * default. Native Podman onboarding installs a scoped override and restores it
 * when the onboarding transaction ends.
 */
export interface HostContainerEngineCommand {
  readonly driverName: string;
  readonly executable: string;
  readonly prefixArgs?: readonly string[];
  /** OCI architecture proved by the selected runtime, when runtime-owned. */
  readonly runtimeArchitecture?: "amd64" | "arm64";
  /** Exact sandbox network used for host-service route probes. */
  readonly sandboxNetworkName?: string;
  /** Runtime-native target accepted by `--add-host <name>:<target>`. */
  readonly hostGatewayTarget?: string;
  readonly assertAuthority?: () => void;
  readonly translateArgs?: (args: readonly string[]) => readonly string[];
}

const DEFAULT_DOCKER_COMMAND: HostContainerEngineCommand = Object.freeze({
  driverName: "docker",
  executable: "docker",
});

let activeCommand: HostContainerEngineCommand = DEFAULT_DOCKER_COMMAND;

function safeCommandToken(value: string, label: string): string {
  if (!value || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new Error(`${label} must be a non-empty command token`);
  }
  return value;
}

function validateCommand(command: HostContainerEngineCommand): HostContainerEngineCommand {
  safeCommandToken(command.driverName, "Container-engine driver name");
  safeCommandToken(command.executable, "Container-engine executable");
  const prefixArgs = [...(command.prefixArgs ?? [])];
  for (const [index, value] of prefixArgs.entries()) {
    safeCommandToken(value, `Container-engine prefix argument ${String(index)}`);
  }
  if (command.sandboxNetworkName !== undefined) {
    safeCommandToken(command.sandboxNetworkName, "Container-engine sandbox network name");
  }
  if (command.hostGatewayTarget !== undefined) {
    safeCommandToken(command.hostGatewayTarget, "Container-engine host-gateway target");
  }
  return Object.freeze({
    ...command,
    ...(prefixArgs.length > 0 ? { prefixArgs: Object.freeze(prefixArgs) } : {}),
  });
}

export function currentHostContainerEngineCommand(): HostContainerEngineCommand {
  return activeCommand;
}

export function hostContainerEngineDisplayName(): string {
  return activeCommand.driverName === "podman" ? "Podman" : "Docker";
}

export function hostContainerEngineExecutable(): string {
  return activeCommand.executable;
}

export function hostContainerEngineArgv(args: readonly string[]): string[] {
  const command = activeCommand;
  command.assertAuthority?.();
  const translated = command.translateArgs?.(args) ?? args;
  return [
    safeCommandToken(command.executable, "Container-engine executable"),
    ...(command.prefixArgs ?? []).map((value, index) =>
      safeCommandToken(value, `Container-engine prefix argument ${String(index)}`),
    ),
    ...translated.map((value, index) =>
      safeCommandToken(String(value), `Container-engine argument ${String(index)}`),
    ),
  ];
}

/**
 * Install one process-scoped command override and return an exact restoration
 * closure. NemoClaw's CLI executes one onboarding transaction per process, so
 * the override cannot cross concurrent user requests; tests restore it in
 * `finally`/`afterEach`.
 */
export function configureHostContainerEngine(command: HostContainerEngineCommand): () => void {
  const previous = activeCommand;
  activeCommand = validateCommand(command);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    activeCommand = previous;
  };
}

export function resetHostContainerEngineForTests(): void {
  activeCommand = DEFAULT_DOCKER_COMMAND;
}
