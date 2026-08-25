// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { assessWindowsMxcProcessContainerCandidate } from "../../../src/lib/onboard/windows-mxc/host-qualification.ts";
import {
  sha256File,
  sha256WindowsOpenClawArtifactTree,
} from "../../../tools/e2e/windows-mxc-openclaw-artifact-tree.mts";
import {
  type ChildProcessProgress,
  spawnObservedChild,
} from "../fixtures/observed-child-process.ts";

type QualificationProgress = ChildProcessProgress & {
  hasReached(label: string): boolean;
  phase(label: string): void;
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^[0-9]+(?:[.][0-9]+){2,3}(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 180_000;
const TERMINATION_TIMEOUT_MS = 15_000;
const WINDOWS_PROCESS_ENVIRONMENT_NAMES = [
  "ComSpec",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "Path",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "SystemDrive",
  "SystemRoot",
  "TEMP",
  "TMP",
  "windir",
] as const;

const AGENT_ENVIRONMENT_NAMES = [
  "COMSPEC",
  "LOCALAPPDATA",
  "NEMOCLAW_MXC_E2E_DENY_PATH",
  "NEMOCLAW_MXC_E2E_ENTRY",
  "NEMOCLAW_MXC_E2E_HEARTBEAT_PATH",
  "NEMOCLAW_MXC_E2E_HOME",
  "NEMOCLAW_MXC_E2E_MOCK_PORT",
  "NEMOCLAW_MXC_E2E_NODE",
  "NEMOCLAW_MXC_E2E_OPENCLAW_PORT",
  "NEMOCLAW_MXC_E2E_OPENCLAW_PID_PATH",
  "NEMOCLAW_MXC_E2E_OUTCOME_PATH",
  "NEMOCLAW_MXC_E2E_READY_PATH",
  "NEMOCLAW_MXC_E2E_RESULT_PATH",
  "NEMOCLAW_MXC_E2E_STOP_PATH",
  "NEMOCLAW_MXC_E2E_TOKEN",
  "PATH",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "WINDIR",
] as const;

export interface WindowsMxcOpenClawQualificationInputs {
  readonly artifactDirectory: string;
  readonly declaredHostPreparation: "wxc-host-prep-prepare-system-drive";
  readonly expected: {
    readonly nemoClawRevision: string;
    readonly nodeSha256: string;
    readonly openClawArtifactTreeSha256: string;
    readonly openClawEntrySha256: string;
    readonly openShellCliSha256: string;
    readonly openShellGatewaySha256: string;
    readonly openShellRelaySha256: string;
    readonly wxcExecSha256: string;
  };
  readonly openClaw: {
    readonly entryPath: string;
    readonly nodePath: string;
    readonly root: string;
    readonly version: string;
  };
  readonly openShell: {
    readonly cliPath: string;
    readonly gatewayPath: string;
    readonly packageVersion: string;
    readonly relayPath: string;
    readonly revision: string;
    readonly wxcExecPath: string;
  };
  readonly workDirectory: string;
}

export type CommandResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

export interface WindowsProcessIdentity {
  readonly commandLine: string;
  readonly creationDate: string;
  readonly executablePath: string;
  readonly parentProcessId: number;
  readonly processId: number;
}

export type TrustedOpenClawProcessIdentity = {
  readonly child: WindowsProcessIdentity;
  readonly parent: WindowsProcessIdentity;
};

type QualificationChecks = {
  readonly artifactIdentity: boolean;
  readonly filesystemControlWrite: boolean;
  readonly filesystemDeniedWrite: boolean;
  readonly forwardAuthenticatedHealth: boolean;
  readonly forwardListening: boolean;
  readonly forwardedChatExactReply: boolean;
  readonly openClawHealth: boolean;
  readonly openClawProcessPresentWhileReady: boolean;
  readonly registryPresentWhileReady: boolean;
  readonly registryRemovedAfterDelete: boolean;
  readonly sandboxCreateAccepted: boolean;
  readonly sandboxDeleteAccepted: boolean;
  readonly workloadTerminatedByDelete: boolean;
};

export interface WindowsMxcOpenClawQualificationReceipt {
  readonly schemaVersion: 2;
  readonly classification: "inactive-candidate";
  readonly backend: "process_container";
  readonly configuration: {
    readonly declaredHostPreparation: "wxc-host-prep-prepare-system-drive";
    readonly egressProxy: true;
    readonly pcCapabilities: readonly ["privateNetworkClientServer"];
    readonly pcLeastPrivilege: false;
    readonly shareAtDriveRoot: true;
  };
  readonly identities: {
    readonly host: {
      readonly architecture: "x64";
      readonly processElevated: boolean;
      readonly platform: "win32";
      readonly release: string;
    };
    readonly nemoClawRevision: string;
    readonly openClaw: {
      readonly artifactTreeSha256: string;
      readonly entrySha256: string;
      readonly nodeSha256: string;
      readonly version: string;
    };
    readonly openShell: {
      readonly cliSha256: string;
      readonly gatewaySha256: string;
      readonly packageVersion: string;
      readonly relaySha256: string;
      readonly revision: string;
    };
    readonly wxcExecSha256: string;
  };
  readonly checks: QualificationChecks;
  readonly cleanup: {
    readonly boundedStopMarkerNeeded: boolean;
    readonly emergencyProcessTerminationNeeded: boolean;
    readonly emergencyGatewayTerminationNeeded: boolean;
    readonly emergencyForwardTerminationNeeded: boolean;
    readonly forwardListenerStopped: boolean;
    readonly forwardProcessStopped: boolean;
    readonly gatewayProcessStopped: boolean;
    readonly openClawProcessStopped: boolean;
    readonly retainedSandboxName: string | null;
    readonly runDirectoryRemoved: boolean;
    readonly sandboxDeleteRetried: boolean;
    readonly sensitiveRuntimeArtifactsRemoved: boolean;
  };
  readonly verdict: "pass" | "fail";
  readonly deferred: readonly [
    "gateway-mtls",
    "managed-inference",
    "governed-egress",
    "gateway-restart-recovery",
    "production-activation",
  ];
}

export interface WindowsMxcLocalSetupOwnership {
  closeDescriptor(descriptor: number): void;
  releaseRoot(root: string): void;
  trackDescriptor(descriptor: number): number;
  trackRoot(root: string): string;
}

class LocalSetupOwnership implements WindowsMxcLocalSetupOwnership {
  readonly #descriptors = new Set<number>();
  readonly #roots = new Set<string>();

  closeDescriptor(descriptor: number): void {
    try {
      fs.closeSync(descriptor);
    } finally {
      this.#descriptors.delete(descriptor);
    }
  }

  releaseRoot(root: string): void {
    this.#roots.delete(root);
  }

  trackDescriptor(descriptor: number): number {
    this.#descriptors.add(descriptor);
    return descriptor;
  }

  trackRoot(root: string): string {
    this.#roots.add(root);
    return root;
  }

  cleanup(): readonly unknown[] {
    const failures: unknown[] = [];
    for (const descriptor of this.#descriptors) {
      try {
        this.closeDescriptor(descriptor);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const root of [...this.#roots].reverse()) {
      try {
        fs.rmSync(root, { force: true, recursive: true });
        this.releaseRoot(root);
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }
}

export async function withWindowsMxcLocalSetupOwnership<T, R extends object>(input: {
  readonly failureReceipt: (localArtifactsRemoved: boolean) => R;
  readonly operation: (ownership: WindowsMxcLocalSetupOwnership) => Promise<T>;
  readonly receiptPath: string;
}): Promise<T> {
  const ownership = new LocalSetupOwnership();
  try {
    return await input.operation(ownership);
  } catch (error) {
    const cleanupFailures = [...ownership.cleanup()];
    const localArtifactsRemoved = cleanupFailures.length === 0;
    try {
      fs.writeFileSync(
        input.receiptPath,
        `${JSON.stringify(input.failureReceipt(localArtifactsRemoved), null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
    } catch (receiptError) {
      cleanupFailures.push(receiptError);
    }
    throw new AggregateError(
      [error, ...cleanupFailures],
      `Windows MXC local setup failed; receipt: ${input.receiptPath}`,
    );
  }
}

export async function runWindowsMxcForwardCleanup(input: {
  readonly childWasRunning: boolean;
  readonly sandboxDeleteAccepted: boolean;
  readonly stopChild: () => Promise<void>;
  readonly terminateTrustedProcessIfAlive: () => Promise<boolean>;
  readonly waitForListenerClosed: () => Promise<boolean>;
  readonly waitForProcessExit: () => Promise<boolean>;
}): Promise<{
  readonly emergencyTerminationNeeded: boolean;
  readonly failures: readonly unknown[];
  readonly listenerStopped: boolean;
  readonly processStopped: boolean;
}> {
  const failures: unknown[] = [];
  let emergencyTerminationNeeded = input.childWasRunning && input.sandboxDeleteAccepted;
  let listenerStopped = false;
  let processStopped = false;

  try {
    await input.stopChild();
  } catch (error) {
    failures.push(error);
  }
  try {
    if (await input.terminateTrustedProcessIfAlive()) emergencyTerminationNeeded = true;
  } catch (error) {
    failures.push(error);
  }
  try {
    processStopped = await input.waitForProcessExit();
  } catch (error) {
    failures.push(error);
  }
  try {
    listenerStopped = await input.waitForListenerClosed();
  } catch (error) {
    failures.push(error);
  }

  return {
    emergencyTerminationNeeded,
    failures,
    listenerStopped,
    processStopped,
  };
}

function buildWindowsMxcSetupFailureReceipt(
  inputs: WindowsMxcOpenClawQualificationInputs,
  processElevated: boolean,
  localArtifactsRemoved: boolean,
): WindowsMxcOpenClawQualificationReceipt {
  return {
    schemaVersion: 2,
    classification: "inactive-candidate",
    backend: "process_container",
    configuration: {
      declaredHostPreparation: inputs.declaredHostPreparation,
      egressProxy: true,
      pcCapabilities: ["privateNetworkClientServer"],
      pcLeastPrivilege: false,
      shareAtDriveRoot: true,
    },
    identities: {
      host: {
        architecture: "x64",
        processElevated,
        platform: "win32",
        release: os.release(),
      },
      nemoClawRevision: inputs.expected.nemoClawRevision,
      openClaw: {
        artifactTreeSha256: inputs.expected.openClawArtifactTreeSha256,
        entrySha256: inputs.expected.openClawEntrySha256,
        nodeSha256: inputs.expected.nodeSha256,
        version: inputs.openClaw.version,
      },
      openShell: {
        cliSha256: inputs.expected.openShellCliSha256,
        gatewaySha256: inputs.expected.openShellGatewaySha256,
        packageVersion: inputs.openShell.packageVersion,
        relaySha256: inputs.expected.openShellRelaySha256,
        revision: inputs.openShell.revision,
      },
      wxcExecSha256: inputs.expected.wxcExecSha256,
    },
    checks: {
      artifactIdentity: true,
      filesystemControlWrite: false,
      filesystemDeniedWrite: false,
      forwardAuthenticatedHealth: false,
      forwardListening: false,
      forwardedChatExactReply: false,
      openClawHealth: false,
      openClawProcessPresentWhileReady: false,
      registryPresentWhileReady: false,
      registryRemovedAfterDelete: false,
      sandboxCreateAccepted: false,
      sandboxDeleteAccepted: false,
      workloadTerminatedByDelete: false,
    },
    cleanup: {
      boundedStopMarkerNeeded: false,
      emergencyProcessTerminationNeeded: false,
      emergencyGatewayTerminationNeeded: false,
      emergencyForwardTerminationNeeded: false,
      forwardListenerStopped: false,
      forwardProcessStopped: false,
      gatewayProcessStopped: false,
      openClawProcessStopped: false,
      retainedSandboxName: null,
      runDirectoryRemoved: localArtifactsRemoved,
      sandboxDeleteRetried: false,
      sensitiveRuntimeArtifactsRemoved: localArtifactsRemoved,
    },
    verdict: "fail",
    deferred: [
      "gateway-mtls",
      "managed-inference",
      "governed-egress",
      "gateway-restart-recovery",
      "production-activation",
    ],
  };
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function expectedPattern(environment: NodeJS.ProcessEnv, name: string, pattern: RegExp): string {
  const value = requiredEnvironment(environment, name);
  if (!pattern.test(value)) throw new Error(`${name} has an unsupported format`);
  return value;
}

function realRegularFile(input: string, name: string): string {
  const absolute = path.resolve(input);
  const status = fs.lstatSync(absolute);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`${name} must be a regular file, not a link`);
  }
  return fs.realpathSync(absolute);
}

function realDirectory(input: string, name: string): string {
  const absolute = path.resolve(input);
  const status = fs.lstatSync(absolute);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`${name} must be a directory, not a link`);
  }
  return fs.realpathSync(absolute);
}

function requireDescendant(file: string, root: string, name: string): void {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${name} must be a child of the OpenClaw artifact root`);
  }
}

export function parseWindowsMxcOpenClawQualificationEnvironment(
  environment: NodeJS.ProcessEnv,
): WindowsMxcOpenClawQualificationInputs {
  const openClawRoot = realDirectory(
    requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_OPENCLAW_ROOT"),
    "OpenClaw artifact root",
  );
  const nodePath = realRegularFile(
    requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_NODE"),
    "OpenClaw Node.js executable",
  );
  const entryPath = realRegularFile(
    requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_OPENCLAW_ENTRY"),
    "OpenClaw entrypoint",
  );
  requireDescendant(nodePath, openClawRoot, "OpenClaw Node.js executable");
  requireDescendant(entryPath, openClawRoot, "OpenClaw entrypoint");

  return {
    artifactDirectory: realDirectory(
      requiredEnvironment(environment, "E2E_ARTIFACT_DIR"),
      "E2E artifact directory",
    ),
    declaredHostPreparation: (() => {
      const value = requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_HOST_PREPARATION");
      if (value !== "wxc-host-prep-prepare-system-drive") {
        throw new Error("NEMOCLAW_WINDOWS_MXC_HOST_PREPARATION has an unsupported value");
      }
      return "wxc-host-prep-prepare-system-drive" as const;
    })(),
    workDirectory: realDirectory(
      requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_WORK_ROOT"),
      "Windows MXC qualification work root",
    ),
    expected: {
      nemoClawRevision: expectedPattern(environment, "NEMOCLAW_E2E_EXPECTED_SHA", REVISION_PATTERN),
      nodeSha256: expectedPattern(environment, "NEMOCLAW_WINDOWS_MXC_NODE_SHA256", SHA256_PATTERN),
      openClawArtifactTreeSha256: expectedPattern(
        environment,
        "NEMOCLAW_WINDOWS_MXC_OPENCLAW_ARTIFACT_TREE_SHA256",
        SHA256_PATTERN,
      ),
      openClawEntrySha256: expectedPattern(
        environment,
        "NEMOCLAW_WINDOWS_MXC_OPENCLAW_ENTRY_SHA256",
        SHA256_PATTERN,
      ),
      openShellCliSha256: expectedPattern(
        environment,
        "NEMOCLAW_WINDOWS_MXC_OPENSHELL_CLI_SHA256",
        SHA256_PATTERN,
      ),
      openShellGatewaySha256: expectedPattern(
        environment,
        "NEMOCLAW_WINDOWS_MXC_OPENSHELL_GATEWAY_SHA256",
        SHA256_PATTERN,
      ),
      openShellRelaySha256: expectedPattern(
        environment,
        "NEMOCLAW_WINDOWS_MXC_OPENSHELL_RELAY_SHA256",
        SHA256_PATTERN,
      ),
      wxcExecSha256: expectedPattern(
        environment,
        "NEMOCLAW_WINDOWS_MXC_WXC_EXEC_SHA256",
        SHA256_PATTERN,
      ),
    },
    openClaw: {
      entryPath,
      nodePath,
      root: openClawRoot,
      version: expectedPattern(
        environment,
        "NEMOCLAW_WINDOWS_MXC_OPENCLAW_VERSION",
        VERSION_PATTERN,
      ),
    },
    openShell: {
      cliPath: realRegularFile(
        requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_OPENSHELL_CLI"),
        "OpenShell CLI",
      ),
      gatewayPath: realRegularFile(
        requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_OPENSHELL_GATEWAY"),
        "OpenShell gateway",
      ),
      packageVersion: expectedPattern(
        environment,
        "NEMOCLAW_WINDOWS_MXC_OPENSHELL_VERSION",
        VERSION_PATTERN,
      ),
      relayPath: realRegularFile(
        requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_OPENSHELL_RELAY"),
        "OpenShell MXC supervisor relay",
      ),
      revision: expectedPattern(
        environment,
        "NEMOCLAW_WINDOWS_MXC_OPENSHELL_REVISION",
        REVISION_PATTERN,
      ),
      wxcExecPath: realRegularFile(
        requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_WXC_EXEC"),
        "OpenShell-supplied wxc-exec",
      ),
    },
  };
}

export { sha256File };

export function sandboxListContainsExactName(output: string, sandboxName: string): boolean {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error("OpenShell sandbox list JSON must be an array");
  return parsed.some(
    (entry) =>
      typeof entry === "object" && entry !== null && "name" in entry && entry.name === sandboxName,
  );
}

export function shouldRetrySandboxDelete(
  sandboxDeleteAccepted: boolean,
  exactRegistryEntryPresent: boolean,
): boolean {
  return !sandboxDeleteAccepted || exactRegistryEntryPresent;
}

export function parseWindowsProcessIdentity(output: string): WindowsProcessIdentity | null {
  if (!output.trim()) return null;
  const value: unknown = JSON.parse(output);
  if (
    typeof value !== "object" ||
    value === null ||
    !("ProcessId" in value) ||
    !Number.isSafeInteger(value.ProcessId) ||
    !("ParentProcessId" in value) ||
    !Number.isSafeInteger(value.ParentProcessId) ||
    !("ExecutablePath" in value) ||
    typeof value.ExecutablePath !== "string" ||
    !("CommandLine" in value) ||
    typeof value.CommandLine !== "string" ||
    !("CreationDate" in value) ||
    typeof value.CreationDate !== "string"
  ) {
    throw new Error("Windows process identity output is incomplete");
  }
  return {
    commandLine: value.CommandLine,
    creationDate: value.CreationDate,
    executablePath: value.ExecutablePath,
    parentProcessId: value.ParentProcessId as number,
    processId: value.ProcessId as number,
  };
}

function normalizeWindowsIdentityValue(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}

function commandLineHasExactArgument(commandLine: string, expected: string): boolean {
  const escaped = normalizeWindowsIdentityValue(expected).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[\\s\"])${escaped}(?=$|[\\s\"])`, "u").test(
    normalizeWindowsIdentityValue(commandLine),
  );
}

function commandLineHasExactArgumentPair(
  commandLine: string,
  first: string,
  second: string,
): boolean {
  const normalized = normalizeWindowsIdentityValue(commandLine);
  const pair = [first, second]
    .map((value) => normalizeWindowsIdentityValue(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join('[\\s"]+');
  return new RegExp(`(?:^|[\\s\"])${pair}(?=$|[\\s\"])`, "u").test(normalized);
}

export function sameWindowsProcessIdentity(
  expected: WindowsProcessIdentity,
  observed: WindowsProcessIdentity,
): boolean {
  return (
    expected.processId === observed.processId &&
    expected.parentProcessId === observed.parentProcessId &&
    expected.creationDate === observed.creationDate &&
    normalizeWindowsIdentityValue(expected.executablePath) ===
      normalizeWindowsIdentityValue(observed.executablePath) &&
    expected.commandLine === observed.commandLine
  );
}

export function assertExpectedOpenClawProcessIdentity(
  identity: TrustedOpenClawProcessIdentity,
  expected: {
    readonly entryPath: string;
    readonly nodePath: string;
    readonly port: number;
    readonly probeAgentPath: string;
  },
): void {
  const nodePath = normalizeWindowsIdentityValue(expected.nodePath);
  if (
    normalizeWindowsIdentityValue(identity.child.executablePath) !== nodePath ||
    normalizeWindowsIdentityValue(identity.parent.executablePath) !== nodePath ||
    identity.child.parentProcessId !== identity.parent.processId ||
    !commandLineHasExactArgument(identity.child.commandLine, expected.entryPath) ||
    !commandLineHasExactArgument(identity.child.commandLine, "gateway") ||
    !commandLineHasExactArgumentPair(identity.child.commandLine, "--port", String(expected.port)) ||
    !commandLineHasExactArgument(identity.parent.commandLine, expected.probeAgentPath)
  ) {
    throw new Error(
      "sandbox-reported PID does not match the host-observed OpenClaw process identity",
    );
  }
}

export function assertExpectedOpenShellGatewayProcessIdentity(
  identity: WindowsProcessIdentity,
  expected: { readonly gatewayPath: string; readonly port: number },
): void {
  if (
    normalizeWindowsIdentityValue(identity.executablePath) !==
      normalizeWindowsIdentityValue(expected.gatewayPath) ||
    !commandLineHasExactArgumentPair(identity.commandLine, "--port", String(expected.port)) ||
    !commandLineHasExactArgument(identity.commandLine, "--disable-tls")
  ) {
    throw new Error("spawned PID does not match the expected OpenShell gateway process identity");
  }
}

export function assertExpectedOpenShellForwardProcessIdentity(
  identity: WindowsProcessIdentity,
  expected: {
    readonly cliPath: string;
    readonly localPort: number;
    readonly sandboxName: string;
    readonly targetPort: number;
  },
): void {
  if (
    normalizeWindowsIdentityValue(identity.executablePath) !==
      normalizeWindowsIdentityValue(expected.cliPath) ||
    !commandLineHasExactArgumentPair(identity.commandLine, "forward", "service") ||
    !commandLineHasExactArgument(identity.commandLine, expected.sandboxName) ||
    !commandLineHasExactArgumentPair(
      identity.commandLine,
      "--target-port",
      String(expected.targetPort),
    ) ||
    !commandLineHasExactArgumentPair(
      identity.commandLine,
      "--local",
      `127.0.0.1:${expected.localPort}`,
    )
  ) {
    throw new Error("spawned PID does not match the expected OpenShell forward process identity");
  }
}

export function allowlistedWindowsProcessEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {};
  const allowedNames = new Set(WINDOWS_PROCESS_ENVIRONMENT_NAMES.map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && allowedNames.has(name.toLowerCase())) allowed[name] = value;
  }
  return allowed;
}

export function withoutOpenShellGatewaySelection(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const isolated: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (name.toLowerCase() !== "openshell_gateway") isolated[name] = value;
  }
  return isolated;
}

function tomlString(value: string): string {
  return JSON.stringify(value.replaceAll("\\", "/"));
}

export function renderWindowsMxcGatewayConfig(input: {
  readonly agentPath: string;
  readonly relayPath: string;
  readonly shareDirectory: string;
  readonly targetPort: number;
  readonly wxcExecPath: string;
}): string {
  return [
    "[openshell.drivers.mxc]",
    `wxc_exec_path = ${tomlString(input.wxcExecPath)}`,
    'backend = "process_container"',
    'default_configuration_id = "composable"',
    `share_dir = ${tomlString(input.shareDirectory)}`,
    `agent_cwd = ${tomlString(input.shareDirectory)}`,
    "agent_command = [",
    `  ${tomlString(input.agentPath)},`,
    `  ${tomlString(path.join(input.shareDirectory, "probe-agent.mjs"))},`,
    "]",
    "agent_env = [",
    ...AGENT_ENVIRONMENT_NAMES.map((name) => `  ${JSON.stringify(name)},`),
    "]",
    "pc_least_privilege = false",
    'pc_capabilities = ["privateNetworkClientServer"]',
    "pc_minimal_env = true",
    "egress_proxy = true",
    'egress_proxy_addr = "127.0.0.1:18080"',
    `pc_relay_spawner_path = ${tomlString(input.relayPath)}`,
    `pc_relay_target_port = ${input.targetPort}`,
    "debug = false",
    "",
  ].join("\n");
}

export function renderWindowsMxcFilesystemPolicy(input: {
  readonly openClawRoot: string;
  readonly shareDirectory: string;
}): string {
  return [
    "version: 1",
    "",
    "filesystem_policy:",
    "  include_workdir: false",
    "  read_only:",
    `    - ${JSON.stringify(input.openClawRoot.replaceAll("\\", "/"))}`,
    "  read_write:",
    `    - ${JSON.stringify(input.shareDirectory.replaceAll("\\", "/"))}`,
    "",
  ].join("\n");
}

export function renderWindowsMxcOpenClawProbeAgent(): string {
  return `import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
};
const node = required("NEMOCLAW_MXC_E2E_NODE");
const entry = required("NEMOCLAW_MXC_E2E_ENTRY");
const home = required("NEMOCLAW_MXC_E2E_HOME");
const token = required("NEMOCLAW_MXC_E2E_TOKEN");
const readyPath = required("NEMOCLAW_MXC_E2E_READY_PATH");
const resultPath = required("NEMOCLAW_MXC_E2E_RESULT_PATH");
const outcomePath = required("NEMOCLAW_MXC_E2E_OUTCOME_PATH");
const heartbeatPath = required("NEMOCLAW_MXC_E2E_HEARTBEAT_PATH");
const stopPath = required("NEMOCLAW_MXC_E2E_STOP_PATH");
const denyPath = required("NEMOCLAW_MXC_E2E_DENY_PATH");
const mockPort = required("NEMOCLAW_MXC_E2E_MOCK_PORT");
const port = required("NEMOCLAW_MXC_E2E_OPENCLAW_PORT");
const openClawPidPath = required("NEMOCLAW_MXC_E2E_OPENCLAW_PID_PATH");
const env = {
  ...process.env,
  HOME: home,
  OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:" + port,
  OPENCLAW_GATEWAY_TOKEN: token,
  USERPROFILE: home,
};
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const run = async (args, timeout = 15000) => {
  try {
    const output = await execFileAsync(node, args, {
      env,
      timeout,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: output.stdout, stderr: output.stderr };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error.code) ? error.code : 1,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message || String(error),
    };
  }
};

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};
const mock = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "mock-chat", object: "model" }] }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(request));
  } catch {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "invalid JSON" } }));
    return;
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const hasUserMessage = messages.some(
    (message) =>
      message !== null &&
      typeof message === "object" &&
      message.role === "user" &&
      Object.hasOwn(message, "content"),
  );
  if (body?.model !== "mock-chat" || !hasUserMessage) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unexpected chat request" } }));
    return;
  }
  const id = "chatcmpl-mxc-deterministic";
  const created = Math.floor(Date.now() / 1000);
  if (body.stream === true) {
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    for (const value of [
      { id, object: "chat.completion.chunk", created, model: "mock-chat", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "mock-chat", choices: [{ index: 0, delta: { content: "CHAT_OK" }, finish_reason: null }] },
      { id, object: "chat.completion.chunk", created, model: "mock-chat", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]) response.write("data: " + JSON.stringify(value) + "\\n\\n");
    response.end("data: [DONE]\\n\\n");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model: "mock-chat",
    choices: [{ index: 0, message: { role: "assistant", content: "CHAT_OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
});
await new Promise((resolve, reject) => {
  mock.once("error", reject);
  mock.listen(Number(mockPort), "127.0.0.1", resolve);
});

const configDirectory = join(home, ".openclaw");
mkdirSync(configDirectory, { recursive: true });
writeFileSync(join(configDirectory, "openclaw.json"), JSON.stringify({
  models: {
    mode: "merge",
    providers: {
      mock: {
        baseUrl: "http://127.0.0.1:" + mockPort + "/v1",
        apiKey: "unused",
        api: "openai-completions",
        timeoutSeconds: 180,
        models: [{
          id: "mock-chat",
          name: "mock/mock-chat",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 131072,
          maxTokens: 4096,
        }],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "mock/mock-chat" },
      timeoutSeconds: 180,
      skipBootstrap: true,
      thinkingDefault: "off",
    },
    list: [{ id: "main", default: true }],
  },
  gateway: {
    mode: "local",
    port: Number(port),
    controlUi: {
      allowInsecureAuth: true,
      dangerouslyDisableDeviceAuth: false,
      allowedOrigins: ["http://127.0.0.1:" + port],
    },
    trustedProxies: ["127.0.0.1", "::1"],
    auth: { token: "" },
    reload: { mode: "hot" },
  },
}), "utf8");

writeFileSync(resultPath, JSON.stringify({ phase: "control", controlWrite: true }), "utf8");
let deniedWrite = false;
try {
  writeFileSync(denyPath, "denied write must not land", "utf8");
} catch {
  deniedWrite = true;
}

const version = await run([entry, "--version"]);
const gateway = spawn(
  node,
  [
    entry,
    "gateway",
    "run",
    "--dev",
    "--allow-unconfigured",
    "--auth",
    "token",
    "--bind",
    "loopback",
    "--port",
    port,
  ],
  { env, stdio: "ignore", windowsHide: true },
);
let gatewaySpawnError = null;
gateway.once("error", (error) => {
  gatewaySpawnError = error instanceof Error ? error.message : String(error);
});
if (gateway.pid !== undefined) writeFileSync(openClawPidPath, String(gateway.pid), "utf8");

let healthObserved = false;
let lastHealth = { exitCode: null, stdout: "", stderr: "" };
const deadline = Date.now() + 120000;
while (Date.now() < deadline && gateway.exitCode === null && gatewaySpawnError === null) {
  lastHealth = await run([
    entry,
    "gateway",
    "health",
    "--json",
    "--timeout",
    "5000",
  ]);
  if (lastHealth.exitCode === 0) {
    healthObserved = true;
    break;
  }
  await sleep(1000);
}

const result = {
  controlWrite: true,
  deniedWrite,
  gatewayExitedBeforeReadiness: gateway.exitCode !== null,
  gatewaySpawnError,
  healthObserved,
  openClawVersion: version.stdout.trim(),
  versionExitCode: version.exitCode,
};
writeFileSync(resultPath, JSON.stringify(result), "utf8");
writeFileSync(outcomePath, JSON.stringify(result), "utf8");
if (healthObserved) writeFileSync(readyPath, JSON.stringify(result), "utf8");

while (healthObserved && gateway.exitCode === null && !existsSync(stopPath)) {
  writeFileSync(heartbeatPath, String(Date.now()), "utf8");
  await sleep(250);
}

if (gateway.exitCode === null) {
  gateway.kill();
  await Promise.race([
    new Promise((resolve) => gateway.once("exit", resolve)),
    sleep(5000),
  ]);
}
await new Promise((resolve) => mock.close(() => resolve()));
process.exit(healthObserved && deniedWrite ? 0 : 1);
`;
}

function commandDetail(result: CommandResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

async function runCommand(
  file: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  progress: ChildProcessProgress,
  activityLabel: string,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  const child = spawnObservedChild(file, args, {
    activityLabel,
    progress,
    spawn: {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  });
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(file)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        clearTimeout(timer);
        child.kill();
        reject(new Error(`${path.basename(file)} output exceeded its bound`));
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

export function parseWindowsProcessQueryResult(
  result: CommandResult,
): WindowsProcessIdentity | null {
  if (result.exitCode === 3) return null;
  if (result.exitCode !== 0) {
    throw new Error(`host process identity query failed: ${commandDetail(result)}`);
  }
  return parseWindowsProcessIdentity(result.stdout);
}

async function observeWindowsProcessIdentity(
  processId: number,
  powershellPath: string,
  environment: NodeJS.ProcessEnv,
  progress: ChildProcessProgress,
  activityLabel: string,
): Promise<WindowsProcessIdentity | null> {
  const result = await runCommand(
    powershellPath,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${processId}\" -ErrorAction Stop; if ($null -eq $process) { exit 3 }; $process | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine, CreationDate | ConvertTo-Json -Compress`,
    ],
    environment,
    progress,
    activityLabel,
  );
  return parseWindowsProcessQueryResult(result);
}

async function observeHostProcessElevation(
  powershellPath: string,
  environment: NodeJS.ProcessEnv,
  progress: ChildProcessProgress,
): Promise<boolean> {
  const result = await runCommand(
    powershellPath,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) | ConvertTo-Json -Compress",
    ],
    environment,
    progress,
    "command: windows-mxc-host-elevation",
  );
  if (result.exitCode !== 0) {
    throw new Error(`host elevation query failed: ${commandDetail(result)}`);
  }
  const value: unknown = JSON.parse(result.stdout);
  if (typeof value !== "boolean") throw new Error("host elevation output is not boolean");
  return value;
}

async function waitForOwnedLoopbackListener(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly port: number;
  readonly powershellPath: string;
  readonly processId: number;
  readonly progress: ChildProcessProgress;
}): Promise<void> {
  const result = await runCommand(
    input.powershellPath,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$deadline = (Get-Date).AddMilliseconds(${COMMAND_TIMEOUT_MS}); do { $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${input.port} -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq ${input.processId} }; if ($null -ne $listener) { exit 0 }; Start-Sleep -Milliseconds 200 } while ((Get-Date) -lt $deadline); exit 4`,
    ],
    input.environment,
    input.progress,
    "command: windows-mxc-openshell-forward-listener-owner",
    COMMAND_TIMEOUT_MS + 5000,
  );
  if (result.exitCode !== 0) {
    throw new Error("OpenShell forward did not own the expected loopback listener");
  }
}

async function waitForLoopbackListenerClosed(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly port: number;
  readonly powershellPath: string;
  readonly progress: ChildProcessProgress;
}): Promise<boolean> {
  const result = await runCommand(
    input.powershellPath,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$deadline = (Get-Date).AddMilliseconds(${TERMINATION_TIMEOUT_MS}); do { $listener = Get-NetTCPConnection -LocalPort ${input.port} -State Listen -ErrorAction SilentlyContinue; if ($null -eq $listener) { exit 0 }; Start-Sleep -Milliseconds 200 } while ((Get-Date) -lt $deadline); exit 4`,
    ],
    input.environment,
    input.progress,
    "command: windows-mxc-openshell-forward-listener-cleanup",
    TERMINATION_TIMEOUT_MS + 5000,
  );
  return result.exitCode === 0;
}

function writeStopMarkerOnce(file: string): void {
  try {
    fs.writeFileSync(file, "stop\n", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function observeTrustedOpenClawProcessIdentity(input: {
  readonly entryPath: string;
  readonly nodePath: string;
  readonly port: number;
  readonly powershellPath: string;
  readonly probeAgentPath: string;
  readonly processId: number;
  readonly environment: NodeJS.ProcessEnv;
  readonly progress: ChildProcessProgress;
}): Promise<TrustedOpenClawProcessIdentity | null> {
  const child = await observeWindowsProcessIdentity(
    input.processId,
    input.powershellPath,
    input.environment,
    input.progress,
    "command: windows-mxc-openclaw-process-identity",
  );
  if (child === null) return null;
  const parent = await observeWindowsProcessIdentity(
    child.parentProcessId,
    input.powershellPath,
    input.environment,
    input.progress,
    "command: windows-mxc-openclaw-parent-identity",
  );
  if (parent === null) throw new Error("OpenClaw parent process identity is unavailable");
  const identity = { child, parent };
  assertExpectedOpenClawProcessIdentity(identity, input);
  return identity;
}

async function trustedProcessIsAlive(
  identity: WindowsProcessIdentity,
  powershellPath: string,
  environment: NodeJS.ProcessEnv,
  progress: ChildProcessProgress,
): Promise<boolean> {
  const observed = await observeWindowsProcessIdentity(
    identity.processId,
    powershellPath,
    environment,
    progress,
    "command: windows-mxc-openclaw-process-liveness",
  );
  return observed !== null && sameWindowsProcessIdentity(identity, observed);
}

async function waitForTrustedProcessExit(
  identity: WindowsProcessIdentity,
  powershellPath: string,
  environment: NodeJS.ProcessEnv,
  progress: ChildProcessProgress,
): Promise<boolean> {
  const deadline = Date.now() + TERMINATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await trustedProcessIsAlive(identity, powershellPath, environment, progress)))
      return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return !(await trustedProcessIsAlive(identity, powershellPath, environment, progress));
}

async function waitForPort(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + COMMAND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("long-running process exited before listening");
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(250);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      const finish = () => {
        socket.destroy();
        resolve(false);
      };
      socket.once("error", finish);
      socket.once("timeout", finish);
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`loopback service did not listen within ${COMMAND_TIMEOUT_MS}ms`);
}

async function freeDistinctLoopbackPorts(count: number): Promise<readonly number[]> {
  const servers: net.Server[] = [];
  try {
    const ports: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer();
      server.unref();
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("could not allocate a loopback port");
      }
      ports.push(address.port);
    }
    return ports;
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            if (!server.listening) {
              resolve();
              return;
            }
            server.close(() => resolve());
          }),
      ),
    );
  }
}

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return fs.existsSync(file);
}

