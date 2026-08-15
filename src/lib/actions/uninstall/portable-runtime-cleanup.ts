// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { withMcpLifecycleLockSync } from "../../state/mcp-lifecycle-lock-acquisition";
import {
  readGatewayRegistryFile,
  registryEntryGatewayPort,
  type GatewayRegistryEntry,
} from "../../state/gateway-registry";
import {
  createPortablePodmanLifecycleTransport,
  listPortableDemoSandboxLifecycleReceipts,
  preparePortableDemoSandboxRemoval,
  type PortableDemoLifecycleDeps,
  type PortableDemoLifecycleReceiptRecord,
  type PortablePodmanLifecycleCommandResult,
  type PortablePodmanLifecycleTransport,
} from "../../onboard/experimental/portable-demo-lifecycle";
import { portablePodmanCommandEnvironment } from "../../onboard/experimental/portable-runtime-readiness";

const REGISTRY_CONTAINER_NAME = "nemoclaw-portable-registry";
const REGISTRY_LABEL_NAME = "com.nvidia.nemoclaw.portable";
const REGISTRY_LABEL_VALUE = "1";
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_SYSTEMD_ENVIRONMENT_BYTES = 1024 * 1024;
const PORTABLE_SELECTOR_NAMES = [
  "CONTAINERS_CONF",
  "NETAVARK_FW",
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
  "CONTAINER_SSHKEY",
] as const;

interface PortableRegistryRemoval {
  readonly present: boolean;
  removeAndVerify(): void;
}

interface RegistryFence {
  readonly lockPath: string;
  readonly ownerPath: string;
  readonly token: string;
  readonly device: bigint;
  readonly inode: bigint;
}

export interface PortableRuntimeCleanupInput {
  readonly env: NodeJS.ProcessEnv;
  readonly gatewayPort: number;
  readonly homeDir: string;
  readonly registryFile: string;
  readonly stateDir: string;
}

export interface PortableRuntimeCleanupDeps extends PortableDemoLifecycleDeps {
  readonly systemctl?: (
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ) => PortablePodmanLifecycleCommandResult;
  readonly withLifecycleLock?: <T>(sandboxName: string, operation: () => T, stateDir: string) => T;
}

function commandDetail(result: PortablePodmanLifecycleCommandResult): string {
  if (result.error) {
    return (result.error as NodeJS.ErrnoException).code ?? result.error.message;
  }
  const stderr = String(result.stderr ?? "").trim();
  return stderr || `exit ${String(result.status)}`;
}

function requireCommand(result: PortablePodmanLifecycleCommandResult, description: string): void {
  if (result.status === 0 && !result.error) return;
  throw new Error(`${description} failed: ${commandDetail(result)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingContainer(result: PortablePodmanLifecycleCommandResult): boolean {
  if (result.status === 0 && !result.error) return false;
  const detail = `${String(result.stderr ?? "")}\n${String(result.stdout ?? "")}`;
  return /\b(?:no such (?:object|container)|no container with (?:name|id)|container .* not found)\b/iu.test(
    detail,
  );
}

function acquireRegistryFence(registryFile: string): RegistryFence {
  const lockPath = `${registryFile}.lock`;
  const ownerPath = path.join(lockPath, "uninstall-owner");
  const token = crypto.randomUUID();
  let created = false;
  try {
    fs.mkdirSync(lockPath);
    created = true;
    const stat = fs.lstatSync(lockPath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Portable uninstall registry fence '${lockPath}' is not a real directory`);
    }
    fs.writeFileSync(ownerPath, `${JSON.stringify({ pid: process.pid, token })}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return {
      lockPath,
      ownerPath,
      token,
      device: stat.dev,
      inode: stat.ino,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Another sandbox registry operation owns '${lockPath}'`);
    }
    if (created) {
      try {
        fs.unlinkSync(ownerPath);
      } catch {
        // The exact empty directory is removed below when possible.
      }
      try {
        fs.rmdirSync(lockPath);
      } catch {
        // Preserve an ambiguous fence generation.
      }
    }
    throw error;
  }
}

