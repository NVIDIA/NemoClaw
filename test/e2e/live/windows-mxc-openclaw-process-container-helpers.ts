// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../../../src/lib/onboard/managed-startup/profile.ts";
import { assessWindowsMxcProcessContainerCandidate } from "../../../src/lib/onboard/windows-mxc/host-qualification.ts";
import {
  MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
  MXC_OPENSHELL_COMBINED_MXC_V0_8_0_QUALIFICATION_PROFILE_ID,
  createMxcOpenShellQualificationGatewayConfiguration,
  type MxcOpenShellAttachmentReceipt,
  type MxcOpenShellDistributionAuthority,
  type MxcOpenShellQualificationGatewayConfiguration,
} from "../../../src/lib/onboard/runtime-provider/mxc-openshell-attachment.ts";
import { resolveMxcNativeArtifactShareDirectory } from "../../../src/lib/onboard/runtime-provider/mxc-bootstrap.ts";
import type { MxcOpenShellAttachmentObservationRequest } from "../../../src/lib/onboard/runtime-provider/mxc-openshell-observer.ts";
import type { RuntimeProviderNativeArtifactBootstrapResult } from "../../../src/lib/onboard/runtime-provider/contract.ts";
import type { MxcOpenShellLiveFailureRecord } from "../../../src/lib/onboard/runtime-provider/mxc-openshell-live-operations.ts";
import {
  createMxcWindowsOpenShellExecutorRuntime,
  type MxcWindowsOpenShellArtifactTree,
  type MxcWindowsOpenShellExecutorRuntime,
} from "../../../src/lib/onboard/runtime-provider/mxc-windows-openshell-executor.ts";
import {
  NATIVE_ARTIFACT_SOURCE_REPOSITORY,
  NATIVE_ARTIFACT_WORKLOAD_AGENT,
  NATIVE_ARTIFACT_WORKLOAD_CONTRACT_VERSION,
  NATIVE_ARTIFACT_WORKLOAD_PLATFORM,
  NATIVE_ARTIFACT_WORKLOAD_RECEIPT_SCHEMA_VERSION,
  type NativeArtifactWorkloadReceiptV1,
} from "../../../src/lib/onboard/workload/native-artifact.ts";
import { sha256File } from "../../../tools/e2e/windows-mxc-openclaw-artifact-tree.mts";
import {
  type ChildProcessProgress,
  spawnObservedChild,
} from "../fixtures/observed-child-process.ts";
import { isExactOpenClawAgentText } from "../fixtures/openclaw-agent-output.ts";
import { PollingError, pollUntil } from "../fixtures/polling.ts";
import {
  createWindowsMxcInactiveOnboardingLifecycle,
  type WindowsMxcInactiveOnboardingCompositionInput,
} from "./windows-mxc-inactive-onboarding-composition.ts";

