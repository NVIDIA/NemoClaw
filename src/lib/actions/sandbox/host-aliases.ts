// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";

import { dockerExecFileSync } from "../../adapters/docker";
import { CLI_NAME } from "../../cli/branding";

const K3S_CONTAINER = "openshell-cluster-nemoclaw";
const HOST_ALIAS_KUBECTL_TIMEOUT_MS = 10_000;

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
  return dockerExecFileSync([K3S_CONTAINER, "kubectl", "-n", "openshell", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: HOST_ALIAS_KUBECTL_TIMEOUT_MS,
  });
}

function throwKubectlError(action: string, error: unknown): never {
  const err = error as { stderr?: unknown; stdout?: unknown; message?: unknown; status?: number };
  const detail = String(err?.stderr || err?.stdout || err?.message || "").trim();
  console.error(`  Failed to ${action}.${detail ? ` ${detail}` : ""}`);
  process.exit(err?.status || 1);
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
    console.error(`  Failed to parse sandbox resource: ${message}`);
    process.exit(1);
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

export function addSandboxHostAlias(sandboxName: string, args: string[] = []): void {
  const dryRun = args.includes("--dry-run");
  const values = args.filter((arg) => !arg.startsWith("-"));
  const [rawHostname, ip] = values;
  if (!rawHostname || !ip || values.length !== 2) {
    console.error(`  Usage: ${CLI_NAME} <sandbox> hosts-add <hostname> <ip> [--dry-run]`);
    process.exit(1);
  }
  const hostname = normalizeHostAliasHostname(rawHostname);
  if (!validateHostAliasHostname(hostname)) {
    console.error(`  Invalid hostname '${hostname}'.`);
    process.exit(1);
  }
  if (isIP(ip) === 0) {
    console.error(`  Invalid IP address '${ip}'.`);
    process.exit(1);
  }

  const resource = getSandboxResource(sandboxName);
  const buildAliases: BuildHostAliases = (currentResource) => {
    const aliases = normalizeHostAliases(currentResource);
    if (aliases.some((alias) => alias.hostnames.includes(hostname))) {
      console.error(`  Host alias '${hostname}' already exists.`);
      process.exit(1);
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

export function removeSandboxHostAlias(sandboxName: string, args: string[] = []): void {
  const dryRun = args.includes("--dry-run");
  const values = args.filter((arg) => !arg.startsWith("-"));
  const [rawHostname] = values;
  if (!rawHostname || values.length !== 1) {
    console.error(`  Usage: ${CLI_NAME} <sandbox> hosts-remove <hostname> [--dry-run]`);
    process.exit(1);
  }
  const hostname = normalizeHostAliasHostname(rawHostname);
  if (!validateHostAliasHostname(hostname)) {
    console.error(`  Invalid hostname '${hostname}'.`);
    process.exit(1);
  }

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
      console.error(`  Host alias '${hostname}' is not configured.`);
      process.exit(1);
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