function releaseRegistryFence(fence: RegistryFence): void {
  const stat = fs.lstatSync(fence.lockPath, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.dev !== fence.device ||
    stat.ino !== fence.inode
  ) {
    throw new Error(`Portable uninstall registry fence '${fence.lockPath}' changed ownership`);
  }
  const owner = JSON.parse(fs.readFileSync(fence.ownerPath, "utf8")) as unknown;
  if (!isRecord(owner) || owner.pid !== process.pid || owner.token !== fence.token) {
    throw new Error(`Portable uninstall registry fence '${fence.lockPath}' changed ownership`);
  }
  fs.unlinkSync(fence.ownerPath);
  fs.rmdirSync(fence.lockPath);
}

function withPortableFences<T>(
  input: PortableRuntimeCleanupInput,
  receipts: readonly PortableDemoLifecycleReceiptRecord[],
  deps: PortableRuntimeCleanupDeps,
  operation: () => T,
): T {
  const fence = acquireRegistryFence(input.registryFile);
  const lifecycleStateDir = path.join(input.stateDir, "state");
  const withLifecycleLock =
    deps.withLifecycleLock ??
    (<Value>(sandboxName: string, inner: () => Value, stateDir: string) =>
      withMcpLifecycleLockSync(sandboxName, inner, { stateDir }));
  const acquireNext = (index: number): T => {
    const receipt = receipts[index];
    return receipt
      ? withLifecycleLock(receipt.sandboxName, () => acquireNext(index + 1), lifecycleStateDir)
      : operation();
  };
  try {
    return acquireNext(0);
  } finally {
    releaseRegistryFence(fence);
  }
}

function commonRuntimeAuthority(
  receipts: readonly PortableDemoLifecycleReceiptRecord[],
): CheckpointPortableRuntimeAuthority {
  const authority = receipts[0]?.runtimeAuthority;
  if (!authority) throw new Error("Portable uninstall requires at least one lifecycle receipt");
  for (const receipt of receipts.slice(1)) {
    if (!isDeepStrictEqual(receipt.runtimeAuthority, authority)) {
      throw new Error("Portable lifecycle receipts disagree on their Podman runtime authority");
    }
  }
  return authority;
}

function requireReceiptRegistryOwnership(
  receipt: PortableDemoLifecycleReceiptRecord,
  entry: GatewayRegistryEntry | undefined,
  gatewayPort: number,
): void {
  if (!entry) return;
  if (
    registryEntryGatewayPort(entry) !== gatewayPort ||
    entry.agent !== "openclaw" ||
    entry.openshellDriver !== "docker" ||
    entry.lifecycleGeneration !== receipt.registryGeneration
  ) {
    throw new Error(
      `Portable lifecycle receipt for sandbox '${receipt.sandboxName}' does not match its current registry ownership`,
    );
  }
}

function currentReceipts(stateDir: string): PortableDemoLifecycleReceiptRecord[] {
  return listPortableDemoSandboxLifecycleReceipts(stateDir);
}

/** Detect portable uninstall from strict durable receipts, never ambient selectors or names. */
export function hasPortableRuntimeCleanup(stateDir: string): boolean {
  return currentReceipts(stateDir).length > 0;
}

/** Remove every exact receipt-owned sandbox after one all-target prevalidation pass. */
export function removePortableSandboxContainers(
  input: PortableRuntimeCleanupInput,
  deps: PortableRuntimeCleanupDeps = {},
): number {
  const receipts = currentReceipts(input.stateDir);
  if (receipts.length === 0) return 0;
  return withPortableFences(input, receipts, deps, () => {
    const current = currentReceipts(input.stateDir);
    if (!isDeepStrictEqual(current, receipts)) {
      throw new Error("Portable lifecycle receipts changed while uninstall acquired its fences");
    }
    const registry = readGatewayRegistryFile(input.homeDir, input.registryFile);
    const transport = createPortablePodmanLifecycleTransport(commonRuntimeAuthority(receipts), {
      ...deps,
      env: input.env,
      stateDir: input.stateDir,
    });
    const prepared = receipts.map((receipt) => {
      requireReceiptRegistryOwnership(
        receipt,
        registry?.sandboxes[receipt.sandboxName],
        input.gatewayPort,
      );
      return preparePortableDemoSandboxRemoval(receipt, transport, input.stateDir);
    });
    preparePortableRegistryRemoval(transport);
    inspectPortableUserManagerEnvironment(commonRuntimeAuthority(receipts), input.env, deps);
    for (const target of prepared) target.removeAndVerify();
    return prepared.filter((target) => target.present).length;
  });
}

