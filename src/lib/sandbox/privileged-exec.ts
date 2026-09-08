// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  RuntimeProviderPrivilegedSandboxCommandResult,
  RuntimeProviderPrivilegedSandboxControl,
  RuntimeProviderPrivilegedSandboxTarget,
  RuntimeProviderStoppedSandboxStateCleanupResult,
} from "../onboard/runtime-provider/contract";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "../onboard/runtime-provider/current";
import {
  DirectSandboxFallbackUnavailableError,
  PinnedSandboxResourceIdentityChangedError,
} from "../onboard/runtime-provider/privileged-sandbox-control-errors";
import { requireRuntimeProviderBundleForSandbox } from "../onboard/runtime-provider/selection";
import {
  buildStoppedSandboxChannelCleanupScript,
  validateStoppedSandboxStatePaths,
} from "../onboard/runtime-provider/stopped-sandbox-state-cleanup";
import * as registry from "../state/registry";

type SandboxEntry = import("../state/registry").SandboxEntry;

export interface PrivilegedSandboxCommandOptions {
  readonly input?: string | Buffer;
  readonly sanitizeEnvironment?: boolean;
  readonly expectedResourceHandle?: string;
  readonly timeout?: number;
  readonly maxOutputBytes?: number;
}

const DEFAULT_PRIVILEGED_SANDBOX_COMMAND_TIMEOUT_MS = 15_000;

function readSandboxEntry(sandboxName: string): SandboxEntry {
  const entry = registry.getSandbox?.(sandboxName) ?? null;
  if (entry) return entry;
  throw new Error(
    `No NemoClaw registry entry found for '${sandboxName}'; ` +
      "refusing privileged exec without a registered sandbox owner.",
  );
}

function privilegedSandboxControl(sandboxName: string): {
  readonly sandbox: SandboxEntry;
  readonly control: RuntimeProviderPrivilegedSandboxControl;
} {
  const sandbox = readSandboxEntry(sandboxName);
  const provider = requireRuntimeProviderBundleForSandbox(
    sandbox,
    CURRENT_RUNTIME_PROVIDER_BUNDLES,
  );
  if (provider.lifecycle.supported !== true) {
    throw new Error(
      `Runtime provider '${provider.identity.id}' does not support privileged sandbox control.`,
    );
  }
  return { sandbox, control: provider.lifecycle.privilegedSandboxControl };
}

function registeredSandboxNames(sandboxName: string): readonly string[] {
  const names = new Set<string>([sandboxName]);
  const listed = registry.listSandboxes?.();
  if (Array.isArray(listed?.sandboxes)) {
    for (const entry of listed.sandboxes) {
      if (typeof entry.name === "string" && entry.name) names.add(entry.name);
    }
  }
  return Array.from(names).sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
}

/** Preserve the provider-wide callback boundary after retirement of the mutation fence. */
export function withPrivilegedSandboxExecutionLease<T>(
  _sandboxName: string,
  _operation: string,
  fn: () => T,
): T {
  return fn();
}

export function resolvePrivilegedSandboxTarget(
  sandboxName: string,
): RuntimeProviderPrivilegedSandboxTarget {
  const { sandbox, control } = privilegedSandboxControl(sandboxName);
  return control.resolveTarget({
    registeredSandboxNames: registeredSandboxNames(sandboxName),
    sandbox,
    sandboxName,
  });
}

/** Retained name for Docker compatibility code that only needs an opaque runtime handle. */
export function resolveDirectSandboxContainer(sandboxName: string, _driver: string | null): string {
  return resolvePrivilegedSandboxTarget(sandboxName).resourceHandle;
}

