// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";

import { dockerExecFileSync, dockerSpawnSync } from "../../adapters/docker";
import { CLI_NAME } from "../../cli/branding";
import * as registry from "../../state/registry";

const K3S_CONTAINER = "openshell-cluster-nemoclaw";
const HOST_ALIAS_KUBECTL_TIMEOUT_MS = 10_000;
const HOST_ALIAS_DOCKER_PROBE_TIMEOUT_MS = 5_000;

type LegacyGatewayProbe =
  | { state: "present" }
  | { state: "absent" }
  | { state: "unknown"; reason: string };

// Drivers that run a per-sandbox direct container (openshell-<sandbox>...)
// instead of the legacy k3s gateway. They have no openshell-cluster-nemoclaw
// container and no Kubernetes `Sandbox` custom resource, so the kubectl-based
// host-alias backend below cannot target them. See src/lib/sandbox/privileged-exec.ts
// for the direct-container resolution these drivers use elsewhere.
const DIRECT_CONTAINER_DRIVERS = new Set(["docker", "vm"]);

type HostAlias = {
  ip: string;
  hostnames: string[];
};

type SandboxResource = {
  metadata?: {
    resourceVersion?: string;
  };
  spec?: {
    podTemplate?: {
      spec?: {
        hostAliases?: unknown;
      };
    };
  };
};

type BuildHostAliases = (resource: SandboxResource) => HostAlias[];

export type AddSandboxHostAliasOptions = {
  hostname?: string;
  ip?: string;
  dryRun?: boolean;
};

export type RemoveSandboxHostAliasOptions = {
  hostname?: string;
  dryRun?: boolean;
};

export class HostAliasesCommandError extends Error {
  readonly lines: readonly string[];
  readonly exitCode: number;

  constructor(lines: string | readonly string[], exitCode = 1) {
    const normalized = Array.isArray(lines) ? lines : [lines];
    super(normalized.join("\n"));
    this.name = "HostAliasesCommandError";
    this.lines = normalized;
    this.exitCode = exitCode;
  }
}

function hostAliasesFail(lines: string | readonly string[], exitCode = 1): never {
  throw new HostAliasesCommandError(lines, exitCode);
}

function normalizeDriver(driver: unknown): string | null {
  return typeof driver === "string" && driver.trim()
    ? driver.trim().toLowerCase()
    : null;
}

// Host aliases are persisted on the legacy Kubernetes gateway `Sandbox`
// custom resource and applied by `docker exec openshell-cluster-nemoclaw
// kubectl ...`. The docker and vm drivers run per-sandbox direct containers
// with no gateway cluster container and no `Sandbox` CR, so this k3s
// control-plane path cannot work for them. Fail fast with an actionable
// message instead of targeting a container that does not exist (#4516) — and
// without pretending a one-time /etc/hosts edit inside the direct container
// would survive a sandbox restart or rebuild.
function assertLegacyGatewayHostAliasSupport(sandboxName: string): void {
  const driver = normalizeDriver(registry.getSandbox(sandboxName)?.openshellDriver);
  if (driver && DIRECT_CONTAINER_DRIVERS.has(driver)) {
    hostAliasesFail([
      `  Host aliases are not supported on the '${driver}' driver sandbox '${sandboxName}'.`,
      "  This command edits aliases on the legacy Kubernetes gateway sandbox resource,",
      `  which the ${driver} driver does not run (there is no ${K3S_CONTAINER} container).`,
      "  OpenShell does not yet expose a persistent host-alias API for this driver, and a",
      "  one-time /etc/hosts edit would not survive a sandbox restart or rebuild.",
    ]);
  }
  // Registry entries from older NemoClaw releases predate the openshellDriver
  // field, and a kubernetes-driver sandbox whose legacy gateway never came up
  // also slips past the driver branch above. Without this probe both fall
  // through to `docker exec openshell-cluster-nemoclaw kubectl ...` and the
  // user sees an opaque `Error response from daemon: No such container:
  // openshell-cluster-nemoclaw`. Classify the probe result so a docker daemon
  // outage, timeout, or permission error does not get misreported as a
  // missing gateway container.
  const probe = probeLegacyGatewayContainer();
  if (probe.state === "absent") {
    const driverLabel = driver ?? "unspecified";
    hostAliasesFail([
      `  Host aliases require the legacy OpenShell gateway container '${K3S_CONTAINER}' to be running.`,
      `  The legacy gateway container is not running on this host (sandbox '${sandboxName}', driver: ${driverLabel}).`,
      "  Newer OpenShell drivers run per-sandbox direct containers instead of the legacy gateway",
      "  and do not yet expose a persistent host-alias API. A one-time /etc/hosts edit inside the",
      "  direct container would not survive a sandbox restart or rebuild.",
    ]);
  }
  if (probe.state === "unknown") {
    hostAliasesFail([
      `  Could not verify the legacy OpenShell gateway container '${K3S_CONTAINER}'.`,
      `  Docker probe failed: ${probe.reason}`,
      "  Check whether the Docker daemon is reachable with `docker info`.",
    ]);
  }
}