async function heartbeatStopped(file: string): Promise<boolean> {
  if (!fs.existsSync(file)) return true;
  let last = fs.statSync(file).mtimeMs;
  let stableSince = Date.now();
  const deadline = Date.now() + TERMINATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const current = fs.existsSync(file) ? fs.statSync(file).mtimeMs : last;
    if (current !== last) {
      last = current;
      stableSince = Date.now();
    }
    if (Date.now() - stableSince >= 3000) return true;
  }
  return false;
}

export function normalizeReportedVersion(output: string): string | null {
  const normalized = output
    .trim()
    .replace(/^openclaw(?:\s+version)?\s+/iu, "")
    .replace(/^v(?=[0-9])/u, "")
    .replace(/\s+\([0-9a-f]{7,40}\)$/iu, "");
  return VERSION_PATTERN.test(normalized) ? normalized : null;
}

function parseEmbeddedJson(output: string, name: string): unknown {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`${name} did not contain a JSON object`);
  return JSON.parse(output.slice(start, end + 1)) as unknown;
}

export function parseOpenClawHealthResult(output: string): boolean {
  const value = parseEmbeddedJson(output, "OpenClaw health output");
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}

export function parseOpenClawExactChatReply(output: string): boolean {
  const value = parseEmbeddedJson(output, "OpenClaw agent output");
  if (
    typeof value !== "object" ||
    value === null ||
    !("status" in value) ||
    value.status !== "ok" ||
    !("result" in value) ||
    typeof value.result !== "object" ||
    value.result === null ||
    !("payloads" in value.result) ||
    !Array.isArray(value.result.payloads) ||
    value.result.payloads.length !== 1
  ) {
    return false;
  }
  const [payload] = value.result.payloads;
  return (
    typeof payload === "object" &&
    payload !== null &&
    "text" in payload &&
    typeof payload.text === "string" &&
    payload.text === "CHAT_OK"
  );
}

