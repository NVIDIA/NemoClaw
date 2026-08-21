// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";
import { isDeepStrictEqual } from "node:util";

import type { CheckpointPortableRuntimeAuthority } from "../../state/onboard-checkpoint-types";
import { hasPortableUninstallAuthority } from "../../onboard/portable-retirement-authority";
import { withMcpLifecycleLockSync } from "../../state/mcp-lifecycle-lock-acquisition";
import {
  inspectPortableRetirementRecovery,
  PORTABLE_RETIREMENT_STATE_ENTRIES,
  preparePortableRetirement,
  publishAndRetirePortableEvidence,
  resumePortableEvidenceRetirement,
  withPortableHostFence,
  type PreparedPortableRetirement,
  type PortableRetirementRecovery,
} from "../../state/portable-uninstall-retirement";

export { PORTABLE_RETIREMENT_STATE_ENTRIES, withPortableHostFence };
import { withProcessBoundRegistryLockAt } from "../../state/registry/lock";
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
import {
  inspectHermesPortableUninstallSandboxNames,
  runHermesPortableUninstall,
  type HermesPortableUninstallDeps,
} from "./hermes-portable-uninstall";
import { HERMES_PORTABLE_UNINSTALL_JOURNAL_FILE } from "./hermes-portable-uninstall-transaction";

export { HERMES_PORTABLE_UNINSTALL_JOURNAL_FILE };

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
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface PortableRegistryRemoval {
  readonly present: boolean;
  removeAndVerify(): void;
}

export interface PortableRuntimeCleanupInput {
  readonly env: NodeJS.ProcessEnv;
  readonly gatewayName: string;
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
  readonly withRegistryLock?: <T>(registryFile: string, operation: () => T) => T;
  readonly inspectRetirement?: (homeDir: string) => PortableRetirementRecovery | null;
  readonly prepareRetirement?: (
    homeDir: string,
    receiptBasenames: readonly string[],
  ) => PreparedPortableRetirement;
  readonly publishRetirement?: (prepared: PreparedPortableRetirement) => void;
  readonly resumeRetirement?: (homeDir: string) => void;
  readonly hermesPortable?: HermesPortableUninstallDeps;
  readonly inspectHermesPortableSandboxNames?: typeof inspectHermesPortableUninstallSandboxNames;
  readonly runHermesPortableUninstall?: typeof runHermesPortableUninstall;
}

