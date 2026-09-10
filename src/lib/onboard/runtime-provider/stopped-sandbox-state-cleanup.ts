// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import path from "node:path";

import type { ContainerEngineCommandResult } from "../../adapters/container-engine";
import type {
  RuntimeProviderStoppedSandboxStateCleanupFailure,
  RuntimeProviderStoppedSandboxStateCleanupResult,
} from "./contract";

const FULL_CONTAINER_ID_RE = /^[a-f0-9]{64}$/u;
const VOLUME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/u;
const STATE_PATH_RE = /^\/sandbox\/\.(?:openclaw|hermes)\/[A-Za-z0-9_-]+$/u;
const CLEANUP_IMAGE =
  "node:22-trixie-slim@sha256:db8a96a63e5264607ada2d206758876ebbed6a12be2ada7517793cbfb0c2a29c";
const CLEANUP_LABEL = "com.nvidia.nemoclaw.channel-cleanup";
const CLEANUP_OWNER_LABEL = `${CLEANUP_LABEL}.owner`;
const CLEANUP_VOLUME_LABEL = `${CLEANUP_LABEL}.volume`;
const NEUTRAL_ENV = [
  "--env",
  "LD_AUDIT=",
  "--env",
  "LD_LIBRARY_PATH=",
  "--env",
  "LD_PRELOAD=",
  "--env",
  "BASH_ENV=",
  "--env",
  "ENV=",
] as const;

export interface StoppedSandboxStateTarget {
  readonly resourceHandle: string;
  readonly running: boolean;
  readonly stateResource: {
    readonly type: "bind" | "volume";
    readonly source: string;
    readonly target: string;
  };
}

export type StoppedSandboxStateObservation =
  | { readonly target: StoppedSandboxStateTarget }
  | { readonly failure: RuntimeProviderStoppedSandboxStateCleanupFailure };

export interface StoppedSandboxStateCleanupEngine {
  capture(args: readonly string[], timeoutMs?: number): ContainerEngineCommandResult;
  observe(): StoppedSandboxStateObservation;
}