export function assertCleanCheckoutIdentity(input: {
  readonly expectedRevision: string;
  readonly observedRevision: string;
  readonly statusOutput: string;
}): void {
  if (input.statusOutput.trim()) {
    throw new Error("NemoClaw checkout must be clean for exact source identity");
  }
  if (input.observedRevision !== input.expectedRevision) {
    throw new Error("nemoClawRevision does not match the expected exact identity");
  }
}

function assertCurrentCheckoutIdentity(expectedRevision: string): void {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: 10_000,
    windowsHide: true,
  });
  if (revision.status !== 0) {
    throw new Error("could not resolve the NemoClaw checkout revision");
  }
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: 10_000,
    windowsHide: true,
  });
  if (status.status !== 0) throw new Error("could not inspect the NemoClaw checkout state");
  assertCleanCheckoutIdentity({
    expectedRevision,
    observedRevision: revision.stdout.trim(),
    statusOutput: status.stdout,
  });
}

function readProcessId(file: string): number | null {
  if (!fs.existsSync(file)) return null;
  const value = fs.readFileSync(file, "utf8").trim();
  if (!/^[1-9][0-9]*$/u.test(value)) return null;
  const processId = Number(value);
  return Number.isSafeInteger(processId) ? processId : null;
}

function nativeArchitecture(environment: NodeJS.ProcessEnv): "x64" | null {
  const value = (environment.PROCESSOR_ARCHITEW6432 ?? environment.PROCESSOR_ARCHITECTURE ?? "")
    .trim()
    .toLowerCase();
  return value === "amd64" ? "x64" : null;
}

