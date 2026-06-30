// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture } from "../adapters/docker/run";
import * as registry from "../state/registry";

type SandboxEntry = {
  name?: string;
  openshellDriver?: string | null;
};

const DIRECT_SANDBOX_DISCOVERY_TIMEOUT_MS = 5000;
const SANITIZED_PRIVILEGED_ENV = [
  "BASH_ENV=",
  "ENV=",
  "GCONV_PATH=",
  "GLIBC_TUNABLES=",
  "LD_AUDIT=",
  "LD_LIBRARY_PATH=",
  "LD_PRELOAD=",
  "LOCPATH=",
  "NODE_OPTIONS=",
  "PERL5OPT=",
  "PYTHONHOME=",
  "PYTHONINSPECT=",
  "PYTHONNOUSERSITE=1",
  "PYTHONPATH=",
  "PYTHONSTARTUP=",
  "PYTHONUSERBASE=",
  "RUBYOPT=",
] as const;

class DirectSandboxFallbackUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DirectSandboxFallbackUnavailableError";
  }
}

function normalizeDriver(driver: unknown): string | null {
  return typeof driver === "string" && driver.trim() ? driver.trim().toLowerCase() : null;
}

function readSandboxEntry(sandboxName: string): SandboxEntry | null {
  return registry.getSandbox?.(sandboxName) ?? null;
}

function registeredSandboxNames(sandboxName: string): string[] {
  const names = new Set<string>([sandboxName]);

  if (registry.listSandboxes) {
    const listed = registry.listSandboxes?.();
    if (Array.isArray(listed?.sandboxes)) {
      for (const entry of listed.sandboxes) {
        if (typeof entry.name === "string" && entry.name) names.add(entry.name);
      }
    }
  } else {
    const loaded = registry.load?.();
    const sandboxes = loaded?.sandboxes;
    if (sandboxes && typeof sandboxes === "object") {
      for (const [key, entry] of Object.entries(sandboxes)) {
        if (key) names.add(key);
        if (typeof entry?.name === "string" && entry.name) names.add(entry.name);
      }
    }
  }

  return Array.from(names).sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function containerNameMatchesSandbox(containerName: string, sandboxName: string): boolean {
  const exact = `openshell-${sandboxName}`;
  return containerName === exact || containerName.startsWith(`${exact}-`);
}

function owningRegisteredSandboxName(
  containerName: string,
  registeredNames: readonly string[],
): string | null {
  return registeredNames.find((name) => containerNameMatchesSandbox(containerName, name)) ?? null;
}

function selectDirectSandboxContainer(
  sandboxName: string,
  containerNames: string,
  registeredNames: readonly string[] = [sandboxName],
): string | null {
  const names = Array.from(new Set([...registeredNames, sandboxName])).sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
  const candidates = Array.from(
    new Set(
      containerNames
        .split("\n")
        .map((line: string) => line.trim())
        .filter(Boolean)
        .filter((containerName: string) => {
          if (!containerNameMatchesSandbox(containerName, sandboxName)) return false;
          return owningRegisteredSandboxName(containerName, names) === sandboxName;
        }),
    ),
  );

  const exact = candidates.find(
    (containerName: string) => containerName === `openshell-${sandboxName}`,
  );
  if (exact) return exact;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(
      `Multiple running direct OpenShell containers match registered sandbox '${sandboxName}': ${candidates.join(", ")}. Refusing privileged exec without an exact container identity.`,
    );
  }
  return null;
}

function expectedDirectContainerPattern(sandboxName: string): string {
  return `openshell-${sandboxName} or openshell-${sandboxName}-*`;
}

function findDirectSandboxContainer(sandboxName: string): string | null {
  const names = registeredSandboxNames(sandboxName);
  let output: string;
  try {
    output = dockerCapture(["ps", "--format", "{{.Names}}"], {
      timeout: DIRECT_SANDBOX_DISCOVERY_TIMEOUT_MS,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DirectSandboxFallbackUnavailableError(
      `Direct sandbox container discovery failed for '${sandboxName}': ${detail}`,
      { cause: error },
    );
  }
  return selectDirectSandboxContainer(sandboxName, output, names);
}

function missingDirectContainerError(sandboxName: string, driver: string | null): Error {
  const driverLabel = driver ?? "unspecified";
  return new DirectSandboxFallbackUnavailableError(
    `No running direct OpenShell sandbox container found for '${sandboxName}' ` +
      `(driver: ${driverLabel}). Expected a running container named ` +
      `${expectedDirectContainerPattern(sandboxName)}. Is the sandbox running?`,
  );
}

function isDirectSandboxFallbackUnavailableError(
  error: unknown,
): error is DirectSandboxFallbackUnavailableError {
  return error instanceof DirectSandboxFallbackUnavailableError;
}

function missingRegistryEntryError(sandboxName: string): Error {
  return new Error(
    `No NemoClaw registry entry found for '${sandboxName}'; ` +
      "refusing privileged exec without a registered sandbox owner.",
  );
}

function unsupportedDirectDriverError(sandboxName: string, driver: string): Error {
  return new Error(
    `Privileged direct-container control is unavailable for sandbox '${sandboxName}' ` +
      `(driver: ${driver}); refusing local Docker discovery for a non-direct driver.`,
  );
}

function resolveDirectSandboxContainer(sandboxName: string, driver: string | null): string {
  const selected = findDirectSandboxContainer(sandboxName);
  if (selected) return selected;
  throw missingDirectContainerError(sandboxName, driver);
}

function privilegedSandboxExecArgv(
  sandboxName: string,
  cmd: string[],
  stdin = false,
  sanitizeEnvironment = false,
): string[] {
  const entry = readSandboxEntry(sandboxName);
  if (!entry) throw missingRegistryEntryError(sandboxName);
  const driver = normalizeDriver(entry?.openshellDriver);
  if (driver !== null && driver !== "docker" && driver !== "vm") {
    throw unsupportedDirectDriverError(sandboxName, driver);
  }

  // Docker/direct-container is the only supported privileged mutation path.
  // Try it even when older registry entries do not record a driver, then fail
  // clearly if no matching sandbox container is running.
  const container = findDirectSandboxContainer(sandboxName);
  if (container) {
    const sanitizedEnvArgs = sanitizeEnvironment
      ? SANITIZED_PRIVILEGED_ENV.flatMap((value) => ["--env", value])
      : [];
    return [
      "exec",
      ...(stdin ? ["-i"] : []),
      ...sanitizedEnvArgs,
      "--user",
      "root",
      container,
      ...cmd,
    ];
  }

  throw missingDirectContainerError(sandboxName, driver);
}

export {
  containerNameMatchesSandbox,
  isDirectSandboxFallbackUnavailableError,
  privilegedSandboxExecArgv,
  resolveDirectSandboxContainer,
  selectDirectSandboxContainer,
};