export function buildStoppedSandboxChannelCleanupScript(root?: string): string {
  return String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const targets = JSON.parse(process.argv[1]);
const root = ${root === undefined ? "process.argv[2]" : JSON.stringify(root)};
function lstat(candidate) {
  try { return fs.lstatSync(candidate); }
  catch (error) { if (error && error.code === "ENOENT") return null; throw error; }
}
const rootMetadata = lstat(root);
if (!rootMetadata || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) process.exit(40);
for (const target of targets) {
  if (typeof target !== "string" || !target.startsWith(root + "/")) process.exit(41);
  const relative = path.posix.relative(root, target);
  const segments = relative.split("/");
  if (!relative || relative.startsWith("../") || segments.some((part) => !part || part === "." || part === "..")) process.exit(42);
  let parent = root;
  let absent = false;
  for (const segment of segments.slice(0, -1)) {
    parent = path.posix.join(parent, segment);
    const metadata = lstat(parent);
    if (!metadata) { absent = true; break; }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) process.exit(43);
  }
  if (absent) continue;
  const metadata = lstat(target);
  if (!metadata) continue;
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) process.exit(44);
  fs.rmSync(target, { force: false, maxRetries: 0, recursive: true });
  if (lstat(target)) process.exit(45);
}
`;
}

const CLEANUP_SCRIPT = buildStoppedSandboxChannelCleanupScript();

function failure(
  code: RuntimeProviderStoppedSandboxStateCleanupFailure,
  cleanupHelperName?: string,
): RuntimeProviderStoppedSandboxStateCleanupResult {
  return cleanupHelperName
    ? { cleared: false, failure: code, cleanupHelperName }
    : { cleared: false, failure: code };
}

export function validateStoppedSandboxStatePaths(paths: readonly string[]): boolean {
  return (
    paths.length > 0 &&
    paths.length <= 4 &&
    new Set(paths).size === paths.length &&
    paths.every((statePath) => STATE_PATH_RE.test(statePath))
  );
}

export function sandboxStateResourceFromMounts(
  value: unknown,
  paths: readonly string[],
): StoppedSandboxStateTarget["stateResource"] | null {
  if (!Array.isArray(value) || !validateStoppedSandboxStatePaths(paths)) return null;
  const mounts = value
    .filter((entry): entry is Record<string, unknown> => {
      if (typeof entry !== "object" || entry === null) return false;
      const target = (entry as Record<string, unknown>).Destination;
      return (
        (entry as Record<string, unknown>).RW === true &&
        typeof target === "string" &&
        path.posix.isAbsolute(target) &&
        path.posix.normalize(target) === target &&
        (target === "/sandbox" || /^\/sandbox\/\.(?:openclaw|hermes)$/u.test(target)) &&
        paths.every((statePath) => statePath.startsWith(`${target}/`))
      );
    })
    .sort((left, right) => String(right.Destination).length - String(left.Destination).length);
  const mount = mounts[0];
  if (!mount || mounts[1]?.Destination === mount.Destination) return null;
  const target = String(mount.Destination);
  if (
    mount.Type === "volume" &&
    typeof mount.Name === "string" &&
    VOLUME_NAME_RE.test(mount.Name)
  ) {
    return { type: "volume", source: mount.Name, target };
  }
  if (
    mount.Type === "bind" &&
    typeof mount.Source === "string" &&
    path.isAbsolute(mount.Source) &&
    path.normalize(mount.Source) === mount.Source &&
    mount.Source !== path.parse(mount.Source).root &&
    mount.Source.length <= 4096 &&
    !/[\u0000-\u001f\u007f]/u.test(mount.Source)
  ) {
    return { type: "bind", source: mount.Source, target };
  }
  return null;
}

function sameStateResource(
  left: StoppedSandboxStateTarget["stateResource"],
  right: StoppedSandboxStateTarget["stateResource"],
): boolean {
  return left.type === right.type && left.source === right.source && left.target === right.target;
}

function stateResourceMount(resource: StoppedSandboxStateTarget["stateResource"]): string {
  return resource.type === "volume"
    ? `type=volume,src=${resource.source},dst=${resource.target},volume-nocopy`
    : `type=bind,src=${resource.source},dst=${resource.target}`;
}

function identity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function helperName(sandboxName: string): string {
  return `nemoclaw-channel-cleanup-${identity(sandboxName).slice(0, 24)}`;
}

function resultText(result: ContainerEngineCommandResult): string {
  return `${result.stderr} ${result.stdout} ${result.error?.message ?? ""}`;
}

function reportsMissing(result: ContainerEngineCommandResult): boolean {
  return result.status !== 0 && /No such (?:container|object)/iu.test(resultText(result));
}

type HelperInspection =
  | { readonly state: "absent" }
  | { readonly state: "invalid" }
  | { readonly state: "owned"; readonly id: string };

function inspectHelper(
  engine: StoppedSandboxStateCleanupEngine,
  name: string,
  owner: string,
  volume: string,
): HelperInspection {
  const result = engine.capture([
    "inspect",
    "--format",
    `{{.Id}}\t{{.Config.Image}}\t{{index .Config.Labels "${CLEANUP_LABEL}"}}\t{{index .Config.Labels "${CLEANUP_OWNER_LABEL}"}}\t{{index .Config.Labels "${CLEANUP_VOLUME_LABEL}"}}`,
    name,
  ]);
  if (reportsMissing(result)) return { state: "absent" };
  if (result.status !== 0 || result.error) return { state: "invalid" };
  const [id, image, marker, actualOwner, actualVolume, ...unexpected] = result.stdout
    .trim()
    .split("\t");
  return unexpected.length === 0 &&
    FULL_CONTAINER_ID_RE.test(id ?? "") &&
    image === CLEANUP_IMAGE &&
    marker === "1" &&
    actualOwner === owner &&
    actualVolume === volume
    ? { state: "owned", id: id! }
    : { state: "invalid" };
}

function removeHelper(engine: StoppedSandboxStateCleanupEngine, id: string): boolean {
  const removed = engine.capture(["rm", "-f", id]);
  if (removed.status !== 0 || removed.error) return false;
  return reportsMissing(engine.capture(["inspect", id]));
}

function reconcileHelper(
  engine: StoppedSandboxStateCleanupEngine,
  name: string,
  owner: string,
  volume: string,
): boolean {
  const helper = inspectHelper(engine, name, owner, volume);
  return helper.state === "absent" || (helper.state === "owned" && removeHelper(engine, helper.id));
}

function classifyStartFailure(result: ContainerEngineCommandResult | null) {
  if (result?.status === 45) return "cleanup-deletion-unconfirmed" as const;
  if (result && result.status >= 40 && result.status <= 44) {
    return "cleanup-state-tree-unsafe" as const;
  }
  return "cleanup-helper-failed" as const;
}

export function clearStoppedSandboxStateWithEngine(
  sandboxName: string,
  paths: readonly string[],
  engine: StoppedSandboxStateCleanupEngine,
): RuntimeProviderStoppedSandboxStateCleanupResult {
  if (!validateStoppedSandboxStatePaths(paths)) return failure("state-paths-invalid");
  const observed = engine.observe();
  if ("failure" in observed) return failure(observed.failure);
  const target = observed.target;
  if (target.running) return failure("runtime-not-stopped");
  const image = engine.capture(["image", "inspect", "--format", "{{.Id}}", CLEANUP_IMAGE]);
  if (
    image.status !== 0 ||
    image.error ||
    !/^(?:sha256:)?[a-f0-9]{64}$/u.test(image.stdout.trim())
  ) {
    return failure("cleanup-helper-image-unavailable");
  }
  const name = helperName(sandboxName);
  const owner = identity(sandboxName);
  const stateResourceIdentity = identity(JSON.stringify(target.stateResource));
  const existing = inspectHelper(engine, name, owner, stateResourceIdentity);
  if (existing.state === "invalid") return failure("cleanup-helper-ownership-invalid", name);
  if (existing.state === "owned" && !removeHelper(engine, existing.id)) {
    return failure("cleanup-helper-reconciliation-failed", name);
  }
  const revalidated = engine.observe();
  if (
    "failure" in revalidated ||
    revalidated.target.resourceHandle !== target.resourceHandle ||
    revalidated.target.running ||
    !sameStateResource(revalidated.target.stateResource, target.stateResource)
  ) {
    return failure("runtime-revalidation-failed");
  }
  const created = engine.capture([
    "create",
    "--name",
    name,
    "--pull",
    "never",
    "--network",
    "none",
    "--read-only",
    "--user",
    "0:0",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "DAC_OVERRIDE",
    "--pids-limit",
    "64",
    ...NEUTRAL_ENV,
    "--label",
    `${CLEANUP_LABEL}=1`,
    "--label",
    `${CLEANUP_OWNER_LABEL}=${owner}`,
    "--label",
    `${CLEANUP_VOLUME_LABEL}=${stateResourceIdentity}`,
    "--mount",
    stateResourceMount(target.stateResource),
    "--entrypoint",
    "/usr/local/bin/node",
    CLEANUP_IMAGE,
    "-e",
    CLEANUP_SCRIPT,
    JSON.stringify(paths),
    target.stateResource.target,
  ]);
  const helperId = created.stdout.trim();
  if (created.status !== 0 || created.error || !FULL_CONTAINER_ID_RE.test(helperId)) {
    return reconcileHelper(engine, name, owner, stateResourceIdentity)
      ? failure("cleanup-helper-failed")
      : failure("cleanup-helper-reconciliation-failed", name);
  }
  const cleared = engine.capture(["start", "--attach", helperId]);
  if (!removeHelper(engine, helperId)) return failure("cleanup-helper-reconciliation-failed", name);
  if (cleared.status !== 0 || cleared.error) return failure(classifyStartFailure(cleared));
  const confirmed = engine.observe();
  if (
    "failure" in confirmed ||
    confirmed.target.resourceHandle !== target.resourceHandle ||
    !sameStateResource(confirmed.target.stateResource, target.stateResource) ||
    confirmed.target.running
  ) {
    return failure("runtime-revalidation-failed");
  }
  return { cleared: true };
}