function trustedWindowsSystemExecutable(
  environment: NodeJS.ProcessEnv,
  segments: readonly string[],
  name: string,
): string {
  const systemRoot = realDirectory(requiredEnvironment(environment, "SystemRoot"), "SystemRoot");
  return realRegularFile(path.join(systemRoot, ...segments), name);
}

function assertExactFileIdentity(file: string, expectedSha256: string, name: string): void {
  if (sha256File(file) !== expectedSha256) {
    throw new Error(`${name} does not match the expected exact identity`);
  }
}

export function assertExactArtifactIdentities(inputs: WindowsMxcOpenClawQualificationInputs): void {
  const observed = {
    nodeSha256: sha256File(inputs.openClaw.nodePath),
    openClawArtifactTreeSha256: sha256WindowsOpenClawArtifactTree(inputs.openClaw.root),
    openClawEntrySha256: sha256File(inputs.openClaw.entryPath),
    openShellCliSha256: sha256File(inputs.openShell.cliPath),
    openShellGatewaySha256: sha256File(inputs.openShell.gatewayPath),
    openShellRelaySha256: sha256File(inputs.openShell.relayPath),
    wxcExecSha256: sha256File(inputs.openShell.wxcExecPath),
  };
  for (const [name, value] of Object.entries(observed)) {
    if (value !== inputs.expected[name as keyof typeof observed]) {
      throw new Error(`${name} does not match the expected exact identity`);
    }
  }
}