function probeLegacyGatewayContainer(): LegacyGatewayProbe {
  // `docker ps --filter name=...` accepts only substring or anchored regex
  // syntax (`name=^/<container>$`) per the Docker CLI reference, and the
  // anchor form is fragile across daemon versions. Mirror the unfiltered
  // `docker ps --format '{{.Names}}'` pattern used in
  // src/lib/sandbox/privileged-exec.ts and do the exact match in code so
  // there is no doubt about substring overlap or anchor support.
  const result = dockerSpawnSync(["ps", "--format", "{{.Names}}"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: HOST_ALIAS_DOCKER_PROBE_TIMEOUT_MS,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code ?? "";
    if (code === "ETIMEDOUT") {
      return { state: "unknown", reason: "docker ps timed out" };
    }
    return { state: "unknown", reason: `docker ps could not launch: ${result.error.message}` };
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    return {
      state: "unknown",
      reason: stderr || `docker ps exited with status ${result.status}`,
    };
  }
  const stdout = result.stdout == null ? "" : String(result.stdout);
  const present = stdout
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === K3S_CONTAINER);
  return present ? { state: "present" } : { state: "absent" };
}

function validateHostAliasHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false;
  return hostname.split(".").every((label) => {
    return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label);
  });
}

function normalizeHostAliasHostname(hostname: string): string {
  return String(hostname || "").toLowerCase();
}

function runKubectlInClusterRaw(args: string[]): string {
  return dockerExecFileSync(
    ["exec", K3S_CONTAINER, "kubectl", "-n", "openshell", ...args],
    {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: HOST_ALIAS_KUBECTL_TIMEOUT_MS,
    },
  );
}

function throwKubectlError(action: string, error: unknown): never {
  const err = error as { stderr?: unknown; stdout?: unknown; message?: unknown; status?: number };
  const detail = String(err?.stderr || err?.stdout || err?.message || "").trim();
  hostAliasesFail(`  Failed to ${action}.${detail ? ` ${detail}` : ""}`, err?.status || 1);
}

function runKubectlInCluster(args: string[], action: string): string {
  try {
    return runKubectlInClusterRaw(args);
  } catch (error) {
    throwKubectlError(action, error);
  }
}

function getSandboxResource(sandboxName: string): SandboxResource {
  const raw = runKubectlInCluster(["get", "sandbox", sandboxName, "-o", "json"], "read host aliases");
  try {
    return JSON.parse(raw) as SandboxResource;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    hostAliasesFail(`  Failed to parse sandbox resource: ${message}`);
  }
}

function getHostAliases(resource: SandboxResource): unknown[] {
  const aliases = resource?.spec?.podTemplate?.spec?.hostAliases;
  return Array.isArray(aliases) ? aliases : [];
}

function normalizeHostAliases(resource: SandboxResource): HostAlias[] {
  return getHostAliases(resource).map((alias): HostAlias => {
    const entry = alias as { ip?: unknown; hostnames?: unknown };
    return {
      ip: typeof entry.ip === "string" ? entry.ip : "",
      hostnames: Array.isArray(entry.hostnames)
        ? entry.hostnames.map((hostname) => normalizeHostAliasHostname(String(hostname)))
        : [],
    };
  });
}

function buildHostAliasesPatch(resource: SandboxResource, hostAliases: HostAlias[]) {
  const patch: Array<{ op: string; path: string; value: unknown }> = [];
  const resourceVersion = resource?.metadata?.resourceVersion;
  if (resourceVersion) {
    patch.push({
      op: "test",
      path: "/metadata/resourceVersion",
      value: resourceVersion,
    });
  }
  patch.push({
    op: Array.isArray(resource?.spec?.podTemplate?.spec?.hostAliases) ? "replace" : "add",
    path: "/spec/podTemplate/spec/hostAliases",
    value: hostAliases,
  });
  return patch;
}

function isHostAliasPatchConflict(error: unknown): boolean {
  const err = error as { stderr?: unknown; stdout?: unknown; message?: unknown; status?: number };
  const detail = String(err?.stderr || err?.stdout || err?.message || "").toLowerCase();
  return (
    err?.status === 409 ||
    detail.includes("conflict") ||
    detail.includes("resourceversion") ||
    detail.includes("object has been modified") ||
    detail.includes("test operation failed")
  );
}

function patchHostAliases(
  sandboxName: string,
  resource: SandboxResource,
  hostAliases: HostAlias[],
): void {
  runKubectlInClusterRaw([
    "patch",
    "sandbox",
    sandboxName,
    "--type=json",
    "-p",
    JSON.stringify(buildHostAliasesPatch(resource, hostAliases)),
  ]);
}