function parseContainerIds(
  result: PortablePodmanLifecycleCommandResult,
  description: string,
): string[] {
  requireCommand(result, description);
  const ids = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (ids.some((id) => !CONTAINER_ID_PATTERN.test(id))) {
    throw new Error(`${description} returned an invalid container ID`);
  }
  return ids;
}

function registryLabelContainerIds(transport: PortablePodmanLifecycleTransport): string[] {
  return parseContainerIds(
    transport.podman([
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `label=${REGISTRY_LABEL_NAME}=${REGISTRY_LABEL_VALUE}`,
      "--format",
      "{{.ID}}",
    ]),
    "Finding the managed portable registry container",
  );
}

function inspectRegistryContainer(
  transport: PortablePodmanLifecycleTransport,
  result = transport.podman(["inspect", REGISTRY_CONTAINER_NAME]),
): string | null {
  if (isMissingContainer(result)) return null;
  requireCommand(result, "Inspecting the managed portable registry container");
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(result.stdout ?? ""));
  } catch {
    throw new Error("Inspecting the managed portable registry container returned invalid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error(
      "Inspecting the managed portable registry container returned an invalid record",
    );
  }
  const record = parsed[0];
  const config = isRecord(record.Config) ? record.Config : null;
  const labels = config && isRecord(config.Labels) ? config.Labels : null;
  const state = isRecord(record.State) ? record.State : null;
  if (
    typeof record.Id !== "string" ||
    !CONTAINER_ID_PATTERN.test(record.Id) ||
    record.Name !== REGISTRY_CONTAINER_NAME ||
    labels?.[REGISTRY_LABEL_NAME] !== REGISTRY_LABEL_VALUE ||
    typeof state?.Running !== "boolean"
  ) {
    throw new Error("The portable registry container does not match NemoClaw ownership");
  }
  return record.Id;
}

function preparePortableRegistryRemoval(
  transport: PortablePodmanLifecycleTransport,
): PortableRegistryRemoval {
  transport.assertRuntimeAuthority();
  const labelIds = registryLabelContainerIds(transport);
  const containerId = inspectRegistryContainer(transport);
  if (containerId === null) {
    if (labelIds.length !== 0) {
      throw new Error(
        "Portable registry ownership is ambiguous because a labeled replacement exists",
      );
    }
    return { present: false, removeAndVerify: () => transport.assertRuntimeAuthority() };
  }
  if (labelIds.length !== 1 || labelIds[0] !== containerId) {
    throw new Error("Portable registry ownership is ambiguous");
  }
  return {
    present: true,
    removeAndVerify: () => {
      transport.assertRuntimeAuthority();
      const currentId = inspectRegistryContainer(transport);
      if (currentId !== containerId) {
        throw new Error("The portable registry container changed after prevalidation");
      }
      transport.podman(["rm", "--force", containerId]);
      const exact = transport.podman(["inspect", containerId]);
      if (!isMissingContainer(exact)) {
        if (exact.status !== 0 || exact.error) {
          requireCommand(exact, "Verifying portable registry removal");
        }
        throw new Error("The managed portable registry container still exists after removal");
      }
      if (
        inspectRegistryContainer(transport) !== null ||
        registryLabelContainerIds(transport).length
      ) {
        throw new Error("A managed portable registry container remains after removal");
      }
      transport.assertRuntimeAuthority();
    },
  };
}

function defaultSystemctl(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): PortablePodmanLifecycleCommandResult {
  const result = spawnSync("systemctl", [...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
    ...(result.error ? { error: result.error } : {}),
  };
}

function parseUserManagerEnvironment(output: string): Map<string, string> {
  if (Buffer.byteLength(output, "utf8") > MAX_SYSTEMD_ENVIRONMENT_BYTES || output.includes("\0")) {
    throw new Error("The current-user systemd manager environment is too large or invalid");
  }
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error("The current-user systemd manager environment is malformed");
    const name = match[1]!;
    if (values.has(name)) {
      throw new Error(`The current-user systemd manager environment repeats '${name}'`);
    }
    values.set(name, match[2]!);
  }
  return values;
}