export function executePrivilegedSandboxCommand(
  sandboxName: string,
  command: readonly string[],
  options: PrivilegedSandboxCommandOptions = {},
): RuntimeProviderPrivilegedSandboxCommandResult {
  const { sandbox, control } = privilegedSandboxControl(sandboxName);
  const input =
    options.input === undefined
      ? undefined
      : Buffer.isBuffer(options.input)
        ? Buffer.from(options.input)
        : Buffer.from(options.input, "utf8");
  return control.execute({
    registeredSandboxNames: registeredSandboxNames(sandboxName),
    sandbox,
    sandboxName,
    command,
    sanitizeEnvironment: options.sanitizeEnvironment === true,
    timeoutMs: options.timeout ?? DEFAULT_PRIVILEGED_SANDBOX_COMMAND_TIMEOUT_MS,
    ...(input ? { input } : {}),
    ...(options.expectedResourceHandle !== undefined
      ? { expectedResourceHandle: options.expectedResourceHandle }
      : {}),
    ...(options.maxOutputBytes ? { maxOutputBytes: options.maxOutputBytes } : {}),
  });
}

/** Retained Docker CLI compatibility for portable and Docker-specific probes. */
export function privilegedSandboxExecArgv(
  sandboxName: string,
  command: string[],
  stdin = false,
  sanitizeEnvironment = false,
  expectedContainerId?: string,
): string[] {
  const { sandbox, control } = privilegedSandboxControl(sandboxName);
  if (!control.buildLegacyDockerArgv) {
    throw new Error(
      "The selected runtime provider does not expose the retained Docker CLI compatibility path.",
    );
  }
  return control.buildLegacyDockerArgv({
    registeredSandboxNames: registeredSandboxNames(sandboxName),
    sandbox,
    sandboxName,
    command,
    sanitizeEnvironment,
    ...(stdin ? { input: Buffer.alloc(0) } : {}),
    ...(expectedContainerId !== undefined ? { expectedResourceHandle: expectedContainerId } : {}),
  });
}

export function capturePrivilegedSandboxCommand(
  sandboxName: string,
  command: readonly string[],
  options: PrivilegedSandboxCommandOptions = {},
): Buffer {
  const result = executePrivilegedSandboxCommand(sandboxName, command, options);
  if (result.status !== 0 || result.signal !== null || result.error) {
    const detail = result.stderr.toString("utf8").replace(/\s+/gu, " ").trim().slice(-500);
    const reason =
      result.error?.message ??
      (result.signal ? `signal ${result.signal}` : `exit ${String(result.status)}`);
    throw new Error(`Privileged sandbox command failed (${reason})${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

export function clearStoppedSandboxStateRoots(
  sandboxName: string,
  paths: readonly string[],
): RuntimeProviderStoppedSandboxStateCleanupResult {
  if (!validateStoppedSandboxStatePaths(paths)) {
    return { cleared: false, failure: "state-paths-invalid" };
  }
  const sandbox = registry.getSandbox?.(sandboxName) ?? null;
  if (!sandbox) return { cleared: false, failure: "sandbox-registry-unavailable" };
  try {
    return withPrivilegedSandboxExecutionLease(sandboxName, "offline channel state cleanup", () => {
      const { control } = privilegedSandboxControl(sandboxName);
      if (!control.clearStoppedStateRoots)
        return { cleared: false, failure: "provider-cleanup-unavailable" };
      return control.clearStoppedStateRoots({
        registeredSandboxNames: registeredSandboxNames(sandboxName),
        sandbox,
        sandboxName,
        paths,
      });
    });
  } catch {
    return { cleared: false, failure: "lifecycle-authority-unavailable" };
  }
}

export {
  buildStoppedSandboxChannelCleanupScript,
  buildStoppedSandboxChannelCleanupScript as buildStoppedDockerSandboxChannelCleanupScript,
};

export function isDirectSandboxFallbackUnavailableError(
  error: unknown,
): error is DirectSandboxFallbackUnavailableError {
  return error instanceof DirectSandboxFallbackUnavailableError;
}

export function isPinnedSandboxContainerIdentityChangedError(
  error: unknown,
): error is PinnedSandboxResourceIdentityChangedError {
  return error instanceof PinnedSandboxResourceIdentityChangedError;
}
