// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { dockerCapture } = require("../adapters/docker/run");
const registry = require("../state/registry") as {
  getSandbox?: (name: string) => { name?: string; openshellDriver?: string | null } | null;
  listSandboxes?: () => {
    sandboxes?: Array<{ name?: string | null }>;
    defaultSandbox?: string | null;
  };
  load?: () => {
    sandboxes?: Record<string, { name?: string | null }>;
    defaultSandbox?: string | null;
  };
};

type SandboxEntry = {
  name?: string;
  openshellDriver?: string | null;
};

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
  const candidates = containerNames
    .split("\n")
    .map((line: string) => line.trim())
    .filter(Boolean)
    .filter((containerName: string) => {
      if (!containerNameMatchesSandbox(containerName, sandboxName)) return false;
      return owningRegisteredSandboxName(containerName, names) === sandboxName;
    });

  return (
    candidates.find((containerName: string) => containerName === `openshell-${sandboxName}`) ??
    candidates[0] ??
    null
  );
}

function expectedDirectContainerPattern(sandboxName: string): string {
  return `openshell-${sandboxName} or openshell-${sandboxName}-*`;
}

function findDirectSandboxContainer(sandboxName: string): string | null {
  const names = registeredSandboxNames(sandboxName);
  const output = dockerCapture(["ps", "--format", "{{.Names}}"]);
  return selectDirectSandboxContainer(sandboxName, output, names);
}

function missingDirectContainerError(sandboxName: string, driver: string | null): Error {
  const driverLabel = driver ?? "unspecified";
  return new Error(
    `No running direct OpenShell sandbox container found for '${sandboxName}' ` +
      `(driver: ${driverLabel}). Expected a running container named ` +
      `${expectedDirectContainerPattern(sandboxName)}. Is the sandbox running?`,
  );
}

function missingRegistryEntryError(sandboxName: string): Error {
  return new Error(
    `No NemoClaw registry entry found for '${sandboxName}'; ` +
      "refusing privileged exec without a registered sandbox owner.",
  );
}

function resolveDirectSandboxContainer(sandboxName: string, driver: string | null): string {
  const selected = findDirectSandboxContainer(sandboxName);
  if (selected) return selected;
  throw missingDirectContainerError(sandboxName, driver);
}

function privilegedSandboxExecArgv(sandboxName: string, cmd: string[], stdin = false): string[] {
  const entry = readSandboxEntry(sandboxName);
  if (!entry) throw missingRegistryEntryError(sandboxName);
  const driver = normalizeDriver(entry?.openshellDriver);

  // Docker/direct-container is the only supported privileged mutation path.
  // Try it even when older registry entries do not record a driver, then fail
  // clearly if no matching sandbox container is running.
  const container = findDirectSandboxContainer(sandboxName);
  if (container) {
    return ["exec", ...(stdin ? ["-i"] : []), "--user", "root", container, ...cmd];
  }

  throw missingDirectContainerError(sandboxName, driver);
}

export {
  containerNameMatchesSandbox,
  selectDirectSandboxContainer,
  resolveDirectSandboxContainer,
  privilegedSandboxExecArgv,
};