function inspectPortableUserManagerEnvironment(
  authority: CheckpointPortableRuntimeAuthority,
  env: NodeJS.ProcessEnv,
  deps: PortableRuntimeCleanupDeps,
): {
  readonly commandEnv: NodeJS.ProcessEnv;
  readonly systemctl: NonNullable<PortableRuntimeCleanupDeps["systemctl"]>;
  readonly values: ReadonlyMap<string, string | undefined>;
} {
  const systemctl = deps.systemctl ?? defaultSystemctl;
  const commandEnv = portablePodmanCommandEnvironment(authority, env);
  const show = systemctl(["--user", "show-environment"], commandEnv);
  requireCommand(show, "Inspecting the current-user systemd manager environment");
  const current = parseUserManagerEnvironment(String(show.stdout ?? ""));
  return {
    commandEnv,
    systemctl,
    values: new Map(PORTABLE_SELECTOR_NAMES.map((name) => [name, current.get(name)])),
  };
}

function clearPortableUserManagerSelectors(
  authority: CheckpointPortableRuntimeAuthority,
  env: NodeJS.ProcessEnv,
  deps: PortableRuntimeCleanupDeps,
): string[] {
  const { commandEnv, systemctl, values } = inspectPortableUserManagerEnvironment(
    authority,
    env,
    deps,
  );
  const expected = new Map<string, string>([
    ["CONTAINERS_CONF", path.join(authority.configHome, "nemoclaw", "portable", "containers.conf")],
    ["NETAVARK_FW", "iptables"],
  ]);
  const unset = [...expected.entries()]
    .filter(([name, value]) => values.get(name) === value)
    .map(([name]) => name);
  if (unset.length === 0) return [];
  requireCommand(
    systemctl(["--user", "unset-environment", ...unset], commandEnv),
    "Clearing NemoClaw portable selectors from the current-user systemd manager",
  );
  const verified = systemctl(["--user", "show-environment"], commandEnv);
  requireCommand(verified, "Verifying the current-user systemd manager environment");
  const remaining = parseUserManagerEnvironment(String(verified.stdout ?? ""));
  if (unset.some((name) => remaining.has(name))) {
    throw new Error("A NemoClaw portable selector remains in the current-user systemd manager");
  }
  return unset;
}

/** Verify sandbox absence, remove the exact managed registry, and clear exact selectors. */
export function removePortableSharedResources(
  input: PortableRuntimeCleanupInput,
  deps: PortableRuntimeCleanupDeps = {},
): { readonly registryRemoved: boolean; readonly selectorsRemoved: readonly string[] } {
  const receipts = currentReceipts(input.stateDir);
  if (receipts.length === 0) return { registryRemoved: false, selectorsRemoved: [] };
  return withPortableFences(input, receipts, deps, () => {
    if (!isDeepStrictEqual(currentReceipts(input.stateDir), receipts)) {
      throw new Error("Portable lifecycle receipts changed while uninstall acquired its fences");
    }
    const authority = commonRuntimeAuthority(receipts);
    const transport = createPortablePodmanLifecycleTransport(authority, {
      ...deps,
      env: input.env,
      stateDir: input.stateDir,
    });
    const sandboxes = receipts.map((receipt) =>
      preparePortableDemoSandboxRemoval(receipt, transport, input.stateDir),
    );
    if (sandboxes.some((target) => target.present)) {
      throw new Error("A receipt-owned portable sandbox remains before shared runtime cleanup");
    }
    for (const target of sandboxes) target.verifyAbsent();
    const registry = preparePortableRegistryRemoval(transport);
    registry.removeAndVerify();
    const selectorsRemoved = clearPortableUserManagerSelectors(authority, input.env, deps);
    return { registryRemoved: registry.present, selectorsRemoved };
  });
}