type QualificationProgress = ChildProcessProgress & {
  hasReached(label: string): boolean;
  phase(label: string): void;
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const VERSION_PATTERN =
  /^[0-9]+(?:[.][0-9]+){2,3}(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?(?:[+][0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 180_000;
const TERMINATION_TIMEOUT_MS = 15_000;
const FORWARD_HEALTH_READINESS_ATTEMPTS = 12;
const FORWARD_HEALTH_READINESS_DELAY_MS = 1_000;
export const WINDOWS_MXC_OPENCLAW_QUALIFICATION_RECEIPT_SCHEMA_VERSION = 10 as const;
const WINDOWS_PROCESS_ENVIRONMENT_NAMES = [
  "ComSpec",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "Path",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "PROCESSOR_IDENTIFIER",
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
  "NEMOCLAW_MXC_E2E_COMPAT_PRELOAD",
  "NEMOCLAW_MXC_E2E_ENTRY",
  "NEMOCLAW_MXC_E2E_HEARTBEAT_PATH",
  "NEMOCLAW_MXC_E2E_HOME",
  "NEMOCLAW_MXC_E2E_LOCAL_APP_DATA",
  "NEMOCLAW_MXC_E2E_MOCK_PORT",
  "NEMOCLAW_MXC_E2E_NODE",
  "NEMOCLAW_MXC_E2E_OPENCLAW_PORT",
  "NEMOCLAW_MXC_E2E_OPENCLAW_PID_PATH",
  "NEMOCLAW_MXC_E2E_OPENCLAW_STATE_DIR",
  "NEMOCLAW_MXC_E2E_OUTCOME_PATH",
  "NEMOCLAW_MXC_E2E_READY_PATH",
  "NEMOCLAW_MXC_E2E_RESULT_PATH",
  "NEMOCLAW_MXC_E2E_STOP_PATH",
  "NEMOCLAW_MXC_E2E_TEMP",
  "NEMOCLAW_MXC_E2E_TOKEN",
  "PATH",
  "SYSTEMROOT",
  "WINDIR",
] as const;

export type WindowsMxcHostPreparationDeclaration =
  | "wxc-host-prep-prepare-system-drive"
  | "preexisting-compatible-system-drive-acl";

export interface WindowsMxcOpenClawQualificationInputs {
  readonly artifactDirectory: string;
  readonly declaredHostPreparation: WindowsMxcHostPreparationDeclaration;
  readonly expected: {
    readonly nemoClawRevision: string;
    readonly nodeSha256: string;
    readonly openClawArchiveSha256: string;
    readonly openClawEntrySha256: string;
    readonly openShellDistributionSha256: string;
    readonly openShellCliSha256: string;
    readonly openShellGatewaySha256: string;
    readonly openShellRelaySha256: string;
    readonly wxcExecSha256: string;
  };
  readonly openClaw: {
    readonly archivePath: string;
    readonly entryPath: string;
    readonly nodePath: string;
    readonly root: string;
    readonly version: string;
  };
  readonly openShell: {
    readonly distributionArtifactPath: string;
    readonly distributionRoot: string;
    readonly cliPath: string;
    readonly gatewayPath: string;
    readonly packageVersion: string;
    readonly relayPath: string;
    readonly revision: string;
  };
  readonly mxc: {
    readonly root: string;
    readonly wxcExecPath: string;
  };
  readonly workDirectory: string;
}

export type CommandResult = {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
};

export type WindowsMxcForwardHealthObservation = "ready" | "relay-not-ready" | "terminal";

export interface WindowsMxcForwardHealthReadinessEvidence {
  readonly schemaVersion: 1;
  readonly operation: "windows-mxc-forward-authenticated-health";
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly attempts: readonly {
    readonly attempt: number;
    readonly outcome: WindowsMxcForwardHealthObservation;
  }[];
  readonly outcome: "ready" | "terminal" | "exhausted";
}

export interface WindowsMxcForwardHealthReadinessResult {
  readonly command: CommandResult;
  readonly evidence: WindowsMxcForwardHealthReadinessEvidence;
}

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
  readonly attachmentObserved: boolean;
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

export type WindowsMxcOpenClawStartupObservation = {
  readonly outcome:
    | "not-observed"
    | "spawn-failed"
    | "exited-before-readiness"
    | "readiness-timeout"
    | "ready";
  readonly gatewayExitCode: number | null;
  readonly versionExitCode: number | null;
};

export interface WindowsMxcHostLaunchContext {
  readonly processElevated: boolean;
  readonly processSessionId: number;
  readonly processUserInteractive: boolean;
}

export interface WindowsMxcOpenClawQualificationReceipt {
  readonly schemaVersion: typeof WINDOWS_MXC_OPENCLAW_QUALIFICATION_RECEIPT_SCHEMA_VERSION;
  readonly classification: "inactive-candidate";
  readonly qualificationMode: "authoritative" | "diagnostic-name-delete";
  readonly backend: "process_container";
  readonly configuration: {
    readonly artifactStaging: "pinned-archive-read-only-reused";
    readonly declaredHostPreparation: WindowsMxcHostPreparationDeclaration;
    readonly egressProxy: true;
    readonly networkDefaultPolicy: "block";
    readonly networkPosture: "host-egress-proxy";
    readonly allowGraphicalUi: true;
    readonly allowInputInjection: false;
    readonly clipboard: "none";
    readonly pcCapabilities: readonly ["privateNetworkClientServer"];
    readonly pcAllowLocalNetwork: false;
    readonly pcLeastPrivilege: false;
    readonly shareAtDriveRoot: true;
  };
  readonly identities: {
    readonly host: WindowsMxcHostLaunchContext & {
      readonly architecture: "x64" | "arm64";
      readonly platform: "win32";
      readonly release: string;
    };
    readonly nemoClawRevision: string;
    readonly openClaw: {
      readonly archiveSha256: string;
      readonly entrySha256: string;
      readonly nodeSha256: string;
      readonly version: string;
    };
    readonly openShell: {
      readonly distributionSha256: string;
      readonly cliSha256: string;
      readonly gatewayConfigSha256: string | null;
      readonly gatewaySha256: string;
      readonly packageVersion: string;
      readonly relaySha256: string;
      readonly revision: string;
    };
    readonly wxcExecSha256: string;
  };
  readonly checks: QualificationChecks;
  readonly providerLifecycle: {
    readonly create: RuntimeProviderNativeArtifactBootstrapResult | null;
    readonly cleanup: RuntimeProviderNativeArtifactBootstrapResult | null;
    readonly failures: readonly MxcOpenShellLiveFailureRecord[];
  };
  readonly startup: WindowsMxcOpenClawStartupObservation;
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
    readonly providerRecoveryAttempted: boolean;
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
  let emergencyTerminationNeeded = false;
  let listenerStopped = false;
  let processStopped = false;

  if (input.childWasRunning && input.sandboxDeleteAccepted) {
    try {
      processStopped = await input.waitForProcessExit();
    } catch (error) {
      failures.push(error);
    }
    emergencyTerminationNeeded = !processStopped;
  }
  if (!processStopped) {
    try {
      await input.stopChild();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    if (await input.terminateTrustedProcessIfAlive()) emergencyTerminationNeeded = true;
  } catch (error) {
    failures.push(error);
  }
  if (!processStopped) {
    try {
      processStopped = await input.waitForProcessExit();
    } catch (error) {
      failures.push(error);
    }
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

export function removeWindowsMxcRuntimeArtifacts(input: {
  readonly runRoot: string;
  readonly sensitivePaths: readonly string[];
  readonly shareDirectory: string;
}): {
  readonly failures: readonly unknown[];
  readonly runDirectoryRemoved: boolean;
  readonly sensitiveRuntimeArtifactsRemoved: boolean;
} {
  const paths = [...new Set([...input.sensitivePaths, input.runRoot, input.shareDirectory])];
  const failures: unknown[] = [];
  for (const artifactPath of paths) {
    try {
      fs.rmSync(artifactPath, { force: true, recursive: true });
    } catch (error) {
      failures.push(error);
    }
  }
  return {
    failures,
    runDirectoryRemoved: !fs.existsSync(input.runRoot) && !fs.existsSync(input.shareDirectory),
    sensitiveRuntimeArtifactsRemoved: paths.every((artifactPath) => !fs.existsSync(artifactPath)),
  };
}

export function buildWindowsMxcSetupFailureReceipt(
  inputs: WindowsMxcOpenClawQualificationInputs,
  hostLaunchContext: WindowsMxcHostLaunchContext,
  localArtifactsRemoved: boolean,
): WindowsMxcOpenClawQualificationReceipt {
  return {
    schemaVersion: WINDOWS_MXC_OPENCLAW_QUALIFICATION_RECEIPT_SCHEMA_VERSION,
    classification: "inactive-candidate",
    qualificationMode: "authoritative",
    backend: "process_container",
    configuration: {
      artifactStaging: "pinned-archive-read-only-reused",
      declaredHostPreparation: inputs.declaredHostPreparation,
      egressProxy: true,
      networkDefaultPolicy: "block",
      networkPosture: "host-egress-proxy",
      allowGraphicalUi: true,
      allowInputInjection: false,
      clipboard: "none",
      pcCapabilities: ["privateNetworkClientServer"],
      pcAllowLocalNetwork: false,
      pcLeastPrivilege: false,
      shareAtDriveRoot: true,
    },
    identities: {
      host: {
        architecture: observeWindowsNativeArchitecture(process.env) ?? "x64",
        ...hostLaunchContext,
        platform: "win32",
        release: os.release(),
      },
      nemoClawRevision: inputs.expected.nemoClawRevision,
      openClaw: {
        archiveSha256: inputs.expected.openClawArchiveSha256,
        entrySha256: inputs.expected.openClawEntrySha256,
        nodeSha256: inputs.expected.nodeSha256,
        version: inputs.openClaw.version,
      },
      openShell: {
        distributionSha256: inputs.expected.openShellDistributionSha256,
        cliSha256: inputs.expected.openShellCliSha256,
        gatewayConfigSha256: null,
        gatewaySha256: inputs.expected.openShellGatewaySha256,
        packageVersion: inputs.openShell.packageVersion,
        relaySha256: inputs.expected.openShellRelaySha256,
        revision: inputs.openShell.revision,
      },
      wxcExecSha256: inputs.expected.wxcExecSha256,
    },
    checks: {
      attachmentObserved: false,
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
    providerLifecycle: {
      create: null,
      cleanup: null,
      failures: [],
    },
    startup: {
      outcome: "not-observed",
      gatewayExitCode: null,
      versionExitCode: null,
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
      providerRecoveryAttempted: false,
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

export function sanitizeWindowsMxcOpenClawGatewayOutput(value: string, token: string): string {
  if (!token) throw new Error("gateway token is required for diagnostic sanitization");
  return value
    .replaceAll(token, "[redacted]")
    .replace(
      /((?:api[-_ ]?key|authorization|password|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,]+)/giu,
      "$1[redacted]",
    )
    .slice(-MAX_COMMAND_OUTPUT_BYTES);
}

export function readWindowsMxcOpenClawGatewayOutput(file: string, token: string): string | null {
  try {
    return sanitizeWindowsMxcOpenClawGatewayOutput(fs.readFileSync(file, "utf8"), token);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
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

function requireDescendant(
  file: string,
  root: string,
  name: string,
  rootName = "OpenClaw artifact root",
): void {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${name} must be a child of the ${rootName}`);
  }
}

function requireDirectChild(directory: string, root: string, name: string): void {
  const relative = path.relative(root, directory);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep)
  ) {
    throw new Error(`${name} must be a direct child of the qualification work root`);
  }
}

function requireWindowsDriveRoot(directory: string, platform = process.platform): void {
  if (platform !== "win32") return;
  const absolute = path.win32.resolve(directory);
  if (
    normalizeWindowsIdentityValue(absolute) !==
    normalizeWindowsIdentityValue(path.win32.parse(absolute).root)
  ) {
    throw new Error("Windows MXC qualification work root must be a drive root");
  }
}

export function parseWindowsMxcOpenClawQualificationEnvironment(
  environment: NodeJS.ProcessEnv,
): WindowsMxcOpenClawQualificationInputs {
  const openClawArchivePath = realRegularFile(
    requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_OPENCLAW_ARCHIVE"),
    "OpenClaw versioned archive",
  );
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
  const workDirectory = realDirectory(
    requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_WORK_ROOT"),
    "Windows MXC qualification work root",
  );
  requireWindowsDriveRoot(workDirectory);
  requireDirectChild(openClawRoot, workDirectory, "OpenClaw artifact root");
  const openShellDistributionRoot = realDirectory(
    requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_OPENSHELL_DISTRIBUTION_ROOT"),
    "OpenShell distribution root",
  );
  const openShellDistributionArtifactPath = realRegularFile(
    requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_OPENSHELL_DISTRIBUTION_ARTIFACT"),
    "OpenShell distribution artifact",
  );
  const openShellCliPath = realRegularFile(
    requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_OPENSHELL_CLI"),
    "OpenShell CLI",
  );
  const openShellGatewayPath = realRegularFile(
    requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_OPENSHELL_GATEWAY"),
    "OpenShell gateway",
  );
  const openShellRelayPath = realRegularFile(
    requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_OPENSHELL_RELAY"),
    "OpenShell MXC supervisor relay",
  );
  for (const [candidate, label] of [
    [openShellCliPath, "OpenShell CLI"],
    [openShellGatewayPath, "OpenShell gateway"],
    [openShellRelayPath, "OpenShell MXC supervisor relay"],
  ] as const) {
    requireDescendant(candidate, openShellDistributionRoot, label, "OpenShell distribution root");
  }
  const mxcRoot = realDirectory(
    requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_ROOT"),
    "MXC root",
  );
  const wxcExecPath = realRegularFile(
    requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_WXC_EXEC"),
    "wxc-exec",
  );
  requireDescendant(wxcExecPath, mxcRoot, "wxc-exec", "MXC root");

  return {
    artifactDirectory: realDirectory(
      requiredEnvironment(environment, "E2E_ARTIFACT_DIR"),
      "E2E artifact directory",
    ),
    declaredHostPreparation: (() => {
      const value = requiredEnvironment(environment, "NEMOCLAW_WINDOWS_MXC_HOST_PREPARATION");
      if (
        value !== "wxc-host-prep-prepare-system-drive" &&
        value !== "preexisting-compatible-system-drive-acl"
      ) {
        throw new Error("NEMOCLAW_WINDOWS_MXC_HOST_PREPARATION has an unsupported value");
      }
      return value;
    })(),
    workDirectory,
    expected: {
      nemoClawRevision: expectedPattern(environment, "NEMOCLAW_E2E_EXPECTED_SHA", REVISION_PATTERN),
      nodeSha256: expectedPattern(environment, "NEMOCLAW_WINDOWS_MXC_NODE_SHA256", SHA256_PATTERN),
      openClawArchiveSha256: expectedPattern(
        environment,
        "NEMOCLAW_WINDOWS_MXC_OPENCLAW_ARCHIVE_SHA256",
        SHA256_PATTERN,
      ),
      openClawEntrySha256: expectedPattern(
        environment,
        "NEMOCLAW_WINDOWS_MXC_OPENCLAW_ENTRY_SHA256",
        SHA256_PATTERN,
      ),
      openShellDistributionSha256: expectedPattern(
        environment,
        "NEMOCLAW_WINDOWS_MXC_OPENSHELL_DISTRIBUTION_SHA256",
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
      archivePath: openClawArchivePath,
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
      distributionArtifactPath: openShellDistributionArtifactPath,
      distributionRoot: openShellDistributionRoot,
      cliPath: openShellCliPath,
      gatewayPath: openShellGatewayPath,
      packageVersion: expectedPattern(
        environment,
        "NEMOCLAW_WINDOWS_MXC_OPENSHELL_VERSION",
        VERSION_PATTERN,
      ),
      relayPath: openShellRelayPath,
      revision: expectedPattern(
        environment,
        "NEMOCLAW_WINDOWS_MXC_OPENSHELL_REVISION",
        REVISION_PATTERN,
      ),
    },
    mxc: {
      root: mxcRoot,
      wxcExecPath,
    },
  };
}

export { sha256File };

/**
 * Project pinned qualification inputs into the inactive attachment observer contract.
 *
 * This creates observation input only. It does not mint provider authority, qualify the
 * distribution, call OpenShell, or authorize MXC selection.
 */
export function createWindowsMxcOpenShellAttachmentObservationRequest(
  inputs: WindowsMxcOpenClawQualificationInputs,
  gatewayConfigPath: string,
): MxcOpenShellAttachmentObservationRequest {
  const observedGatewayConfigPath = realRegularFile(
    gatewayConfigPath,
    "OpenShell gateway configuration",
  );
  return Object.freeze({
    contractVersion: MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
    providerId: "mxc",
    mode: "attach-existing",
    observedDistribution: Object.freeze({
      version: inputs.openShell.packageVersion,
      revision: inputs.openShell.revision,
    }),
    observedGateway: Object.freeze({
      driver: "mxc",
      backend: "process_container",
    }),
    installation: Object.freeze({
      distributionArtifactPath: inputs.openShell.distributionArtifactPath,
      distributionRoot: inputs.openShell.distributionRoot,
      mxcRoot: inputs.mxc.root,
      cliPath: inputs.openShell.cliPath,
      gatewayPath: inputs.openShell.gatewayPath,
      wxcExecPath: inputs.mxc.wxcExecPath,
      gatewayConfigPath: observedGatewayConfigPath,
    }),
  });
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
  return new RegExp(`(?:^|[\\s"])${escaped}(?=$|[\\s"])`, "u").test(
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
  return new RegExp(`(?:^|[\\s"])${pair}(?=$|[\\s"])`, "u").test(normalized);
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
    readonly compatibilityPreloadPath: string;
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
    !commandLineHasExactArgumentPair(
      identity.child.commandLine,
      "--import",
      pathToFileURL(expected.compatibilityPreloadPath, { windows: true }).href,
    ) ||
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

export function createWindowsMxcGatewayConfiguration(input: {
  readonly distributionRevision: string;
  readonly distributionVersion: string;
  readonly egressProxyPort: number;
  readonly relayPath: string;
  readonly shareDirectory: string;
  readonly targetPort: number;
  readonly wxcExecPath: string;
}): MxcOpenShellQualificationGatewayConfiguration {
  return createMxcOpenShellQualificationGatewayConfiguration({
    ...input,
    distributionProfileId: MXC_OPENSHELL_COMBINED_MXC_V0_8_0_QUALIFICATION_PROFILE_ID,
  });
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
    "ui:",
    "  allow_graphical_ui: true",
    "  clipboard: none",
    "  allow_input_injection: false",
    "",
  ].join("\n");
}

export function renderWindowsMxcOpenClawProbeAgent(): string {
  return `import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(name + " is required");
  return value;
};
const node = required("NEMOCLAW_MXC_E2E_NODE");
const compatibilityPreload = required("NEMOCLAW_MXC_E2E_COMPAT_PRELOAD");
const entry = required("NEMOCLAW_MXC_E2E_ENTRY");
const home = required("NEMOCLAW_MXC_E2E_HOME");
const localAppData = required("NEMOCLAW_MXC_E2E_LOCAL_APP_DATA");
const token = required("NEMOCLAW_MXC_E2E_TOKEN");
const readyPath = required("NEMOCLAW_MXC_E2E_READY_PATH");
const resultPath = required("NEMOCLAW_MXC_E2E_RESULT_PATH");
const outcomePath = required("NEMOCLAW_MXC_E2E_OUTCOME_PATH");
const heartbeatPath = required("NEMOCLAW_MXC_E2E_HEARTBEAT_PATH");
const stopPath = required("NEMOCLAW_MXC_E2E_STOP_PATH");
const temp = required("NEMOCLAW_MXC_E2E_TEMP");
const denyPath = required("NEMOCLAW_MXC_E2E_DENY_PATH");
const mockPort = required("NEMOCLAW_MXC_E2E_MOCK_PORT");
const port = required("NEMOCLAW_MXC_E2E_OPENCLAW_PORT");
const openClawPidPath = required("NEMOCLAW_MXC_E2E_OPENCLAW_PID_PATH");
const openClawStateDirectory = required("NEMOCLAW_MXC_E2E_OPENCLAW_STATE_DIR");
const openClawConfigPath = join(home, ".openclaw", "openclaw.json");
const compatibilityPreloadUrl = pathToFileURL(compatibilityPreload).href;
const env = {
  ...process.env,
  HOME: home,
  LOCALAPPDATA: localAppData,
  NODE_OPTIONS: "--import=" + compatibilityPreloadUrl,
  OPENCLAW_CONFIG_PATH: openClawConfigPath,
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:" + port,
  OPENCLAW_GATEWAY_TOKEN: token,
  OPENCLAW_NO_AUTO_UPDATE: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
  OPENCLAW_STATE_DIR: openClawStateDirectory,
  TEMP: temp,
  TMP: temp,
  USERPROFILE: home,
};
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
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
const mockEndpoint = "127.0.0.1:" + mock.address().port;
// The mock is in this sandbox. Other destinations retain the injected proxy.
env.NO_PROXY = mockEndpoint;
env.no_proxy = mockEndpoint;

const configDirectory = dirname(openClawConfigPath);
mkdirSync(configDirectory, { recursive: true });
writeFileSync(openClawConfigPath, JSON.stringify({
  models: {
    mode: "merge",
    providers: {
      mock: {
        baseUrl: "http://" + mockEndpoint + "/v1",
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

const packageVersion = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8"))?.version;
const version = {
  exitCode: typeof packageVersion === "string" && packageVersion.length > 0 ? 0 : 1,
  stdout: typeof packageVersion === "string" ? packageVersion : "",
};
const gatewayOutputPath = join(home, "gateway-output.log");
const gatewayOutput = openSync(gatewayOutputPath, "w", 0o600);
const gateway = spawn(
  node,
  [
    "--import",
    compatibilityPreloadUrl,
    entry,
    "gateway",
    "run",
    "--auth",
    "token",
    "--bind",
    "loopback",
    "--port",
    port,
  ],
  { env, stdio: ["ignore", gatewayOutput, gatewayOutput], windowsHide: true },
);
closeSync(gatewayOutput);
let gatewaySpawnFailed = false;
gateway.once("error", () => {
  gatewaySpawnFailed = true;
});
if (gateway.pid !== undefined) writeFileSync(openClawPidPath, String(gateway.pid), "utf8");

let startupReadyObserved = false;
// A newly extracted, uniquely named artifact has a cold Defender path. On the
// Windows ARM64 qualification host OpenClaw can spend nearly two minutes
// loading its dependency graph before it begins gateway initialization.
const deadline = Date.now() + 300000;
while (Date.now() < deadline && gateway.exitCode === null && !gatewaySpawnFailed) {
  if (
    existsSync(gatewayOutputPath) &&
    /\\[gateway\\] ready(?:\\r?\\n|$)/u.test(readFileSync(gatewayOutputPath, "utf8"))
  ) {
    startupReadyObserved = true;
    break;
  }
  await sleep(250);
}

const result = {
  controlWrite: true,
  deniedWrite,
  gatewayExitCode: Number.isInteger(gateway.exitCode) ? gateway.exitCode : null,
  gatewayExitedBeforeReadiness: gateway.exitCode !== null,
  gatewaySpawnFailed,
  startupReadyObserved,
  openClawVersion: version.stdout.trim(),
  versionExitCode: version.exitCode,
};
writeFileSync(resultPath, JSON.stringify(result), "utf8");
writeFileSync(outcomePath, JSON.stringify(result), "utf8");
if (startupReadyObserved) writeFileSync(readyPath, JSON.stringify(result), "utf8");

while (startupReadyObserved && gateway.exitCode === null && !existsSync(stopPath)) {
  writeFileSync(heartbeatPath, String(Date.now()), "utf8");
  await sleep(250);
}

if (gateway.exitCode === null && !gatewaySpawnFailed) {
  gateway.kill();
  await Promise.race([
    new Promise((resolve) => gateway.once("exit", resolve)),
    sleep(5000),
  ]);
}
await new Promise((resolve) => mock.close(() => resolve()));
process.exit(startupReadyObserved && deniedWrite ? 0 : 1);
`;
}

export function renderWindowsMxcOpenClawCompatibilityPreload(): string {
  return `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

// Node's native Windows realpath bindings request privileges unavailable to
// AppContainer tokens. Route every variant through the compatible bindings;
// the trusted launcher propagates this preload to Node worker processes.
fs.promises.realpath = promisify(fs.realpath);
fs.realpath.native = fs.realpath;
fs.realpathSync.native = fs.realpathSync;
syncBuiltinESMExports();
`;
}

export function windowsMxcAppContainerAclArguments(directory: string): readonly string[] {
  return Object.freeze([
    directory,
    "/grant",
    "*S-1-15-2-1:(OI)(CI)(M)",
    "*S-1-15-2-2:(OI)(CI)(M)",
    "/T",
    "/C",
    "/Q",
  ]);
}

export function windowsMxcAppContainerReadOnlyAclArguments(
  directory: string,
  ownerIdentity: string,
): readonly string[] {
  if (
    !ownerIdentity ||
    CONTROL_CHARACTER_PATTERN.test(ownerIdentity) ||
    ownerIdentity.includes(":")
  ) {
    throw new Error("Windows artifact owner identity is invalid");
  }
  return Object.freeze([
    directory,
    "/inheritance:r",
    "/grant:r",
    `${ownerIdentity}:(OI)(CI)(F)`,
    "*S-1-5-18:(OI)(CI)(F)",
    "*S-1-5-32-544:(OI)(CI)(F)",
    "*S-1-15-2-1:(OI)(CI)(RX)",
    "*S-1-15-2-2:(OI)(CI)(RX)",
    "/T",
    "/C",
    "/Q",
  ]);
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
      // Qualification commands must not inherit the source checkout as their
      // working directory. A scheduled Windows session can omit LOCALAPPDATA,
      // which makes Windows PowerShell place ModuleAnalysisCache relative to
      // cwd and dirties the checkout before the repeat-cycle identity check.
      cwd: os.tmpdir(),
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
      `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${processId}" -ErrorAction Stop; if ($null -eq $process) { exit 3 }; $process | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine, CreationDate | ConvertTo-Json -Compress`,
    ],
    environment,
    progress,
    activityLabel,
  );
  return parseWindowsProcessQueryResult(result);
}

export function parseWindowsMxcInteractiveHostContext(
  result: CommandResult,
): WindowsMxcHostLaunchContext {
  if (result.exitCode !== 0) throw new Error("Windows host launch-context query failed");
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    // Malformed JSON fails the same field validation as missing launch-context evidence.
    value = null;
  }
  const { processElevated, processSessionId, processUserInteractive } = (value ?? {}) as Record<
    string,
    unknown
  >;
  if (
    typeof processElevated !== "boolean" ||
    typeof processUserInteractive !== "boolean" ||
    typeof processSessionId !== "number" ||
    !Number.isInteger(processSessionId) ||
    processSessionId < 0 ||
    processSessionId > 0xffffffff
  )
    throw new Error("Windows host launch-context output is invalid");
  if (processSessionId === 0 || !processUserInteractive) {
    throw new Error(
      `Windows MXC qualification requires a logged-in interactive Windows session (observed session ${processSessionId}, interactive=${processUserInteractive}); launch from that user's desktop session, not a service or session-0 shell. Elevation alone does not establish an interactive session.`,
    );
  }
  return { processElevated, processSessionId, processUserInteractive };
}

async function observeHostLaunchContext(
  powershellPath: string,
  environment: NodeJS.ProcessEnv,
  progress: ChildProcessProgress,
): Promise<WindowsMxcHostLaunchContext> {
  const result = await runCommand(
    powershellPath,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "@{ processElevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); processSessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId; processUserInteractive = [Environment]::UserInteractive } | ConvertTo-Json -Compress",
    ],
    environment,
    progress,
    "command: windows-mxc-host-launch-context",
  );
  return parseWindowsMxcInteractiveHostContext(result);
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
    "command: windows-mxc-openshell-listener-owner",
    COMMAND_TIMEOUT_MS + 5000,
  );
  if (result.exitCode !== 0) {
    throw new Error("OpenShell process did not own the expected loopback listener");
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
  readonly compatibilityPreloadPath: string;
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

export function windowsMxcOpenClawStartupPreconditionsPass(input: {
  readonly filesystemControlWrite: boolean;
  readonly filesystemDeniedWrite: boolean;
  readonly openClawStartupReady: boolean;
  readonly openClawProcessPresentWhileReady: boolean;
  readonly registryPresentWhileReady: boolean;
  readonly versionExitCode: number | null;
}): boolean {
  return (
    input.filesystemControlWrite &&
    input.filesystemDeniedWrite &&
    input.openClawStartupReady &&
    input.openClawProcessPresentWhileReady &&
    input.registryPresentWhileReady &&
    input.versionExitCode === 0
  );
}

function boundedExitCode(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function classifyWindowsMxcOpenClawStartupObservation(
  result: Record<string, unknown>,
): WindowsMxcOpenClawStartupObservation {
  const gatewayExitCode = boundedExitCode(result.gatewayExitCode);
  const versionExitCode = boundedExitCode(result.versionExitCode);
  if (result.startupReadyObserved === true) {
    return { outcome: "ready", gatewayExitCode, versionExitCode };
  }
  if (result.gatewaySpawnFailed === true) {
    return { outcome: "spawn-failed", gatewayExitCode, versionExitCode };
  }
  if (result.gatewayExitedBeforeReadiness === true) {
    return {
      outcome: "exited-before-readiness",
      gatewayExitCode,
      versionExitCode,
    };
  }
  if (result.startupReadyObserved === false) {
    return { outcome: "readiness-timeout", gatewayExitCode, versionExitCode };
  }
  return { outcome: "not-observed", gatewayExitCode, versionExitCode };
}

export function classifyWindowsMxcForwardHealthObservation(
  result: CommandResult,
): WindowsMxcForwardHealthObservation {
  let value: unknown;
  try {
    value = parseEmbeddedJson(result.stdout, "OpenClaw health output");
  } catch {
    return "terminal";
  }
  if (result.exitCode === 0 && parseOpenClawHealthResult(result.stdout)) return "ready";
  if (
    result.exitCode !== 0 &&
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === false &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "type" in value.error &&
    value.error.type === "gateway_transport_error" &&
    "kind" in value.error &&
    value.error.kind === "closed" &&
    "code" in value.error &&
    value.error.code === 1006 &&
    "reason" in value.error &&
    value.error.reason === "no close reason"
  ) {
    return "relay-not-ready";
  }
  return "terminal";
}

export async function observeWindowsMxcForwardHealthReadiness(input: {
  readonly probe: (attempt: number) => Promise<CommandResult>;
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly forwardActive?: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<WindowsMxcForwardHealthReadinessResult> {
  const maxAttempts = input.attempts ?? FORWARD_HEALTH_READINESS_ATTEMPTS;
  const delayMs = input.delayMs ?? FORWARD_HEALTH_READINESS_DELAY_MS;
  const attempts: Array<{
    readonly attempt: number;
    readonly outcome: WindowsMxcForwardHealthObservation;
  }> = [];
  try {
    const accepted = await pollUntil({
      artifactPrefix: "windows-mxc-forward-health-readiness",
      attempts: maxAttempts,
      delayMs,
      sleep: input.sleep,
      probe: async (attempt) => {
        if (input.forwardActive?.() === false) {
          const command = {
            exitCode: 1,
            stderr: "OpenShell forward exited before the health probe",
            stdout: "",
          };
          const outcome = "terminal" as const;
          attempts.push({ attempt, outcome });
          return { command, outcome };
        }
        const command = await input.probe(attempt);
        let outcome = classifyWindowsMxcForwardHealthObservation(command);
        if (input.forwardActive?.() === false) {
          outcome = "terminal";
        }
        attempts.push({ attempt, outcome });
        return { command, outcome };
      },
      accept: ({ outcome }) => outcome === "ready",
      terminal: ({ outcome }) =>
        outcome === "terminal" ? "forwarded OpenClaw health failed" : undefined,
    });
    return {
      command: accepted.value.command,
      evidence: {
        schemaVersion: 1,
        operation: "windows-mxc-forward-authenticated-health",
        maxAttempts,
        delayMs,
        attempts,
        outcome: "ready",
      },
    };
  } catch (error) {
    if (!(error instanceof PollingError) || error.lastAttempt === undefined) throw error;
    return {
      command: error.lastAttempt.value.command,
      evidence: {
        schemaVersion: 1,
        operation: "windows-mxc-forward-authenticated-health",
        maxAttempts,
        delayMs,
        attempts,
        outcome: error.reason === "terminal" ? "terminal" : "exhausted",
      },
    };
  }
}

export function parseOpenClawExactChatReply(output: string): boolean {
  return isExactOpenClawAgentText(output, "CHAT_OK");
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

export function observeWindowsNativeArchitecture(
  environment: NodeJS.ProcessEnv,
): "x64" | "arm64" | null {
  const processorIdentifier = environment.PROCESSOR_IDENTIFIER?.trim().toLowerCase() ?? "";
  const identifierArchitecture = /\b(?:arm64|armv8|aarch64)\b/u.test(processorIdentifier)
    ? "arm64"
    : undefined;
  const value = (
    environment.PROCESSOR_ARCHITEW6432 ??
    identifierArchitecture ??
    environment.PROCESSOR_ARCHITECTURE ??
    ""
  )
    .trim()
    .toLowerCase();
  if (value === "amd64") return "x64";
  if (value === "arm64") return "arm64";
  return null;
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
    openClawArchiveSha256: sha256File(inputs.openClaw.archivePath),
    openClawEntrySha256: sha256File(inputs.openClaw.entryPath),
    openShellDistributionSha256: sha256File(inputs.openShell.distributionArtifactPath),
    openShellCliSha256: sha256File(inputs.openShell.cliPath),
    openShellGatewaySha256: sha256File(inputs.openShell.gatewayPath),
    openShellRelaySha256: sha256File(inputs.openShell.relayPath),
    wxcExecSha256: sha256File(inputs.mxc.wxcExecPath),
  };
  for (const [name, value] of Object.entries(observed)) {
    if (value !== inputs.expected[name as keyof typeof observed]) {
      throw new Error(`${name} does not match the expected exact identity`);
    }
  }
}

function assertExactPreparedArtifactIdentities(
  inputs: WindowsMxcOpenClawQualificationInputs,
  prepared: WindowsMxcPreparedOpenClawArtifact,
): void {
  const observed = {
    nodeSha256: sha256File(prepared.nodePath),
    openClawEntrySha256: sha256File(prepared.entryPath),
    openShellDistributionSha256: sha256File(inputs.openShell.distributionArtifactPath),
    openShellCliSha256: sha256File(inputs.openShell.cliPath),
    openShellGatewaySha256: sha256File(inputs.openShell.gatewayPath),
    openShellRelaySha256: sha256File(inputs.openShell.relayPath),
    wxcExecSha256: sha256File(inputs.mxc.wxcExecPath),
  };
  for (const [name, value] of Object.entries(observed)) {
    if (value !== inputs.expected[name as keyof typeof observed]) {
      throw new Error(`${name} does not match the expected exact identity`);
    }
  }
  if (prepared.archiveSha256 !== inputs.expected.openClawArchiveSha256) {
    throw new Error("openClawArchiveSha256 does not match the prepared exact identity");
  }
}

function createWindowsMxcOpenClawQualificationWorkload(
  inputs: WindowsMxcOpenClawQualificationInputs,
  probeAgentPath: string,
): NativeArtifactWorkloadReceiptV1 {
  const startupProfile = managedStartupE2eProfile("openclaw");
  const encodedProfile = encodeManagedStartupProfile(startupProfile);
  const executableRelativePath = path.win32
    .relative(inputs.openClaw.root, inputs.openClaw.nodePath)
    .replaceAll("\\", "/");
  return Object.freeze({
    schemaVersion: NATIVE_ARTIFACT_WORKLOAD_RECEIPT_SCHEMA_VERSION,
    kind: "native-artifact",
    contractVersion: NATIVE_ARTIFACT_WORKLOAD_CONTRACT_VERSION,
    agent: NATIVE_ARTIFACT_WORKLOAD_AGENT,
    platform: NATIVE_ARTIFACT_WORKLOAD_PLATFORM,
    artifact: Object.freeze({
      digest: `sha256:${inputs.expected.openClawArchiveSha256}`,
      version: inputs.openClaw.version,
      source: Object.freeze({
        repository: NATIVE_ARTIFACT_SOURCE_REPOSITORY,
        revision: inputs.expected.nemoClawRevision,
      }),
    }),
    launch: Object.freeze({
      executable: Object.freeze({
        relativePath: executableRelativePath,
        digest: `sha256:${inputs.expected.nodeSha256}`,
      }),
      arguments: Object.freeze([probeAgentPath]),
      workingDirectory: ".",
      environmentNames: Object.freeze([
        "HOME",
        "OPENCLAW_CONFIG_PATH",
        "OPENCLAW_HOME",
        "OPENCLAW_STATE_DIR",
        ...AGENT_ENVIRONMENT_NAMES,
        "TEMP",
        "TMP",
        "USERPROFILE",
      ]),
    }),
    startupProfileContractVersion: startupProfile.schemaVersion,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: true,
    shared: true,
  });
}

function createWindowsMxcOpenClawCompositionInput(input: {
  readonly bootstrap: {
    readonly lifecycleGeneration: string;
    readonly sandboxName: string;
  };
  readonly executorEnvironment: NodeJS.ProcessEnv;
  readonly distributionAuthority: MxcOpenShellDistributionAuthority;
  readonly executorRuntime: MxcWindowsOpenShellExecutorRuntime;
  readonly gatewayConfigPath: string;
  readonly gatewayName: string;
  readonly inputs: WindowsMxcOpenClawQualificationInputs;
  readonly policyPath: string;
  readonly probeAgentPath: string;
  readonly recordFailure: (record: MxcOpenShellLiveFailureRecord) => void;
}): WindowsMxcInactiveOnboardingCompositionInput {
  return {
    distributionAuthority: input.distributionAuthority,
    attachmentObservation: createWindowsMxcOpenShellAttachmentObservationRequest(
      input.inputs,
      input.gatewayConfigPath,
    ),
    gatewayName: input.gatewayName,
    workspace: "default",
    policy: { path: input.policyPath, sha256: sha256File(input.policyPath) },
    bootstrap: {
      sandboxName: input.bootstrap.sandboxName,
      lifecycleGeneration: input.bootstrap.lifecycleGeneration,
      driveRoot: input.inputs.workDirectory,
      artifactRoot: input.inputs.openClaw.root,
      workload: createWindowsMxcOpenClawQualificationWorkload(input.inputs, input.probeAgentPath),
    },
    executorEnvironment: input.executorEnvironment,
    executorEnvironmentReferences: AGENT_ENVIRONMENT_NAMES,
    executorRuntime: input.executorRuntime,
    recordFailure: input.recordFailure,
  };
}

export async function stageWindowsMxcOpenClawArtifact(
  sourceRoot: string,
  stagingRoot: string,
  prepareAccess: (directory: string) => Promise<void>,
): Promise<void> {
  // Refuse existing roots. Children inherit access when created, avoiding a
  // recursive ACL rewrite after the large artifact tree has been populated.
  fs.mkdirSync(stagingRoot, { recursive: false });
  await prepareAccess(stagingRoot);
  // Copy to new entries, not the already-created root. The pinned Node rejects
  // existing directory destinations with errorOnExist; its sync path can abort.
  for (const entry of fs.readdirSync(sourceRoot)) {
    await fs.promises.cp(path.join(sourceRoot, entry), path.join(stagingRoot, entry), {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
  }
}

export async function copyWindowsMxcOpenClawArchiveWithSha256(
  sourceArchive: string,
  destinationArchive: string,
  expectedSha256: string,
): Promise<string> {
  const digest = createHash("sha256");
  let bytes = 0;
  const hashingStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      bytes += chunk.byteLength;
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      fs.createReadStream(sourceArchive),
      hashingStream,
      fs.createWriteStream(destinationArchive, { flags: "wx", mode: 0o600 }),
    );
    const observedSha256 = digest.digest("hex");
    if (observedSha256 !== expectedSha256) {
      throw new Error("OpenClaw archive does not match the expected exact identity");
    }
    if (fs.statSync(destinationArchive).size !== bytes) {
      throw new Error("OpenClaw archive copy did not preserve its exact byte length");
    }
    return observedSha256;
  } catch (error) {
    fs.rmSync(destinationArchive, { force: true });
    throw error;
  }
}

export interface WindowsMxcPreparedOpenClawArtifact {
  readonly archiveSha256: string;
  readonly entryPath: string;
  readonly nodePath: string;
  readonly root: string;
  readonly version: string;
  createExecutorRuntime(environment: NodeJS.ProcessEnv): MxcWindowsOpenShellExecutorRuntime;
  release(): void;
}

export async function prepareWindowsMxcOpenClawArchiveArtifact(
  inputs: WindowsMxcOpenClawQualificationInputs,
  progress: ChildProcessProgress,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WindowsMxcPreparedOpenClawArtifact> {
  const icaclsPath = trustedWindowsSystemExecutable(
    environment,
    ["System32", "icacls.exe"],
    "Windows icacls",
  );
  const tarPath = trustedWindowsSystemExecutable(
    environment,
    ["System32", "tar.exe"],
    "Windows archive extractor",
  );
  const whoamiPath = trustedWindowsSystemExecutable(
    environment,
    ["System32", "whoami.exe"],
    "Windows user identity observer",
  );
  const preparedRoot = fs.mkdtempSync(
    path.join(inputs.workDirectory, "nemoclaw-mxc-openclaw-archive-"),
  );
  // OpenShell's native bootstrap requires the artifact root itself to be a
  // direct child of the drive root. Keep the verified archive copy beside the
  // extracted tree so it is never exposed through the sandbox filesystem
  // policy.
  const artifactRoot = preparedRoot;
  const archiveCopyPath = `${preparedRoot}.zip`;
  let released = false;
  try {
    await copyWindowsMxcOpenClawArchiveWithSha256(
      inputs.openClaw.archivePath,
      archiveCopyPath,
      inputs.expected.openClawArchiveSha256,
    );
    const owner = await runCommand(
      whoamiPath,
      [],
      allowlistedWindowsProcessEnvironment(environment),
      progress,
      "command: windows-mxc-openclaw-artifact-owner",
    );
    if (owner.exitCode !== 0 || !owner.stdout.trim()) {
      throw new Error(`OpenClaw artifact owner observation failed: ${commandDetail(owner)}`);
    }
    const acl = await runCommand(
      icaclsPath,
      windowsMxcAppContainerReadOnlyAclArguments(artifactRoot, owner.stdout.trim()),
      allowlistedWindowsProcessEnvironment(environment),
      progress,
      "command: windows-mxc-openclaw-read-only-artifact-dacl",
    );
    if (acl.exitCode !== 0) {
      throw new Error(`OpenClaw read-only DACL preparation failed: ${commandDetail(acl)}`);
    }
    const extracted = await runCommand(
      tarPath,
      ["-xf", archiveCopyPath, "-C", artifactRoot],
      allowlistedWindowsProcessEnvironment(environment),
      progress,
      "command: windows-mxc-openclaw-archive-extract",
      10 * 60_000,
    );
    if (extracted.exitCode !== 0) {
      throw new Error(`OpenClaw archive extraction failed: ${commandDetail(extracted)}`);
    }
    const nodePath = realRegularFile(
      path.join(artifactRoot, path.relative(inputs.openClaw.root, inputs.openClaw.nodePath)),
      "staged OpenClaw Node.js executable",
    );
    const entryPath = realRegularFile(
      path.join(artifactRoot, path.relative(inputs.openClaw.root, inputs.openClaw.entryPath)),
      "staged OpenClaw entrypoint",
    );
    assertExactFileIdentity(nodePath, inputs.expected.nodeSha256, "stagedNodeSha256");
    assertExactFileIdentity(
      entryPath,
      inputs.expected.openClawEntrySha256,
      "stagedOpenClawEntrySha256",
    );
    const tree: MxcWindowsOpenShellArtifactTree = Object.freeze({
      directories: Object.freeze([artifactRoot]),
      files: Object.freeze(
        [
          Object.freeze({ path: nodePath, sha256: inputs.expected.nodeSha256 }),
          Object.freeze({ path: entryPath, sha256: inputs.expected.openClawEntrySha256 }),
        ].sort((left, right) => left.path.localeCompare(right.path, "en", { sensitivity: "base" })),
      ),
      sha256: inputs.expected.openClawArchiveSha256,
    });
    const observePreparedTree = (root: string): MxcWindowsOpenShellArtifactTree => {
      if (
        normalizeWindowsIdentityValue(path.resolve(root)) !==
        normalizeWindowsIdentityValue(path.resolve(artifactRoot))
      ) {
        throw new Error("prepared OpenClaw artifact root identity drifted");
      }
      assertExactFileIdentity(nodePath, inputs.expected.nodeSha256, "stagedNodeSha256");
      assertExactFileIdentity(
        entryPath,
        inputs.expected.openClawEntrySha256,
        "stagedOpenClawEntrySha256",
      );
      return tree;
    };
    return Object.freeze({
      archiveSha256: inputs.expected.openClawArchiveSha256,
      entryPath,
      nodePath,
      root: artifactRoot,
      version: inputs.openClaw.version,
      createExecutorRuntime: (runtimeEnvironment: NodeJS.ProcessEnv) => {
        const base = createMxcWindowsOpenShellExecutorRuntime(runtimeEnvironment);
        return Object.freeze({ ...base, observeArtifactTree: observePreparedTree });
      },
      release: () => {
        if (released) return;
        fs.rmSync(preparedRoot, { force: true, recursive: true });
        fs.rmSync(archiveCopyPath, { force: true });
        released = true;
      },
    });
  } catch (error) {
    fs.rmSync(preparedRoot, { force: true, recursive: true });
    fs.rmSync(archiveCopyPath, { force: true });
    throw error;
  }
}

async function prepareWindowsMxcOpenClawLocalSetup(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly icaclsPath: string;
  readonly inputs: WindowsMxcOpenClawQualificationInputs;
  readonly hostLaunchContext: WindowsMxcHostLaunchContext;
  readonly progress: ChildProcessProgress;
  readonly preparedOpenClaw: WindowsMxcPreparedOpenClawArtifact;
  readonly receiptPath: string;
  readonly runId: string;
  readonly sandboxName: string;
  readonly shareDirectory: string;
}) {
  return await withWindowsMxcLocalSetupOwnership({
    receiptPath: input.receiptPath,
    failureReceipt: (localArtifactsRemoved) =>
      buildWindowsMxcSetupFailureReceipt(
        input.inputs,
        input.hostLaunchContext,
        localArtifactsRemoved,
      ),
    operation: async (localSetup) => {
      const runRoot = localSetup.trackRoot(
        fs.mkdtempSync(
          path.join(input.inputs.workDirectory, `nemoclaw-mxc-openclaw-${input.runId}-`),
        ),
      );
      fs.mkdirSync(input.shareDirectory, { recursive: false });
      const shareDirectory = localSetup.trackRoot(input.shareDirectory);
      const stateDirectory = path.join(runRoot, "state");
      const configDirectory = path.join(runRoot, "config");
      const controlHomeDirectory = path.join(runRoot, "openshell-cli-home");
      const homeDirectory = path.join(shareDirectory, "home");
      const localAppDataDirectory = path.join(homeDirectory, "AppData", "Local");
      const openClawStateDirectory = path.join(shareDirectory, "openclaw-state");
      const tempDirectory = path.join(shareDirectory, "temp");
      const clientHomeDirectory = path.join(runRoot, "client-home");
      for (const directory of [
        shareDirectory,
        stateDirectory,
        configDirectory,
        controlHomeDirectory,
        homeDirectory,
        localAppDataDirectory,
        openClawStateDirectory,
        tempDirectory,
        clientHomeDirectory,
      ]) {
        fs.mkdirSync(directory, { recursive: true });
      }

      const prepareAccess = async (directory: string): Promise<void> => {
        const acl = await runCommand(
          input.icaclsPath,
          windowsMxcAppContainerAclArguments(directory),
          allowlistedWindowsProcessEnvironment(input.environment),
          input.progress,
          "command: windows-mxc-openclaw-appcontainer-dacl",
        );
        if (acl.exitCode !== 0) {
          throw new Error(`AppContainer DACL preparation failed: ${commandDetail(acl)}`);
        }
      };
      const stagedOpenClaw = input.preparedOpenClaw;
      // The archive was copied while hashing, extracted once under read-only
      // AppContainer access, and is shared by both qualification cycles.

      const gatewayConfigPath = path.join(runRoot, "gateway.toml");
      const policyPath = path.join(runRoot, "policy.yaml");
      const compatibilityPreloadPath = path.join(
        shareDirectory,
        "openclaw-appcontainer-preload.mjs",
      );
      const probeAgentPath = path.join(shareDirectory, "probe-agent.mjs");
      const relayPath = path.join(shareDirectory, "openshell-supervisor-relay.exe");
      const readyPath = path.join(shareDirectory, "ready.json");
      const resultPath = path.join(shareDirectory, "result.json");
      const outcomePath = path.join(shareDirectory, "outcome.json");
      const heartbeatPath = path.join(shareDirectory, "heartbeat.txt");
      const openClawPidPath = path.join(shareDirectory, "openclaw.pid");
      const openClawGatewayOutputPath = path.join(homeDirectory, "gateway-output.log");
      const stopPath = path.join(shareDirectory, "stop.txt");
      const denyPath = path.join(runRoot, "denied-write.txt");
      const gatewayLogPath = path.join(runRoot, "openshell-gateway.log");
      const gatewayErrorPath = path.join(runRoot, "openshell-gateway.err.log");
      const forwardLogPath = path.join(runRoot, "openshell-forward.log");
      const forwardErrorPath = path.join(runRoot, "openshell-forward.err.log");
      const [gatewayPort, forwardPort, mockPort, openClawPort, egressProxyPort] =
        await freeDistinctLoopbackPorts(5);
      if (
        gatewayPort === undefined ||
        forwardPort === undefined ||
        mockPort === undefined ||
        openClawPort === undefined ||
        egressProxyPort === undefined
      ) {
        throw new Error("could not allocate all Windows MXC qualification ports");
      }
      const gatewayName = `mxc-gw-${input.runId}`;
      const token = randomBytes(32).toString("base64url");

      fs.copyFileSync(input.inputs.openShell.relayPath, relayPath);
      assertExactFileIdentity(
        relayPath,
        input.inputs.expected.openShellRelaySha256,
        "stagedRelaySha256",
      );

      const gatewayConfiguration = createWindowsMxcGatewayConfiguration({
        distributionRevision: input.inputs.openShell.revision,
        distributionVersion: input.inputs.openShell.packageVersion,
        egressProxyPort,
        relayPath,
        shareDirectory,
        targetPort: openClawPort,
        wxcExecPath: input.inputs.mxc.wxcExecPath,
      });
      fs.writeFileSync(gatewayConfigPath, gatewayConfiguration.content, {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.writeFileSync(
        policyPath,
        renderWindowsMxcFilesystemPolicy({
          openClawRoot: stagedOpenClaw.root,
          shareDirectory,
        }),
        { encoding: "utf8", mode: 0o600 },
      );
      fs.writeFileSync(probeAgentPath, renderWindowsMxcOpenClawProbeAgent(), {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.writeFileSync(compatibilityPreloadPath, renderWindowsMxcOpenClawCompatibilityPreload(), {
        encoding: "utf8",
        mode: 0o600,
      });

      await prepareAccess(shareDirectory);

      const gatewayEnvironment: NodeJS.ProcessEnv = withoutOpenShellGatewaySelection({
        ...allowlistedWindowsProcessEnvironment(input.environment),
        NEMOCLAW_MXC_E2E_COMPAT_PRELOAD: compatibilityPreloadPath,
        NEMOCLAW_MXC_E2E_DENY_PATH: denyPath,
        NEMOCLAW_MXC_E2E_ENTRY: stagedOpenClaw.entryPath,
        NEMOCLAW_MXC_E2E_HEARTBEAT_PATH: heartbeatPath,
        NEMOCLAW_MXC_E2E_HOME: homeDirectory,
        NEMOCLAW_MXC_E2E_LOCAL_APP_DATA: localAppDataDirectory,
        NEMOCLAW_MXC_E2E_MOCK_PORT: String(mockPort),
        NEMOCLAW_MXC_E2E_NODE: stagedOpenClaw.nodePath,
        NEMOCLAW_MXC_E2E_OPENCLAW_PORT: String(openClawPort),
        NEMOCLAW_MXC_E2E_OPENCLAW_PID_PATH: openClawPidPath,
        NEMOCLAW_MXC_E2E_OPENCLAW_STATE_DIR: openClawStateDirectory,
        NEMOCLAW_MXC_E2E_OUTCOME_PATH: outcomePath,
        NEMOCLAW_MXC_E2E_READY_PATH: readyPath,
        NEMOCLAW_MXC_E2E_RESULT_PATH: resultPath,
        NEMOCLAW_MXC_E2E_STOP_PATH: stopPath,
        NEMOCLAW_MXC_E2E_TEMP: tempDirectory,
        NEMOCLAW_MXC_E2E_TOKEN: token,
        OPENSHELL_DRIVERS: "mxc",
        OPENSHELL_GATEWAY_CONFIG: gatewayConfigPath,
        XDG_CONFIG_HOME: configDirectory,
        XDG_STATE_HOME: stateDirectory,
      });
      const controlEnvironment: NodeJS.ProcessEnv = {
        ...allowlistedWindowsProcessEnvironment(input.environment),
        HOME: controlHomeDirectory,
        USERPROFILE: controlHomeDirectory,
        XDG_CONFIG_HOME: configDirectory,
        XDG_STATE_HOME: stateDirectory,
      };
      const executorEnvironment: NodeJS.ProcessEnv = {
        ...gatewayEnvironment,
        HOME: controlHomeDirectory,
        USERPROFILE: controlHomeDirectory,
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
        compatibilityPreloadPath,
        controlEnvironment,
        executorEnvironment,
        distributionAuthority: gatewayConfiguration.distributionAuthority,
        denyPath,
        forwardErrorPath,
        forwardLogPath,
        forwardPort,
        forwardStderr,
        forwardStdout,
        gatewayEnvironment,
        gatewayErrorPath,
        gatewayConfigPath,
        gatewayLogPath,
        gatewayName,
        gatewayPort,
        gatewayStderr,
        gatewayStdout,
        heartbeatPath,
        homeDirectory,
        localSetup,
        openClawGatewayOutputPath,
        openClawPidPath,
        openClawPort,
        outcomePath,
        policyPath,
        probeAgentPath,
        readyPath,
        resultPath,
        runRoot,
        sandboxName: input.sandboxName,
        shareDirectory,
        stateDirectory,
        stagedOpenClaw,
        stopPath,
        token,
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
  readonly providerRecoveryAttempted: boolean;
  readonly receiptPath: string;
  readonly retainedSandboxName: string | null;
}): AggregateError {
  return new AggregateError(
    input.failures,
    `Windows MXC OpenClaw qualification failed; retained sandbox=${input.retainedSandboxName ?? "none"}, provider recovery attempted=${input.providerRecoveryAttempted}, OpenClaw stopped=${input.openClawProcessStopped}; receipt: ${input.receiptPath}`,
  );
}

export async function runWindowsMxcOpenClawProcessContainerQualification(
  inputs: WindowsMxcOpenClawQualificationInputs,
  progress: QualificationProgress,
  preparedOpenClaw: WindowsMxcPreparedOpenClawArtifact,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WindowsMxcOpenClawQualificationReceipt> {
  const observedNativeArchitecture = observeWindowsNativeArchitecture(environment);
  const host = assessWindowsMxcProcessContainerCandidate(
    {
      platform: process.platform,
      nativeArchitecture: observedNativeArchitecture ?? "unknown",
      release: os.release(),
    },
    observedNativeArchitecture ?? undefined,
  );
  if (!host.candidate) throw new Error(host.detail);
  requireWindowsDriveRoot(inputs.workDirectory);
  assertCurrentCheckoutIdentity(inputs.expected.nemoClawRevision);
  assertExactPreparedArtifactIdentities(inputs, preparedOpenClaw);
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
  const icaclsPath = trustedWindowsSystemExecutable(
    environment,
    ["System32", "icacls.exe"],
    "Windows icacls",
  );
  const hostProcessEnvironment = allowlistedWindowsProcessEnvironment(environment);
  const hostLaunchContext = await observeHostLaunchContext(
    powershellPath,
    hostProcessEnvironment,
    progress,
  );

  const version = await runCommand(
    preparedOpenClaw.nodePath,
    [preparedOpenClaw.entryPath, "--version"],
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
  const sandboxName = `mxc-oc-${runId}`;
  const lifecycleGeneration = `qualification-${runId}`;
  const shareDirectory = resolveMxcNativeArtifactShareDirectory({
    driveRoot: inputs.workDirectory,
    sandboxName,
    lifecycleGeneration,
  });
  const receiptPath = path.join(
    inputs.artifactDirectory,
    `windows-mxc-openclaw-receipt-${runId}.json`,
  );
  const forwardHealthReadinessPath = path.join(
    inputs.artifactDirectory,
    `windows-mxc-forward-health-readiness-${runId}.json`,
  );
  const {
    clientEnvironment,
    clientHomeDirectory,
    compatibilityPreloadPath,
    configDirectory,
    controlEnvironment,
    distributionAuthority,
    denyPath,
    forwardErrorPath,
    forwardLogPath,
    forwardPort,
    forwardStderr,
    forwardStdout,
    executorEnvironment,
    gatewayEnvironment,
    gatewayConfigPath,
    gatewayErrorPath,
    gatewayLogPath,
    gatewayName,
    gatewayPort,
    gatewayStderr,
    gatewayStdout,
    heartbeatPath,
    homeDirectory,
    localSetup,
    openClawGatewayOutputPath,
    openClawPidPath,
    openClawPort,
    outcomePath,
    policyPath,
    probeAgentPath,
    readyPath,
    resultPath,
    runRoot,
    stateDirectory,
    stagedOpenClaw,
    stopPath,
    token,
  } = await prepareWindowsMxcOpenClawLocalSetup({
    environment,
    icaclsPath,
    inputs,
    hostLaunchContext,
    progress,
    preparedOpenClaw,
    receiptPath,
    runId,
    sandboxName,
    shareDirectory,
  });
  const observedGatewayConfigSha256 = sha256File(gatewayConfigPath);
  const sandboxInputs: WindowsMxcOpenClawQualificationInputs = Object.freeze({
    ...inputs,
    openClaw: Object.freeze({
      archivePath: inputs.openClaw.archivePath,
      entryPath: stagedOpenClaw.entryPath,
      nodePath: stagedOpenClaw.nodePath,
      root: stagedOpenClaw.root,
      version: stagedOpenClaw.version,
    }),
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
  let sensitiveRuntimeArtifactsRemoved = false;
  let openClawProcessId: number | null = null;
  let trustedOpenClawProcess: TrustedOpenClawProcessIdentity | null = null;
  let trustedGatewayProcess: WindowsProcessIdentity | null = null;
  let trustedForwardProcess: WindowsProcessIdentity | null = null;
  let primaryFailure: unknown = null;
  const cleanupFailures: unknown[] = [];
  const providerFailureRecords: MxcOpenShellLiveFailureRecord[] = [];
  let providerCreateResult: RuntimeProviderNativeArtifactBootstrapResult | null = null;
  let providerCleanupResult: RuntimeProviderNativeArtifactBootstrapResult | null = null;
  let providerRecoveryAttempted = false;
  let attachmentReceipt: MxcOpenShellAttachmentReceipt | null = null;
  let startup: WindowsMxcOpenClawStartupObservation = {
    outcome: "not-observed",
    gatewayExitCode: null,
    versionExitCode: null,
  };
  let checks: QualificationChecks = {
    attachmentObserved: false,
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
  let providerLifecycle: ReturnType<typeof createWindowsMxcInactiveOnboardingLifecycle> | null =
    null;
  const recoverProviderSandbox = async (): Promise<boolean> => {
    if (providerRecoveryAttempted) {
      return providerCleanupResult?.resourceState === "absent";
    }
    providerRecoveryAttempted = true;
    if (providerLifecycle === null) {
      return false;
    }
    const recovered = await providerLifecycle.recover();
    providerCleanupResult = recovered.bootstrapResult;
    attachmentReceipt ??= recovered.attachmentReceipt;
    const removed =
      recovered.bootstrapResult.outcome === "not-created" &&
      recovered.bootstrapResult.resourceState === "absent" &&
      recovered.bootstrapResult.cleanup.resourceRemovalAuthorized &&
      recovered.bootstrapResult.cleanup.removed;
    checks = {
      ...checks,
      sandboxDeleteAccepted: removed,
      registryRemovedAfterDelete: removed,
    };
    return removed;
  };

  try {
    const lifecycle = createWindowsMxcInactiveOnboardingLifecycle(
      createWindowsMxcOpenClawCompositionInput({
        bootstrap: { lifecycleGeneration, sandboxName },
        executorEnvironment,
        executorRuntime: preparedOpenClaw.createExecutorRuntime(executorEnvironment),
        distributionAuthority,
        gatewayConfigPath,
        gatewayName,
        inputs: sandboxInputs,
        policyPath,
        probeAgentPath,
        recordFailure: (record) => {
          providerFailureRecords.push(record);
        },
      }),
    );
    providerLifecycle = lifecycle;
    await lifecycle.qualify();
    checks = { ...checks, attachmentObserved: true };
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
    if (gateway.pid === undefined) throw new Error("OpenShell gateway did not report a process ID");
    await waitForOwnedLoopbackListener({
      environment: controlEnvironment,
      port: gatewayPort,
      powershellPath,
      processId: gateway.pid,
      progress,
    });
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

    assertExactPreparedArtifactIdentities(inputs, preparedOpenClaw);
    sandboxCreateStarted = true;
    const created = await lifecycle.run();
    providerCreateResult = created.bootstrapResult;
    attachmentReceipt = created.attachmentReceipt;
    const startupOutput = readWindowsMxcOpenClawGatewayOutput(openClawGatewayOutputPath, token);
    if (startupOutput !== null) {
      fs.writeFileSync(
        path.join(inputs.artifactDirectory, `windows-mxc-openclaw-startup-${runId}.log`),
        startupOutput,
        { encoding: "utf8", mode: 0o600 },
      );
    }
    checks = {
      ...checks,
      attachmentObserved: true,
      registryPresentWhileReady: created.bootstrapResult.outcome === "ready",
      registryRemovedAfterDelete: created.bootstrapResult.resourceState === "absent",
      sandboxCreateAccepted: created.bootstrapResult.outcome === "ready",
    };
    if (created.bootstrapResult.outcome !== "ready") {
      throw new Error(
        `provider-owned sandbox creation did not reach readiness: ${created.bootstrapResult.reason ?? created.bootstrapResult.outcome}`,
      );
    }

    await waitForFile(outcomePath, READY_TIMEOUT_MS);
    const ready = fs.existsSync(readyPath);
    const probeResult = fs.existsSync(resultPath)
      ? (JSON.parse(fs.readFileSync(resultPath, "utf8")) as Record<string, unknown>)
      : {};
    fs.writeFileSync(
      path.join(inputs.artifactDirectory, `windows-mxc-probe-readiness-${runId}.json`),
      `${JSON.stringify(
        {
          startupReadyObserved: probeResult.startupReadyObserved === true,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    startup = classifyWindowsMxcOpenClawStartupObservation(probeResult);
    openClawProcessId = readProcessId(openClawPidPath);
    if (openClawProcessId !== null) {
      trustedOpenClawProcess = await observeTrustedOpenClawProcessIdentity({
        compatibilityPreloadPath,
        entryPath: stagedOpenClaw.entryPath,
        environment: controlEnvironment,
        nodePath: stagedOpenClaw.nodePath,
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
      openClawHealth: false,
      openClawProcessPresentWhileReady: trustedOpenClawProcess !== null,
    };

    if (
      !windowsMxcOpenClawStartupPreconditionsPass({
        ...checks,
        openClawStartupReady:
          ready && probeResult.startupReadyObserved === true && reportedVersion !== null,
        versionExitCode: startup.versionExitCode,
      })
    ) {
      throw new Error("Windows MXC OpenClaw startup preconditions failed before forwarding");
    }

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

    const forwardedHealth = await observeWindowsMxcForwardHealthReadiness({
      forwardActive: () => forward?.exitCode === null,
      probe: async (attempt) =>
        await runCommand(
          inputs.openClaw.nodePath,
          [inputs.openClaw.entryPath, "gateway", "health", "--json", "--timeout", "60000"],
          clientEnvironment,
          progress,
          `command: windows-mxc-openclaw-forwarded-health-attempt-${attempt}`,
          // OpenClaw's internal 60-second timeout starts only after its CLI has
          // initialized. A cold ARM64 install can spend more than 30 seconds
          // loading its dependency tree while Defender scans it, so preserve
          // the product timeout but leave enough room for CLI startup.
          300_000,
        ),
    });
    fs.writeFileSync(
      forwardHealthReadinessPath,
      `${JSON.stringify(forwardedHealth.evidence, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    checks = {
      ...checks,
      forwardAuthenticatedHealth: forwardedHealth.evidence.outcome === "ready",
      openClawHealth: forwardedHealth.evidence.outcome === "ready",
    };
    if (!checks.forwardAuthenticatedHealth) {
      throw new Error(
        `forwarded OpenClaw health ${forwardedHealth.evidence.outcome}: ${commandDetail(forwardedHealth.command)}`,
      );
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
    if (!(await recoverProviderSandbox())) {
      throw new Error("provider-owned recovery did not confirm exact sandbox removal");
    }
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
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (
      sandboxCreateStarted &&
      !providerRecoveryAttempted &&
      providerCreateResult?.resourceState !== "absent" &&
      providerCreateResult?.cleanup.attempted !== true
    ) {
      try {
        if (!(await recoverProviderSandbox())) {
          cleanupFailures.push(new Error("provider-owned recovery retained the sandbox"));
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
    for (const [source, name] of [
      [gatewayLogPath, "openshell-gateway"],
      [gatewayErrorPath, "openshell-gateway-error"],
      [forwardLogPath, "openshell-forward"],
      [forwardErrorPath, "openshell-forward-error"],
    ] as const) {
      try {
        const output = readWindowsMxcOpenClawGatewayOutput(source, token);
        if (!output) continue;
        fs.writeFileSync(
          path.join(inputs.artifactDirectory, `windows-mxc-${name}-${runId}.log`),
          output,
          { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    const runtimeArtifactCleanup = removeWindowsMxcRuntimeArtifacts({
      runRoot,
      shareDirectory,
      sensitivePaths: [
        clientHomeDirectory,
        homeDirectory,
        configDirectory,
        stateDirectory,
        gatewayLogPath,
        gatewayErrorPath,
        forwardLogPath,
        forwardErrorPath,
      ],
    });
    cleanupFailures.push(...runtimeArtifactCleanup.failures);
    runDirectoryRemoved = runtimeArtifactCleanup.runDirectoryRemoved;
    sensitiveRuntimeArtifactsRemoved = runtimeArtifactCleanup.sensitiveRuntimeArtifactsRemoved;
  }

  const lifecyclePassed =
    receiptPasses(checks) &&
    !boundedStopMarkerNeeded &&
    !emergencyProcessTerminationNeeded &&
    !emergencyGatewayTerminationNeeded &&
    !emergencyForwardTerminationNeeded &&
    forwardListenerStopped &&
    forwardProcessStopped &&
    gatewayStopped &&
    openClawProcessStopped &&
    runDirectoryRemoved &&
    sensitiveRuntimeArtifactsRemoved &&
    primaryFailure === null &&
    providerFailureRecords.length === 0 &&
    cleanupFailures.length === 0;
  if (runDirectoryRemoved) {
    localSetup.releaseRoot(runRoot);
    localSetup.releaseRoot(shareDirectory);
  } else {
    cleanupFailures.push(new Error("qualification run directory remains after cleanup"));
  }

  const retainedSandboxName = retainedWindowsMxcSandboxName({
    registryRemovedAfterDelete: checks.registryRemovedAfterDelete,
    sandboxCreateStarted,
    sandboxName,
  });
  const receipt: WindowsMxcOpenClawQualificationReceipt = {
    schemaVersion: WINDOWS_MXC_OPENCLAW_QUALIFICATION_RECEIPT_SCHEMA_VERSION,
    classification: "inactive-candidate",
    qualificationMode: "authoritative",
    backend: "process_container",
    configuration: {
      artifactStaging: "pinned-archive-read-only-reused",
      declaredHostPreparation: inputs.declaredHostPreparation,
      egressProxy: true,
      networkDefaultPolicy: "block",
      networkPosture: "host-egress-proxy",
      allowGraphicalUi: true,
      allowInputInjection: false,
      clipboard: "none",
      pcCapabilities: ["privateNetworkClientServer"],
      pcAllowLocalNetwork: false,
      pcLeastPrivilege: false,
      shareAtDriveRoot: true,
    },
    identities: {
      host: {
        architecture: host.nativeArchitecture,
        ...hostLaunchContext,
        platform: "win32",
        release: os.release(),
      },
      nemoClawRevision: inputs.expected.nemoClawRevision,
      openClaw: {
        archiveSha256: inputs.expected.openClawArchiveSha256,
        entrySha256: inputs.expected.openClawEntrySha256,
        nodeSha256: inputs.expected.nodeSha256,
        version: inputs.openClaw.version,
      },
      openShell: {
        distributionSha256:
          attachmentReceipt?.distribution.sha256 ?? inputs.expected.openShellDistributionSha256,
        cliSha256: attachmentReceipt?.components.cli.sha256 ?? inputs.expected.openShellCliSha256,
        gatewayConfigSha256: attachmentReceipt?.gateway.configSha256 ?? observedGatewayConfigSha256,
        gatewaySha256:
          attachmentReceipt?.components.gateway.sha256 ?? inputs.expected.openShellGatewaySha256,
        packageVersion: attachmentReceipt?.distribution.version ?? inputs.openShell.packageVersion,
        relaySha256: inputs.expected.openShellRelaySha256,
        revision: attachmentReceipt?.distribution.revision ?? inputs.openShell.revision,
      },
      wxcExecSha256: attachmentReceipt?.components.wxcExec.sha256 ?? inputs.expected.wxcExecSha256,
    },
    checks,
    providerLifecycle: {
      create: providerCreateResult,
      cleanup: providerCleanupResult,
      failures: providerFailureRecords,
    },
    startup,
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
      providerRecoveryAttempted,
      sensitiveRuntimeArtifactsRemoved,
    },
    verdict: lifecyclePassed && cleanupFailures.length === 0 ? "pass" : "fail",
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
    providerRecoveryAttempted,
    receiptPath,
    retainedSandboxName,
  });
}