function assertExactIdentities(inputs: WindowsMxcOpenClawQualificationInputs): void {
  assertCurrentCheckoutIdentity(inputs.expected.nemoClawRevision);
  assertExactArtifactIdentities(inputs);
}

async function prepareWindowsMxcOpenClawLocalSetup(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly inputs: WindowsMxcOpenClawQualificationInputs;
  readonly processElevated: boolean;
  readonly receiptPath: string;
  readonly runId: string;
}) {
  return await withWindowsMxcLocalSetupOwnership({
    receiptPath: input.receiptPath,
    failureReceipt: (localArtifactsRemoved) =>
      buildWindowsMxcSetupFailureReceipt(
        input.inputs,
        input.processElevated,
        localArtifactsRemoved,
      ),
    operation: async (localSetup) => {
      const runRoot = localSetup.trackRoot(
        fs.mkdtempSync(
          path.join(input.inputs.workDirectory, `nemoclaw-mxc-openclaw-${input.runId}-`),
        ),
      );
      const shareDirectory = localSetup.trackRoot(
        fs.mkdtempSync(path.join(input.inputs.workDirectory, `nemoclaw-mxc-share-${input.runId}-`)),
      );
      const stateDirectory = path.join(runRoot, "state");
      const configDirectory = path.join(runRoot, "config");
      const homeDirectory = path.join(shareDirectory, "home");
      const clientHomeDirectory = path.join(runRoot, "client-home");
      for (const directory of [
        shareDirectory,
        stateDirectory,
        configDirectory,
        homeDirectory,
        clientHomeDirectory,
      ]) {
        fs.mkdirSync(directory, { recursive: true });
      }

      const gatewayConfigPath = path.join(runRoot, "gateway.toml");
      const policyPath = path.join(runRoot, "policy.yaml");
      const probeAgentPath = path.join(shareDirectory, "probe-agent.mjs");
      const relayPath = path.join(shareDirectory, "openshell-supervisor-relay.exe");
      const readyPath = path.join(shareDirectory, "ready.json");
      const resultPath = path.join(shareDirectory, "result.json");
      const outcomePath = path.join(shareDirectory, "outcome.json");
      const heartbeatPath = path.join(shareDirectory, "heartbeat.txt");
      const openClawPidPath = path.join(shareDirectory, "openclaw.pid");
      const stopPath = path.join(shareDirectory, "stop.txt");
      const denyPath = path.join(runRoot, "denied-write.txt");
      const gatewayLogPath = path.join(runRoot, "openshell-gateway.log");
      const gatewayErrorPath = path.join(runRoot, "openshell-gateway.err.log");
      const forwardLogPath = path.join(runRoot, "openshell-forward.log");
      const forwardErrorPath = path.join(runRoot, "openshell-forward.err.log");
      const [gatewayPort, forwardPort, mockPort, openClawPort] = await freeDistinctLoopbackPorts(4);
      if (
        gatewayPort === undefined ||
        forwardPort === undefined ||
        mockPort === undefined ||
        openClawPort === undefined
      ) {
        throw new Error("could not allocate all Windows MXC qualification ports");
      }
      const sandboxName = `mxc-oc-${input.runId}`;
      const gatewayName = `mxc-gw-${input.runId}`;
      const token = randomBytes(32).toString("base64url");

      fs.copyFileSync(input.inputs.openShell.relayPath, relayPath);
      assertExactFileIdentity(
        relayPath,
        input.inputs.expected.openShellRelaySha256,
        "stagedRelaySha256",
      );

      fs.writeFileSync(
        gatewayConfigPath,
        renderWindowsMxcGatewayConfig({
          agentPath: input.inputs.openClaw.nodePath,
          relayPath,
          shareDirectory,
          targetPort: openClawPort,
          wxcExecPath: input.inputs.openShell.wxcExecPath,
        }),
        { encoding: "utf8", mode: 0o600 },
      );
      fs.writeFileSync(
        policyPath,
        renderWindowsMxcFilesystemPolicy({
          openClawRoot: input.inputs.openClaw.root,
          shareDirectory,
        }),
        { encoding: "utf8", mode: 0o600 },
      );
      fs.writeFileSync(probeAgentPath, renderWindowsMxcOpenClawProbeAgent(), {
        encoding: "utf8",
        mode: 0o600,
      });

      const gatewayEnvironment: NodeJS.ProcessEnv = withoutOpenShellGatewaySelection({
        ...allowlistedWindowsProcessEnvironment(input.environment),
        NEMOCLAW_MXC_E2E_DENY_PATH: denyPath,
        NEMOCLAW_MXC_E2E_ENTRY: input.inputs.openClaw.entryPath,
        NEMOCLAW_MXC_E2E_HEARTBEAT_PATH: heartbeatPath,
        NEMOCLAW_MXC_E2E_HOME: homeDirectory,
        NEMOCLAW_MXC_E2E_MOCK_PORT: String(mockPort),
        NEMOCLAW_MXC_E2E_NODE: input.inputs.openClaw.nodePath,
        NEMOCLAW_MXC_E2E_OPENCLAW_PORT: String(openClawPort),
        NEMOCLAW_MXC_E2E_OPENCLAW_PID_PATH: openClawPidPath,
        NEMOCLAW_MXC_E2E_OUTCOME_PATH: outcomePath,
        NEMOCLAW_MXC_E2E_READY_PATH: readyPath,
        NEMOCLAW_MXC_E2E_RESULT_PATH: resultPath,
        NEMOCLAW_MXC_E2E_STOP_PATH: stopPath,
        NEMOCLAW_MXC_E2E_TOKEN: token,
        OPENSHELL_DRIVERS: "mxc",
        OPENSHELL_GATEWAY_CONFIG: gatewayConfigPath,
        XDG_CONFIG_HOME: configDirectory,
        XDG_STATE_HOME: stateDirectory,
      });
      const controlEnvironment: NodeJS.ProcessEnv = {
        ...gatewayEnvironment,
        NEMOCLAW_MXC_E2E_TOKEN: undefined,
      };
      const clientEnvironment: NodeJS.ProcessEnv = {
        ...allowlistedWindowsProcessEnvironment(input.environment),
        HOME: clientHomeDirectory,
        OPENCLAW_GATEWAY_URL: `ws://127.0.0.1:${forwardPort}`,
        OPENCLAW_GATEWAY_TOKEN: token,
        USERPROFILE: clientHomeDirectory,
      };
      const clientConfigDirectory = path.join(clientHomeDirectory, ".openclaw");
      fs.mkdirSync(clientConfigDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(clientConfigDirectory, "openclaw.json"),
        JSON.stringify({
          gateway: {
            mode: "remote",
            remote: {
              url: `ws://127.0.0.1:${forwardPort}`,
            },
          },
        }),
        { encoding: "utf8", mode: 0o600 },
      );

      const gatewayStdout = localSetup.trackDescriptor(fs.openSync(gatewayLogPath, "w"));
      const gatewayStderr = localSetup.trackDescriptor(fs.openSync(gatewayErrorPath, "w"));
      const forwardStdout = localSetup.trackDescriptor(fs.openSync(forwardLogPath, "w"));
      const forwardStderr = localSetup.trackDescriptor(fs.openSync(forwardErrorPath, "w"));
      return {
        clientEnvironment,
        clientHomeDirectory,
        configDirectory,
        controlEnvironment,
        denyPath,
        forwardErrorPath,
        forwardLogPath,
        forwardPort,
        forwardStderr,
        forwardStdout,
        gatewayEnvironment,
        gatewayErrorPath,
        gatewayLogPath,
        gatewayName,
        gatewayPort,
        gatewayStderr,
        gatewayStdout,
        heartbeatPath,
        homeDirectory,
        localSetup,
        openClawPidPath,
        openClawPort,
        outcomePath,
        policyPath,
        probeAgentPath,
        readyPath,
        resultPath,
        runRoot,
        sandboxName,
        shareDirectory,
        stateDirectory,
        stopPath,
      };
    },
  });
}

