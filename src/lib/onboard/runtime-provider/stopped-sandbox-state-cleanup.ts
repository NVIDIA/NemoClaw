// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

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
  readonly sandboxVolumeName: string;
}

export type StoppedSandboxStateObservation =
  | { readonly target: StoppedSandboxStateTarget }
  | { readonly failure: RuntimeProviderStoppedSandboxStateCleanupFailure };

export interface StoppedSandboxStateCleanupEngine {
  capture(args: readonly string[], timeoutMs?: number): ContainerEngineCommandResult;
  observe(): StoppedSandboxStateObservation;
}

export function buildStoppedSandboxChannelCleanupScript(root = "/sandbox"): string {
  return String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = ${JSON.stringify(root)};
const targets = JSON.parse(process.argv[1]);
function lstat(candidate) {
  try { return fs.lstatSync(candidate); }
  catch (error) { if (error && error.code === "ENOENT") return null; throw error; }
}
const rootMetadata = lstat(root);
if (!rootMetadata || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) process.exit(40);
for (const target of targets) {
  if (typeof target !== "string" || !target.startsWith(root + "/.")) process.exit(41);
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

export function sandboxVolumeNameFromMounts(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const mounts = value.filter(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>).Destination === "/sandbox",
  ) as Array<Record<string, unknown>>;
  const mount = mounts.length === 1 ? mounts[0] : undefined;
  return mount?.Type === "volume" &&
    mount.RW === true &&
    typeof mount.Name === "string" &&
    VOLUME_NAME_RE.test(mount.Name)
    ? mount.Name
    : null;
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
  if (image.status !== 0 || image.error || !/^sha256:[a-f0-9]{64}\s*$/u.test(image.stdout)) {
    return failure("cleanup-helper-image-unavailable");
  }
  const name = helperName(sandboxName);
  const owner = identity(sandboxName);
  const volume = identity(target.sandboxVolumeName);
  const existing = inspectHelper(engine, name, owner, volume);
  if (existing.state === "invalid") return failure("cleanup-helper-ownership-invalid", name);
  if (existing.state === "owned" && !removeHelper(engine, existing.id)) {
    return failure("cleanup-helper-reconciliation-failed", name);
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
    `${CLEANUP_VOLUME_LABEL}=${volume}`,
    "--mount",
    `type=volume,src=${target.sandboxVolumeName},dst=/sandbox,volume-nocopy`,
    "--entrypoint",
    "/usr/local/bin/node",
    CLEANUP_IMAGE,
    "-e",
    CLEANUP_SCRIPT,
    JSON.stringify(paths),
  ]);
  const helperId = created.stdout.trim();
  if (created.status !== 0 || created.error || !FULL_CONTAINER_ID_RE.test(helperId)) {
    return reconcileHelper(engine, name, owner, volume)
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
    confirmed.target.sandboxVolumeName !== target.sandboxVolumeName ||
    confirmed.target.running
  ) {
    return failure("runtime-revalidation-failed");
  }
  return { cleared: true };
}