export interface PortableRuntimeCleanupResult {
  readonly registryRemoved: boolean;
  readonly sandboxContainersRemoved: number;
  readonly selectorsRemoved: readonly string[];
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

function withPortableFences<T>(
  input: PortableRuntimeCleanupInput,
  sandboxNames: readonly string[],
  deps: PortableRuntimeCleanupDeps,
  operation: () => T,
): T {
  const lifecycleStateDir = path.join(input.stateDir, "state");
  const withLifecycleLock =
    deps.withLifecycleLock ??
    (<Value>(sandboxName: string, inner: () => Value, stateDir: string) =>
      withMcpLifecycleLockSync(sandboxName, inner, { stateDir }));
  const withRegistryLock = deps.withRegistryLock ?? withProcessBoundRegistryLockAt;
  const acquireNext = (index: number): T => {
    const sandboxName = sandboxNames[index];
    return sandboxName
      ? withLifecycleLock(sandboxName, () => acquireNext(index + 1), lifecycleStateDir)
      : withRegistryLock(input.registryFile, operation);
  };
  return acquireNext(0);
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
  gatewayName: string,
): void {
  if (!entry) {
    throw new Error(
      `Portable lifecycle receipt for sandbox '${receipt.sandboxName}' has no current registry ownership`,
    );
  }
  if (
    registryEntryGatewayPort(entry) !== gatewayPort ||
    entry.gatewayPort !== gatewayPort ||
    entry.gatewayName !== gatewayName ||
    entry.agent !== "openclaw" ||
    entry.openshellDriver !== "docker" ||
    entry.lifecycleGeneration !== receipt.registryGeneration
  ) {
    throw new Error(
      `Portable lifecycle receipt for sandbox '${receipt.sandboxName}' does not match its current registry ownership`,
    );
  }
}

function requireCompleteReceiptRegistryOwnership(
  receipts: readonly PortableDemoLifecycleReceiptRecord[],
  registry: ReturnType<typeof readGatewayRegistryFile>,
  gatewayPort: number,
  gatewayName: string,
): string {
  if (!registry) throw new Error("Portable lifecycle receipts have no current sandbox registry");
  const receiptNames = receipts.map((receipt) => receipt.sandboxName).sort();
  for (const receipt of receipts) {
    requireReceiptRegistryOwnership(
      receipt,
      registry.sandboxes[receipt.sandboxName],
      gatewayPort,
      gatewayName,
    );
  }
  const registryNames = Object.keys(registry.sandboxes).sort();
  if (!isDeepStrictEqual(registryNames, receiptNames)) {
    throw new Error(
      "Portable sandbox registry ownership is not represented by the complete lifecycle receipt set",
    );
  }
  return gatewayName;
}

function currentReceipts(stateDir: string): PortableDemoLifecycleReceiptRecord[] {
  return listPortableDemoSandboxLifecycleReceipts(stateDir).sort((left, right) =>
    compareCodeUnits(left.sandboxName, right.sandboxName),
  );
}

/** Detect portable uninstall from strict durable receipts, never ambient selectors or names. */
export function hasPortableRuntimeCleanup(stateDir: string): boolean {
  const homeDir = path.dirname(stateDir);
  const registryFile = path.join(stateDir, "sandboxes.json");
  if (
    inspectHermesPortableUninstallSandboxNames({
      env: process.env,
      homeDir,
      registryFile,
      stateDir,
    })
  ) {
    return true;
  }
  return hasPortableUninstallAuthority(
    {
      homeDir,
      registryFile,
      sessionFile: path.join(stateDir, "onboard-session.json"),
      stateDir,
    },
    {
      loadRegistry: () => {
        const registry = readGatewayRegistryFile(homeDir, registryFile);
        if (!registry) throw new Error("Completed onboarding registry is missing");
        return registry;
      },
    },
  );
}

export function portableRetirementPreservationEntries(stateDir: string): {
  config: string[];
  stateRoot: string[];
} {
  const artifacts = inspectPortableRetirementRecovery(path.dirname(stateDir))?.artifacts ?? [];
  return {
    config: artifacts.filter(({ root }) => root === "config").map(({ basename }) => basename),
    stateRoot: artifacts.filter(({ root }) => root === "registry").map(({ basename }) => basename),
  };
}

function recordedRegistrySandboxNames(registryBytes: Buffer): string[] {
  let registry: unknown;
  try {
    registry = JSON.parse(UTF8.decode(registryBytes));
  } catch {
    throw new Error("Recorded portable registry authority is malformed");
  }
  if (!isRecord(registry) || !isRecord(registry.sandboxes)) {
    throw new Error("Recorded portable registry authority is invalid");
  }
  const names = Object.entries(registry.sandboxes).map(([name, value]) => {
    if (!isRecord(value) || value.name !== name || name.length < 1 || name.length > 256) {
      throw new Error("Recorded portable registry sandbox identity is invalid");
    }
    return name;
  });
  return names.sort();
}

/** Remove receipt-owned portable resources under lifecycle and registry locks through retirement. */
export function runPortableRuntimeCleanupTransaction(
  input: PortableRuntimeCleanupInput,
  continueAfterSandboxRemoval: (
    removed: number,
    sandboxNames: readonly string[],
    gatewayName: string,
  ) => boolean,
  deps: PortableRuntimeCleanupDeps = {},
): PortableRuntimeCleanupResult | null {
  const hermesInput = {
    env: input.env,
    homeDir: input.homeDir,
    registryFile: input.registryFile,
    stateDir: input.stateDir,
  };
  const hermesSandboxNames = (
    deps.inspectHermesPortableSandboxNames ?? inspectHermesPortableUninstallSandboxNames
  )(hermesInput);
  if (hermesSandboxNames) {
    const names = [...hermesSandboxNames].sort(compareCodeUnits);
    return withPortableFences(input, names, deps, () => {
      const result = (deps.runHermesPortableUninstall ?? runHermesPortableUninstall)(
        hermesInput,
        deps.hermesPortable,
      );
      return {
        registryRemoved: false,
        sandboxContainersRemoved: result.sandboxContainersRemoved,
        selectorsRemoved: [],
      };
    });
  }
  const inspectRetirement = deps.inspectRetirement ?? inspectPortableRetirementRecovery;
  const recovery = inspectRetirement(input.homeDir);
  if (recovery) {
    const sandboxNames = recovery.registryBytes
      ? recordedRegistrySandboxNames(recovery.registryBytes)
      : [];
    return withPortableFences(input, sandboxNames, deps, () => {
      (deps.resumeRetirement ?? resumePortableEvidenceRetirement)(input.homeDir);
      return { registryRemoved: false, sandboxContainersRemoved: 0, selectorsRemoved: [] };
    });
  }
  const receipts = currentReceipts(input.stateDir);
  const registry = readGatewayRegistryFile(input.homeDir, input.registryFile);
  if (receipts.length === 0) {
    throw new Error("Portable lifecycle receipts disappeared before uninstall acquired its fences");
  }
  return withPortableFences(
    input,
    receipts.map((receipt) => receipt.sandboxName),
    deps,
    () => {
      const current = currentReceipts(input.stateDir);
      const currentRegistry = readGatewayRegistryFile(input.homeDir, input.registryFile);
      if (!isDeepStrictEqual(current, receipts) || !isDeepStrictEqual(currentRegistry, registry)) {
        throw new Error(
          "Portable lifecycle or registry state changed while uninstall acquired its fences",
        );
      }
      const authority = commonRuntimeAuthority(receipts);
      const transport = createPortablePodmanLifecycleTransport(authority, {
        ...deps,
        env: input.env,
        stateDir: input.stateDir,
      });
      const gatewayName = requireCompleteReceiptRegistryOwnership(
        receipts,
        registry,
        input.gatewayPort,
        input.gatewayName,
      );
      const receiptBasenames = receipts.map(
        (receipt) => `${createHash("sha256").update(receipt.sandboxName).digest("hex")}.json`,
      );
      const retirement = (deps.prepareRetirement ?? preparePortableRetirement)(
        input.homeDir,
        receiptBasenames,
      );
      const prepared = receipts.map((receipt) =>
        preparePortableDemoSandboxRemoval(receipt, transport, input.stateDir),
      );
      const portableRegistry = preparePortableRegistryRemoval(transport);
      inspectPortableUserManagerEnvironment(authority, input.env, deps);
      for (const target of prepared) target.removeAndVerify();
      const sandboxContainersRemoved = prepared.filter((target) => target.present).length;
      if (
        !continueAfterSandboxRemoval(
          sandboxContainersRemoved,
          receipts.map((receipt) => receipt.sandboxName),
          gatewayName,
        )
      )
        return null;
      if (
        !isDeepStrictEqual(currentReceipts(input.stateDir), receipts) ||
        !isDeepStrictEqual(readGatewayRegistryFile(input.homeDir, input.registryFile), registry)
      ) {
        throw new Error(
          "Portable lifecycle or registry state changed during exact uninstall cleanup",
        );
      }
      for (const target of prepared) target.verifyAbsent();
      portableRegistry.removeAndVerify();
      const selectorsRemoved = clearPortableUserManagerSelectors(authority, input.env, deps);
      if (
        !isDeepStrictEqual(currentReceipts(input.stateDir), receipts) ||
        !isDeepStrictEqual(readGatewayRegistryFile(input.homeDir, input.registryFile), registry)
      ) {
        throw new Error("Portable lifecycle or registry state changed before evidence retirement");
      }
      (deps.publishRetirement ?? publishAndRetirePortableEvidence)(retirement);
      return {
        registryRemoved: portableRegistry.present,
        sandboxContainersRemoved,
        selectorsRemoved,
      };
    },
  );
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
      requireCommand(
        transport.podman(["rm", "--force", containerId]),
        "Removing the managed portable registry container",
      );
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
    timeout: 30_000,
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
    .filter(([name, value]) =>
      [value, `$'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`].includes(
        values.get(name) ?? "",
      ),
    )
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