function patchHostAliasesWithRetry(
  sandboxName: string,
  buildAliases: BuildHostAliases,
  initialResource: SandboxResource,
  initialAliases: HostAlias[],
): void {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const resource = attempt === 1 ? initialResource : getSandboxResource(sandboxName);
    const aliases = attempt === 1 ? initialAliases : buildAliases(resource);
    try {
      patchHostAliases(sandboxName, resource, aliases);
      return;
    } catch (error) {
      if (!isHostAliasPatchConflict(error) || attempt === maxAttempts) {
        throwKubectlError("update host aliases", error);
      }
    }
  }
}

export function listSandboxHostAliases(sandboxName: string): void {
  assertLegacyGatewayHostAliasSupport(sandboxName);
  const aliases = getHostAliases(getSandboxResource(sandboxName));
  if (aliases.length === 0) {
    console.log(`  No host aliases configured for '${sandboxName}'.`);
    return;
  }

  console.log(`  Host aliases for '${sandboxName}':`);
  for (const alias of aliases) {
    const entry = alias as { ip?: unknown; hostnames?: unknown };
    const ip = typeof entry.ip === "string" ? entry.ip : "";
    const hostnames = Array.isArray(entry.hostnames) ? entry.hostnames : [];
    if (ip && hostnames.length > 0) {
      console.log(`    ${ip}  ${hostnames.join(", ")}`);
    }
  }
}

function validateAddOptions(options: AddSandboxHostAliasOptions): { hostname: string; ip: string } {
  const { hostname: rawHostname, ip } = options;
  if (!rawHostname || !ip) {
    hostAliasesFail(`  Usage: ${CLI_NAME} <sandbox> hosts-add <hostname> <ip> [--dry-run]`);
  }
  const hostname = normalizeHostAliasHostname(rawHostname);
  if (!validateHostAliasHostname(hostname)) {
    hostAliasesFail(`  Invalid hostname '${hostname}'.`);
  }
  if (isIP(ip) === 0) {
    hostAliasesFail(`  Invalid IP address '${ip}'.`);
  }
  return { hostname, ip };
}

function validateRemoveOptions(options: RemoveSandboxHostAliasOptions): { hostname: string } {
  const { hostname: rawHostname } = options;
  if (!rawHostname) {
    hostAliasesFail(`  Usage: ${CLI_NAME} <sandbox> hosts-remove <hostname> [--dry-run]`);
  }
  const hostname = normalizeHostAliasHostname(rawHostname);
  if (!validateHostAliasHostname(hostname)) {
    hostAliasesFail(`  Invalid hostname '${hostname}'.`);
  }
  return { hostname };
}

export function addSandboxHostAlias(
  sandboxName: string,
  options: AddSandboxHostAliasOptions = {},
): void {
  const dryRun = Boolean(options.dryRun);
  const { hostname, ip } = validateAddOptions(options);
  assertLegacyGatewayHostAliasSupport(sandboxName);

  const resource = getSandboxResource(sandboxName);
  const buildAliases: BuildHostAliases = (currentResource) => {
    const aliases = normalizeHostAliases(currentResource);
    if (aliases.some((alias) => alias.hostnames.includes(hostname))) {
      hostAliasesFail(`  Host alias '${hostname}' already exists.`);
    }

    const existing = aliases.find((alias) => alias.ip === ip);
    if (existing) {
      existing.hostnames.push(hostname);
    } else {
      aliases.push({ ip, hostnames: [hostname] });
    }
    return aliases;
  };
  const aliases = buildAliases(resource);

  if (dryRun) {
    console.log(JSON.stringify(buildHostAliasesPatch(resource, aliases), null, 2));
    return;
  }
  patchHostAliasesWithRetry(sandboxName, buildAliases, resource, aliases);
  console.log(`  Added host alias ${hostname} -> ${ip}`);
}

export function removeSandboxHostAlias(
  sandboxName: string,
  options: RemoveSandboxHostAliasOptions = {},
): void {
  const dryRun = Boolean(options.dryRun);
  const { hostname } = validateRemoveOptions(options);
  assertLegacyGatewayHostAliasSupport(sandboxName);

  const resource = getSandboxResource(sandboxName);
  const buildAliases: BuildHostAliases = (currentResource) => {
    const original = normalizeHostAliases(currentResource);
    const aliases = original
      .map(
        (alias): HostAlias => ({
          ip: alias.ip,
          hostnames: alias.hostnames.filter((name) => name !== hostname),
        }),
      )
      .filter((alias) => alias.ip && alias.hostnames.length > 0);

    const existed = original.some((alias) => alias.hostnames.includes(hostname));
    if (!existed) {
      hostAliasesFail(`  Host alias '${hostname}' is not configured.`);
    }
    return aliases;
  };
  const aliases = buildAliases(resource);

  if (dryRun) {
    console.log(JSON.stringify(buildHostAliasesPatch(resource, aliases), null, 2));
    return;
  }
  patchHostAliasesWithRetry(sandboxName, buildAliases, resource, aliases);
  console.log(`  Removed host alias ${hostname}`);
}