function receiptPasses(checks: QualificationChecks): boolean {
  return Object.values(checks).every(Boolean);
}

export function retainedWindowsMxcSandboxName(input: {
  readonly registryRemovedAfterDelete: boolean;
  readonly sandboxCreateStarted: boolean;
  readonly sandboxName: string;
}): string | null {
  return input.sandboxCreateStarted && !input.registryRemovedAfterDelete ? input.sandboxName : null;
}

export function createWindowsMxcQualificationFailure(input: {
  readonly failures: readonly unknown[];
  readonly openClawProcessStopped: boolean;
  readonly receiptPath: string;
  readonly retainedSandboxName: string | null;
  readonly sandboxDeleteRetried: boolean;
}): AggregateError {
  return new AggregateError(
    input.failures,
    `Windows MXC OpenClaw qualification failed; retained sandbox=${input.retainedSandboxName ?? "none"}, cleanup sandbox delete retried=${input.sandboxDeleteRetried}, OpenClaw stopped=${input.openClawProcessStopped}; receipt: ${input.receiptPath}`,
  );
}

export async function runWindowsMxcOpenClawProcessContainerQualification(
  inputs: WindowsMxcOpenClawQualificationInputs,
  progress: QualificationProgress,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WindowsMxcOpenClawQualificationReceipt> {
  if (process.platform !== "win32" || nativeArchitecture(environment) !== "x64") {
    throw new Error("Windows MXC OpenClaw qualification requires a native Windows x64 host");
  }
  const host = assessWindowsMxcProcessContainerCandidate({
    platform: process.platform,
    nativeArchitecture: "x64",
    release: os.release(),
  });
  if (!host.candidate) throw new Error(host.detail);
  const workRoot = path.resolve(inputs.workDirectory);
  if (
    normalizeWindowsIdentityValue(workRoot) !==
    normalizeWindowsIdentityValue(path.parse(workRoot).root)
  ) {
    throw new Error("Windows MXC qualification work root must be a drive root");
  }
  assertExactIdentities(inputs);
  const powershellPath = trustedWindowsSystemExecutable(
    environment,
    ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
    "Windows PowerShell",
  );
  const taskkillPath = trustedWindowsSystemExecutable(
    environment,
    ["System32", "taskkill.exe"],
    "Windows taskkill",
  );
  const hostProcessEnvironment = allowlistedWindowsProcessEnvironment(environment);
  const processElevated = await observeHostProcessElevation(
    powershellPath,
    hostProcessEnvironment,
    progress,
  );

  assertExactArtifactIdentities(inputs);
  const version = await runCommand(
    inputs.openClaw.nodePath,
    [inputs.openClaw.entryPath, "--version"],
    hostProcessEnvironment,
    progress,
    "command: windows-mxc-openclaw-version",
  );
  if (
    version.exitCode !== 0 ||
    normalizeReportedVersion(version.stdout) !== inputs.openClaw.version
  ) {
    throw new Error("OpenClaw runtime version does not match the expected identity");
  }

  const runId = randomBytes(4).toString("hex");
  const receiptPath = path.join(
    inputs.artifactDirectory,
    `windows-mxc-openclaw-receipt-${runId}.json`,
  );
  const {
    clientEnvironment,
    clientHomeDirectory,
    configDirectory,
    controlEnvironment,
    denyPath,
    forwardErrorPath,
    forwardLogPath,
    forwardPort,
    forwardStderr,
    forwardStdout,
    gatewayEnvironment,
    gatewayErrorPath,
    gatewayLogPath,
    gatewayName,
    gatewayPort,
    gatewayStderr,
    gatewayStdout,
    heartbeatPath,
    homeDirectory,
    localSetup,
    openClawPidPath,
    openClawPort,
    outcomePath,
    policyPath,
    probeAgentPath,
    readyPath,
    resultPath,
    runRoot,
    sandboxName,
    shareDirectory,
    stateDirectory,
    stopPath,
  } = await prepareWindowsMxcOpenClawLocalSetup({
    environment,
    inputs,
    processElevated,
    receiptPath,
    runId,
  });
  let gateway: ChildProcess | null = null;
  let forward: ChildProcess | null = null;
  let gatewayStopped = false;
  let forwardListenerStopped = false;
  let forwardProcessStopped = false;
  let boundedStopMarkerNeeded = false;
  let emergencyProcessTerminationNeeded = false;
  let emergencyGatewayTerminationNeeded = false;
  let emergencyForwardTerminationNeeded = false;
  let openClawProcessStopped = false;
  let runDirectoryRemoved = false;
  let sandboxCreateStarted = false;
  let sandboxDeleteRetried = false;
  let sensitiveRuntimeArtifactsRemoved = false;
  let openClawProcessId: number | null = null;
  let trustedOpenClawProcess: TrustedOpenClawProcessIdentity | null = null;
  let trustedGatewayProcess: WindowsProcessIdentity | null = null;
  let trustedForwardProcess: WindowsProcessIdentity | null = null;
  let primaryFailure: unknown = null;
  const cleanupFailures: unknown[] = [];
  let checks: QualificationChecks = {
    artifactIdentity: true,
    filesystemControlWrite: false,
    filesystemDeniedWrite: false,
    forwardAuthenticatedHealth: false,
    forwardListening: false,
    forwardedChatExactReply: false,
    openClawHealth: false,
    openClawProcessPresentWhileReady: false,
    registryPresentWhileReady: false,
    registryRemovedAfterDelete: false,
    sandboxCreateAccepted: false,
    sandboxDeleteAccepted: false,
    workloadTerminatedByDelete: false,
  };
  const runOpenShellCommand = async (
    args: readonly string[],
    activityLabel: string,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<CommandResult> => {
    assertExactFileIdentity(
      inputs.openShell.cliPath,
      inputs.expected.openShellCliSha256,
      "openShellCliSha256",
    );
    return await runCommand(
      inputs.openShell.cliPath,
      args,
      controlEnvironment,
      progress,
      activityLabel,
      timeoutMs,
    );
  };

  try {
    assertExactFileIdentity(
      inputs.openShell.gatewayPath,
      inputs.expected.openShellGatewaySha256,
      "openShellGatewaySha256",
    );
    gateway = spawnObservedChild(
      inputs.openShell.gatewayPath,
      [
        "--port",
        String(gatewayPort),
        "--disable-tls",
        "--db-url",
        "sqlite::memory:",
        "--log-level",
        "info",
      ],
      {
        activityLabel: "command: windows-mxc-openshell-gateway",
        progress,
        spawn: {
          cwd: path.dirname(inputs.openShell.gatewayPath),
          env: gatewayEnvironment,
          stdio: ["ignore", gatewayStdout, gatewayStderr],
          windowsHide: true,
        },
      },
    );
    await waitForPort(gatewayPort, gateway);
    if (gateway.pid === undefined) throw new Error("OpenShell gateway did not report a process ID");
    trustedGatewayProcess = await observeWindowsProcessIdentity(
      gateway.pid,
      powershellPath,
      controlEnvironment,
      progress,
      "command: windows-mxc-openshell-gateway-process-identity",
    );
    if (trustedGatewayProcess === null) {
      throw new Error("OpenShell gateway process identity is unavailable after readiness");
    }
    assertExpectedOpenShellGatewayProcessIdentity(trustedGatewayProcess, {
      gatewayPath: inputs.openShell.gatewayPath,
      port: gatewayPort,
    });

    const add = await runOpenShellCommand(
      ["gateway", "add", `http://127.0.0.1:${gatewayPort}`, "--local", "--name", gatewayName],
      "command: windows-mxc-gateway-add",
    );
    if (add.exitCode !== 0) throw new Error(`OpenShell gateway add failed: ${commandDetail(add)}`);
    const select = await runOpenShellCommand(
      ["gateway", "select", gatewayName],
      "command: windows-mxc-gateway-select",
    );
    if (select.exitCode !== 0) {
      throw new Error(`OpenShell gateway select failed: ${commandDetail(select)}`);
    }

    assertExactArtifactIdentities(inputs);
    sandboxCreateStarted = true;
    const create = await runOpenShellCommand(
      ["sandbox", "create", "--name", sandboxName, "--policy", policyPath, "--no-tty"],
      "command: windows-mxc-sandbox-create",
      READY_TIMEOUT_MS,
    );
    if (create.exitCode !== 0) {
      throw new Error(`OpenShell sandbox create failed: ${commandDetail(create)}`);
    }

    await waitForFile(outcomePath, READY_TIMEOUT_MS);
    const ready = fs.existsSync(readyPath);
    const probeResult = fs.existsSync(resultPath)
      ? (JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>)
      : {};
    openClawProcessId = readProcessId(openClawPidPath);
    if (openClawProcessId !== null) {
      trustedOpenClawProcess = await observeTrustedOpenClawProcessIdentity({
        entryPath: inputs.openClaw.entryPath,
        environment: controlEnvironment,
        nodePath: inputs.openClaw.nodePath,
        port: openClawPort,
        powershellPath,
        probeAgentPath,
        processId: openClawProcessId,
        progress,
      });
    }
    const reportedVersion =
      typeof probeResult.openClawVersion === "string"
        ? normalizeReportedVersion(probeResult.openClawVersion)
        : null;
    checks = {
      ...checks,
      filesystemControlWrite: probeResult.controlWrite === true,
      filesystemDeniedWrite: probeResult.deniedWrite === true && !fs.existsSync(denyPath),
      openClawHealth:
        ready && probeResult.healthObserved === true && reportedVersion === inputs.openClaw.version,
      openClawProcessPresentWhileReady: trustedOpenClawProcess !== null,
    };

    const listWhileReady = await runOpenShellCommand(
      ["sandbox", "list", "-o", "json"],
      "command: windows-mxc-sandbox-list-ready",
    );
    checks = {
      ...checks,
      registryPresentWhileReady:
        listWhileReady.exitCode === 0 &&
        sandboxListContainsExactName(listWhileReady.stdout, sandboxName),
    };
    checks = {
      ...checks,
      sandboxCreateAccepted: create.exitCode === 0,
    };

    if (
      !progress.hasReached(
        "forward authenticated traffic and require the exact mock-backed chat reply",
      )
    ) {
      progress.phase("forward authenticated traffic and require the exact mock-backed chat reply");
    }
    assertExactFileIdentity(
      inputs.openShell.cliPath,
      inputs.expected.openShellCliSha256,
      "openShellCliSha256",
    );
    forward = spawnObservedChild(
      inputs.openShell.cliPath,
      [
        "forward",
        "service",
        sandboxName,
        "--target-port",
        String(openClawPort),
        "--local",
        `127.0.0.1:${forwardPort}`,
      ],
      {
        activityLabel: "command: windows-mxc-openshell-forward-service",
        progress,
        spawn: {
          env: controlEnvironment,
          stdio: ["ignore", forwardStdout, forwardStderr],
          windowsHide: true,
        },
      },
    );
    if (forward.pid === undefined) throw new Error("OpenShell forward did not report a process ID");
    trustedForwardProcess = await observeWindowsProcessIdentity(
      forward.pid,
      powershellPath,
      controlEnvironment,
      progress,
      "command: windows-mxc-openshell-forward-process-identity",
    );
    if (trustedForwardProcess === null) {
      throw new Error("OpenShell forward process identity is unavailable after readiness");
    }
    assertExpectedOpenShellForwardProcessIdentity(trustedForwardProcess, {
      cliPath: inputs.openShell.cliPath,
      localPort: forwardPort,
      sandboxName,
      targetPort: openClawPort,
    });
    await waitForOwnedLoopbackListener({
      environment: controlEnvironment,
      port: forwardPort,
      powershellPath,
      processId: trustedForwardProcess.processId,
      progress,
    });
    checks = { ...checks, forwardListening: true };

    const forwardedHealth = await runCommand(
      inputs.openClaw.nodePath,
      [inputs.openClaw.entryPath, "gateway", "health", "--json", "--timeout", "60000"],
      clientEnvironment,
      progress,
      "command: windows-mxc-openclaw-forwarded-health",
      90_000,
    );
    checks = {
      ...checks,
      forwardAuthenticatedHealth:
        forwardedHealth.exitCode === 0 && parseOpenClawHealthResult(forwardedHealth.stdout),
    };
    if (!checks.forwardAuthenticatedHealth) {
      throw new Error(`forwarded OpenClaw health failed: ${commandDetail(forwardedHealth)}`);
    }

    const forwardedChat = await runCommand(
      inputs.openClaw.nodePath,
      [
        inputs.openClaw.entryPath,
        "agent",
        "--agent",
        "main",
        "--message",
        "Reply exactly: CHAT_OK",
        "--thinking",
        "off",
        "--timeout",
        "180",
        "--json",
      ],
      clientEnvironment,
      progress,
      "command: windows-mxc-openclaw-forwarded-chat",
      210_000,
    );
    checks = {
      ...checks,
      forwardedChatExactReply:
        forwardedChat.exitCode === 0 && parseOpenClawExactChatReply(forwardedChat.stdout),
    };
    if (!checks.forwardedChatExactReply) {
      throw new Error("forwarded OpenClaw chat did not return the exact CHAT_OK payload");
    }

    if (
      !progress.hasReached("delete the sandbox and verify registry plus OpenClaw process cleanup")
    ) {
      progress.phase("delete the sandbox and verify registry plus OpenClaw process cleanup");
    }
    const remove = await runOpenShellCommand(
      ["sandbox", "delete", sandboxName],
      "command: windows-mxc-sandbox-delete",
    );
    checks = { ...checks, sandboxDeleteAccepted: remove.exitCode === 0 };
    checks = {
      ...checks,
      workloadTerminatedByDelete:
        trustedOpenClawProcess !== null &&
        (await waitForTrustedProcessExit(
          trustedOpenClawProcess.child,
          powershellPath,
          controlEnvironment,
          progress,
        )),
    };

    if (!checks.workloadTerminatedByDelete) {
      boundedStopMarkerNeeded = true;
      writeStopMarkerOnce(stopPath);
      await heartbeatStopped(heartbeatPath);
    }

    const listAfterDelete = await runOpenShellCommand(
      ["sandbox", "list", "-o", "json"],
      "command: windows-mxc-sandbox-list-deleted",
    );
    checks = {
      ...checks,
      registryRemovedAfterDelete:
        listAfterDelete.exitCode === 0 &&
        !sandboxListContainsExactName(listAfterDelete.stdout, sandboxName),
    };
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (sandboxCreateStarted) {
      let exactRegistryEntryPresent = true;
      try {
        const cleanupListBeforeRetry = await runOpenShellCommand(
          ["sandbox", "list", "-o", "json"],
          "command: windows-mxc-sandbox-list-before-cleanup",
        );
        if (cleanupListBeforeRetry.exitCode === 0) {
          exactRegistryEntryPresent = sandboxListContainsExactName(
            cleanupListBeforeRetry.stdout,
            sandboxName,
          );
          checks = { ...checks, registryRemovedAfterDelete: !exactRegistryEntryPresent };
        }
      } catch {
        exactRegistryEntryPresent = true;
      }

      if (shouldRetrySandboxDelete(checks.sandboxDeleteAccepted, exactRegistryEntryPresent)) {
        sandboxDeleteRetried = true;
        try {
          const cleanupDelete = await runOpenShellCommand(
            ["sandbox", "delete", sandboxName],
            "command: windows-mxc-sandbox-delete-cleanup",
          );
          checks = { ...checks, sandboxDeleteAccepted: cleanupDelete.exitCode === 0 };
          if (cleanupDelete.exitCode !== 0) {
            cleanupFailures.push(
              new Error(`cleanup sandbox delete failed: ${commandDetail(cleanupDelete)}`),
            );
          }
        } catch (error) {
          cleanupFailures.push(error);
        }
      }

      try {
        const cleanupList = await runOpenShellCommand(
          ["sandbox", "list", "-o", "json"],
          "command: windows-mxc-sandbox-list-cleanup",
        );
        const registryRemovedAfterDelete =
          cleanupList.exitCode === 0 &&
          !sandboxListContainsExactName(cleanupList.stdout, sandboxName);
        checks = {
          ...checks,
          registryRemovedAfterDelete,
        };
        if (!registryRemovedAfterDelete) {
          cleanupFailures.push(new Error("exact sandbox registry entry remains after cleanup"));
        }
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    const forwardCleanup = await runWindowsMxcForwardCleanup({
      childWasRunning: forward !== null && forward.exitCode === null,
      sandboxDeleteAccepted: checks.sandboxDeleteAccepted,
      stopChild: async () => {
        if (forward === null || forward.exitCode !== null) return;
        forward.kill();
        await Promise.race([
          new Promise((resolve) => forward?.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      },
      terminateTrustedProcessIfAlive: async () => {
        if (
          trustedForwardProcess === null ||
          !(await trustedProcessIsAlive(
            trustedForwardProcess,
            powershellPath,
            controlEnvironment,
            progress,
          ))
        ) {
          return false;
        }
        const terminateForward = await runCommand(
          taskkillPath,
          ["/PID", String(trustedForwardProcess.processId), "/T", "/F"],
          controlEnvironment,
          progress,
          "command: windows-mxc-openshell-forward-emergency-termination",
        );
        if (
          terminateForward.exitCode !== 0 &&
          (await trustedProcessIsAlive(
            trustedForwardProcess,
            powershellPath,
            controlEnvironment,
            progress,
          ))
        ) {
          throw new Error(
            `OpenShell forward emergency termination failed: ${commandDetail(terminateForward)}`,
          );
        }
        return true;
      },
      waitForProcessExit: async () =>
        trustedForwardProcess === null
          ? forward === null || forward.exitCode !== null
          : await waitForTrustedProcessExit(
              trustedForwardProcess,
              powershellPath,
              controlEnvironment,
              progress,
            ),
      waitForListenerClosed: async () =>
        await waitForLoopbackListenerClosed({
          environment: controlEnvironment,
          port: forwardPort,
          powershellPath,
          progress,
        }),
    });
    emergencyForwardTerminationNeeded = forwardCleanup.emergencyTerminationNeeded;
    forwardProcessStopped = forwardCleanup.processStopped;
    forwardListenerStopped = forwardCleanup.listenerStopped;
    cleanupFailures.push(...forwardCleanup.failures);
    try {
      writeStopMarkerOnce(stopPath);
      await heartbeatStopped(heartbeatPath);
      if (
        trustedOpenClawProcess !== null &&
        (await trustedProcessIsAlive(
          trustedOpenClawProcess.child,
          powershellPath,
          controlEnvironment,
          progress,
        ))
      ) {
        emergencyProcessTerminationNeeded = true;
        const terminate = await runCommand(
          taskkillPath,
          ["/PID", String(trustedOpenClawProcess.child.processId), "/T", "/F"],
          controlEnvironment,
          progress,
          "command: windows-mxc-openclaw-emergency-termination",
        );
        if (
          terminate.exitCode !== 0 &&
          (await trustedProcessIsAlive(
            trustedOpenClawProcess.child,
            powershellPath,
            controlEnvironment,
            progress,
          ))
        ) {
          cleanupFailures.push(
            new Error(`OpenClaw emergency termination failed: ${commandDetail(terminate)}`),
          );
        }
      }
      openClawProcessStopped =
        trustedOpenClawProcess === null
          ? !sandboxCreateStarted
          : await waitForTrustedProcessExit(
              trustedOpenClawProcess.child,
              powershellPath,
              controlEnvironment,
              progress,
            );
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      if (gateway && gateway.exitCode === null) {
        gateway.kill();
        await Promise.race([
          new Promise((resolve) => gateway?.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      }
      if (
        trustedGatewayProcess !== null &&
        (await trustedProcessIsAlive(
          trustedGatewayProcess,
          powershellPath,
          controlEnvironment,
          progress,
        ))
      ) {
        emergencyGatewayTerminationNeeded = true;
        const terminateGateway = await runCommand(
          taskkillPath,
          ["/PID", String(trustedGatewayProcess.processId), "/T", "/F"],
          controlEnvironment,
          progress,
          "command: windows-mxc-openshell-gateway-emergency-termination",
        );
        if (
          terminateGateway.exitCode !== 0 &&
          (await trustedProcessIsAlive(
            trustedGatewayProcess,
            powershellPath,
            controlEnvironment,
            progress,
          ))
        ) {
          cleanupFailures.push(
            new Error(
              `OpenShell gateway emergency termination failed: ${commandDetail(terminateGateway)}`,
            ),
          );
        }
      }
      gatewayStopped =
        trustedGatewayProcess === null
          ? gateway === null || gateway.exitCode !== null
          : await waitForTrustedProcessExit(
              trustedGatewayProcess,
              powershellPath,
              controlEnvironment,
              progress,
            );
    } catch (error) {
      cleanupFailures.push(error);
    }
    gatewayEnvironment.NEMOCLAW_MXC_E2E_TOKEN = undefined;
    clientEnvironment.OPENCLAW_GATEWAY_TOKEN = undefined;
    for (const descriptor of [gatewayStdout, gatewayStderr, forwardStdout, forwardStderr]) {
      try {
        localSetup.closeDescriptor(descriptor);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    const sensitivePaths = [
      clientHomeDirectory,
      homeDirectory,
      configDirectory,
      stateDirectory,
      gatewayLogPath,
      gatewayErrorPath,
      forwardLogPath,
      forwardErrorPath,
    ];
    for (const sensitivePath of sensitivePaths) {
      try {
        fs.rmSync(sensitivePath, { force: true, recursive: true });
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    sensitiveRuntimeArtifactsRemoved = sensitivePaths.every(
      (sensitivePath) => !fs.existsSync(sensitivePath),
    );
  }

  const lifecyclePassedBeforeDirectoryRemoval =
    receiptPasses(checks) &&
    !boundedStopMarkerNeeded &&
    !emergencyProcessTerminationNeeded &&
    !emergencyGatewayTerminationNeeded &&
    !emergencyForwardTerminationNeeded &&
    !sandboxDeleteRetried &&
    forwardListenerStopped &&
    forwardProcessStopped &&
    gatewayStopped &&
    openClawProcessStopped &&
    sensitiveRuntimeArtifactsRemoved &&
    primaryFailure === null &&
    cleanupFailures.length === 0;
  if (lifecyclePassedBeforeDirectoryRemoval) {
    try {
      fs.rmSync(runRoot, { force: true, recursive: true });
      fs.rmSync(shareDirectory, { force: true, recursive: true });
      runDirectoryRemoved = !fs.existsSync(runRoot) && !fs.existsSync(shareDirectory);
      if (runDirectoryRemoved) {
        localSetup.releaseRoot(runRoot);
        localSetup.releaseRoot(shareDirectory);
      }
      if (!runDirectoryRemoved) {
        cleanupFailures.push(new Error("qualification run directory remains after cleanup"));
      }
    } catch (error) {
      cleanupFailures.push(error);
    }
  }

  const retainedSandboxName = retainedWindowsMxcSandboxName({
    registryRemovedAfterDelete: checks.registryRemovedAfterDelete,
    sandboxCreateStarted,
    sandboxName,
  });
  const receipt: WindowsMxcOpenClawQualificationReceipt = {
    schemaVersion: 2,
    classification: "inactive-candidate",
    backend: "process_container",
    configuration: {
      declaredHostPreparation: inputs.declaredHostPreparation,
      egressProxy: true,
      pcCapabilities: ["privateNetworkClientServer"],
      pcLeastPrivilege: false,
      shareAtDriveRoot: true,
    },
    identities: {
      host: {
        architecture: "x64",
        processElevated,
        platform: "win32",
        release: os.release(),
      },
      nemoClawRevision: inputs.expected.nemoClawRevision,
      openClaw: {
        artifactTreeSha256: inputs.expected.openClawArtifactTreeSha256,
        entrySha256: inputs.expected.openClawEntrySha256,
        nodeSha256: inputs.expected.nodeSha256,
        version: inputs.openClaw.version,
      },
      openShell: {
        cliSha256: inputs.expected.openShellCliSha256,
        gatewaySha256: inputs.expected.openShellGatewaySha256,
        packageVersion: inputs.openShell.packageVersion,
        relaySha256: inputs.expected.openShellRelaySha256,
        revision: inputs.openShell.revision,
      },
      wxcExecSha256: inputs.expected.wxcExecSha256,
    },
    checks,
    cleanup: {
      boundedStopMarkerNeeded,
      emergencyProcessTerminationNeeded,
      emergencyGatewayTerminationNeeded,
      emergencyForwardTerminationNeeded,
      forwardListenerStopped,
      forwardProcessStopped,
      gatewayProcessStopped: gatewayStopped,
      openClawProcessStopped,
      retainedSandboxName,
      runDirectoryRemoved,
      sandboxDeleteRetried,
      sensitiveRuntimeArtifactsRemoved,
    },
    verdict:
      lifecyclePassedBeforeDirectoryRemoval && runDirectoryRemoved && cleanupFailures.length === 0
        ? "pass"
        : "fail",
    deferred: [
      "gateway-mtls",
      "managed-inference",
      "governed-egress",
      "gateway-restart-recovery",
      "production-activation",
    ],
  };

  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  if (receipt.verdict === "pass") {
    return receipt;
  }
  const failures = [primaryFailure, ...cleanupFailures].filter(
    (failure): failure is NonNullable<typeof failure> => failure !== null,
  );
  throw createWindowsMxcQualificationFailure({
    failures,
    openClawProcessStopped,
    receiptPath,
    retainedSandboxName,
    sandboxDeleteRetried,
  });
}
