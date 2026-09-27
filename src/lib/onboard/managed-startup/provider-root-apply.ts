// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createSdkOpenShellSandboxStateLifecycle,
  type MutateOpenShellSandboxRequest,
  type OpenShellSandboxStateLifecycle,
} from "../../adapters/openshell/sandbox-lifecycle-sdk";

import type {
  RuntimeProviderBundle,
  RuntimeProviderCommandCapture,
  RuntimeProviderPrivilegedSandboxControl,
} from "../runtime-provider/contract";
import type { SandboxEntry } from "../../state/registry/types";
import { MANAGED_STARTUP_RUNTIME_EXECUTABLE } from "./image-runtime";
import {
  type ManagedStartupRootApplyRequest,
  selectManagedStartupApplicationRuntimeEnvironment,
  serializeManagedStartupRootApplyRequest,
} from "./root-apply";

const FULL_CONTAINER_ID_RE = /^[a-f0-9]{64}$/u;
const IMMUTABLE_IMAGE_ID_RE = /^(?:sha256:)?[a-f0-9]{64}$/u;
const ROOT_APPLY_TIMEOUT_MS = 300_000;
const FIXED_ROOT_ENV = [
  "HOME=/root",
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
  "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
] as const;

export interface ProviderManagedStartupTransaction {
  readonly agent: ManagedStartupRootApplyRequest["agent"];
  readonly bootstrapIdentity: string;
  readonly containerId: string;
  readonly image: string;
  readonly protocol: "identity-bound" | "legacy-unbound";
  readonly providerId: "docker" | "podman";
}

type ProviderManagedStartupRuntime = Readonly<{
  bundle: RuntimeProviderBundle;
  control: RuntimeProviderPrivilegedSandboxControl;
  sandbox: SandboxEntry;
  transaction: ProviderManagedStartupTransaction;
}>;

function requireRuntimeProvider(bundle: RuntimeProviderBundle): {
  readonly control: RuntimeProviderPrivilegedSandboxControl;
  readonly capture: (args: readonly string[], timeoutMs?: number) => RuntimeProviderCommandCapture;
} {
  if (
    (bundle.identity.id !== "docker" && bundle.identity.id !== "podman") ||
    bundle.lifecycle.supported !== true ||
    bundle.containerEngine.supported !== true ||
    !bundle.containerEngine.identities.some(({ operation }) => operation === "sandbox-lifecycle")
  ) {
    throw new Error("Managed startup requires a qualified local container runtime provider.");
  }
  return {
    control: bundle.lifecycle.privilegedSandboxControl,
    capture: (args, timeoutMs) =>
      bundle.containerEngine.supported === true
        ? bundle.containerEngine.capture("sandbox-lifecycle", args, timeoutMs)
        : { status: 1, stdout: "", stderr: "runtime provider became unavailable" },
  };
}

function commandDetail(result: {
  readonly stdout?: string | Buffer | null;
  readonly stderr?: string | Buffer | null;
  readonly error?: Error | null;
}): string {
  return `${String(result.stderr ?? "")} ${String(result.stdout ?? "")} ${String(
    result.error?.message ?? "",
  )}`
    .trim()
    .slice(-1200);
}

function inspectExactCreatedRuntime(input: {
  readonly bundle: RuntimeProviderBundle;
  readonly sandboxName: string;
  readonly sandboxId: string;
  readonly expectedContainerId?: string;
}): ProviderManagedStartupRuntime {
  const runtime = requireRuntimeProvider(input.bundle);
  const sandbox: SandboxEntry = {
    name: input.sandboxName,
    openshellDriver: input.bundle.identity.id,
  };
  const target = input.expectedContainerId
    ? { resourceHandle: input.expectedContainerId }
    : runtime.control.resolveTarget({
        registeredSandboxNames: [input.sandboxName],
        sandbox,
        sandboxName: input.sandboxName,
      });
  const inspected = runtime.capture(
    ["inspect", "--type", "container", target.resourceHandle],
    30_000,
  );
  if (inspected.status !== 0 || inspected.error) {
    throw new Error("Could not inspect the exact managed-startup container.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspected.stdout);
  } catch {
    throw new Error("Container runtime returned malformed managed-startup inspect output.");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Container runtime did not resolve exactly one managed-startup container.");
  }
  const row = parsed[0] as {
    Id?: unknown;
    Image?: unknown;
    Config?: { Labels?: Record<string, string> };
    State?: { Running?: boolean; Paused?: boolean; Restarting?: boolean; Dead?: boolean };
  };
  const containerId = String(row.Id ?? "")
    .toLowerCase()
    .replace(/^sha256:/u, "");
  const image = String(row.Image ?? "").toLowerCase();
  const providerId = input.bundle.identity.id as "docker" | "podman";
  const labels = row.Config?.Labels ?? {};
  const managed =
    input.bundle.identity.id === "docker"
      ? labels["openshell.ai/managed-by"] === "openshell"
      : labels["openshell.managed"] === "true";
  if (
    !FULL_CONTAINER_ID_RE.test(containerId) ||
    containerId !== target.resourceHandle.replace(/^sha256:/u, "") ||
    !IMMUTABLE_IMAGE_ID_RE.test(image) ||
    !managed ||
    labels["openshell.ai/sandbox-name"] !== input.sandboxName ||
    labels["openshell.ai/sandbox-id"] !== input.sandboxId ||
    labels["openshell.ai/sandbox-workspace"] !== "default" ||
    row.State?.Running !== true ||
    row.State.Paused === true ||
    row.State.Restarting === true ||
    row.State.Dead === true
  ) {
    throw new Error(
      "OpenShell sandbox identity did not select one exact managed-startup container.",
    );
  }
  return {
    bundle: input.bundle,
    control: runtime.control,
    sandbox,
    transaction: {
      agent: "openclaw",
      bootstrapIdentity: "",
      containerId,
      image,
      protocol: "identity-bound",
      providerId,
    },
  };
}

function executeExact(
  runtime: ProviderManagedStartupRuntime,
  command: readonly string[],
  options: { readonly input?: Buffer; readonly timeoutMs: number },
) {
  return runtime.control.execute({
    registeredSandboxNames: [runtime.sandbox.name],
    sandbox: runtime.sandbox,
    sandboxName: runtime.sandbox.name,
    command,
    ...(options.input ? { input: options.input } : {}),
    expectedResourceHandle: runtime.transaction.containerId,
    sanitizeEnvironment: false,
    timeoutMs: options.timeoutMs,
  });
}

function inspectExactTransactionRuntime(input: {
  readonly runtimeProvider: RuntimeProviderBundle;
  readonly sandboxName: string;
  readonly sandboxId: string;
  readonly transaction: ProviderManagedStartupTransaction;
}): ProviderManagedStartupRuntime {
  const pinned = inspectExactCreatedRuntime({
    bundle: input.runtimeProvider,
    sandboxName: input.sandboxName,
    sandboxId: input.sandboxId,
    expectedContainerId: input.transaction.containerId,
  });
  if (
    pinned.transaction.containerId !== input.transaction.containerId ||
    pinned.transaction.image !== input.transaction.image ||
    pinned.transaction.providerId !== input.transaction.providerId
  ) {
    throw new Error("Managed-startup runtime identity changed before transaction finalization.");
  }
  return { ...pinned, transaction: input.transaction };
}

function sharedStateTransactionCommand(
  action: "commit" | "rollback",
  transaction: ProviderManagedStartupTransaction,
): readonly string[] {
  return [
    "/usr/bin/env",
    "-i",
    ...FIXED_ROOT_ENV,
    "/usr/local/bin/node",
    MANAGED_STARTUP_RUNTIME_EXECUTABLE,
    `--${action}-shared-state-transaction`,
    "--agent",
    transaction.agent,
    ...(transaction.protocol === "identity-bound"
      ? ["--bootstrap-identity", transaction.bootstrapIdentity]
      : []),
  ];
}

function rootApplyCommand(
  agent: ManagedStartupRootApplyRequest["agent"],
  applicationRuntimeEnvironment: readonly string[],
  bootstrapIdentity?: string,
): readonly string[] {
  return [
    "/usr/bin/env",
    "-i",
    ...FIXED_ROOT_ENV,
    ...applicationRuntimeEnvironment,
    "/usr/local/bin/node",
    MANAGED_STARTUP_RUNTIME_EXECUTABLE,
    "--apply-root-stdin",
    "--agent",
    agent,
    ...(bootstrapIdentity ? ["--bootstrap-identity", bootstrapIdentity] : []),
  ];
}

function isLegacyUnboundRuntimeUsage(detail: string): boolean {
  return (
    detail.includes("usage: managed-startup-image-runtime") &&
    !detail.includes("--release-startup-hold")
  );
}

function sharedStateStatusCommand(
  request: ManagedStartupRootApplyRequest,
  transaction: ProviderManagedStartupTransaction,
): readonly string[] {
  return [
    "/usr/bin/env",
    "-i",
    ...FIXED_ROOT_ENV,
    "/usr/local/bin/node",
    MANAGED_STARTUP_RUNTIME_EXECUTABLE,
    "--shared-state-transaction-status",
    "--agent",
    transaction.agent,
    "--profile-fingerprint",
    request.profileFingerprint,
    "--bootstrap-identity",
    transaction.bootstrapIdentity,
  ];
}

export function applyProviderManagedStartupRootRequest(input: {
  readonly runtimeProvider: RuntimeProviderBundle;
  readonly sandboxName: string;
  readonly sandboxId: string;
  readonly bootstrapIdentity: string;
  readonly request: ManagedStartupRootApplyRequest;
  readonly expectedContainerId?: string;
  readonly environment?: NodeJS.ProcessEnv;
}): ProviderManagedStartupTransaction | null {
  if (!/^[a-f0-9]{64}$/u.test(input.bootstrapIdentity)) {
    throw new Error("Managed startup requires one exact bootstrap identity.");
  }
  const pinned = inspectExactCreatedRuntime({
    bundle: input.runtimeProvider,
    sandboxName: input.sandboxName,
    sandboxId: input.sandboxId,
    ...(input.expectedContainerId ? { expectedContainerId: input.expectedContainerId } : {}),
  });
  const runtime: ProviderManagedStartupRuntime = {
    ...pinned,
    transaction: {
      ...pinned.transaction,
      agent: input.request.agent,
      bootstrapIdentity: input.bootstrapIdentity,
      protocol: "identity-bound",
    },
  };
  const applicationRuntimeEnvironment = Object.entries(
    selectManagedStartupApplicationRuntimeEnvironment(input.environment ?? process.env),
  ).map(([name, value]) => `${name}=${value}`);
  const command = rootApplyCommand(
    input.request.agent,
    applicationRuntimeEnvironment,
    input.bootstrapIdentity,
  );
  let lastFailure = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = executeExact(runtime, command, {
      input: Buffer.from(serializeManagedStartupRootApplyRequest(input.request), "utf8"),
      timeoutMs: ROOT_APPLY_TIMEOUT_MS,
    });
    if (result.status === 0) {
      const status = executeExact(
        runtime,
        sharedStateStatusCommand(input.request, runtime.transaction),
        {
          timeoutMs: 30_000,
        },
      );
      const phase = String(status.stdout).trim();
      if (status.status === 0 && (phase === "pending" || phase === "committed")) {
        return runtime.transaction;
      }
      if (status.status === 0 && phase === "absent") return null;
      lastFailure =
        commandDetail(status) || `unexpected transaction status ${JSON.stringify(phase)}`;
      break;
    }
    lastFailure = commandDetail(result);
    if (isLegacyUnboundRuntimeUsage(lastFailure)) {
      const legacyTransaction: ProviderManagedStartupTransaction = {
        ...runtime.transaction,
        protocol: "legacy-unbound",
      };
      const legacyRuntime = { ...runtime, transaction: legacyTransaction };
      const legacyResult = executeExact(
        legacyRuntime,
        rootApplyCommand(input.request.agent, applicationRuntimeEnvironment),
        {
          input: Buffer.from(serializeManagedStartupRootApplyRequest(input.request), "utf8"),
          timeoutMs: ROOT_APPLY_TIMEOUT_MS,
        },
      );
      if (legacyResult.status === 0) return legacyTransaction;
      lastFailure = commandDetail(legacyResult);
      break;
    }
  }
  const error = new Error(
    `Managed startup root application failed in exact ${runtime.transaction.providerId} container ${runtime.transaction.containerId.slice(0, 12)}${
      lastFailure ? `: ${lastFailure}` : ""
    }`,
  );
  (
    error as Error & { managedStartupTransaction?: ProviderManagedStartupTransaction }
  ).managedStartupTransaction = runtime.transaction;
  throw error;
}

export function finalizeProviderManagedStartupSharedState(input: {
  readonly runtimeProvider: RuntimeProviderBundle;
  readonly sandboxName: string;
  readonly sandboxId: string;
  readonly transaction: ProviderManagedStartupTransaction | null;
  readonly supervisorReady: boolean;
}) {
  if (!input.transaction) {
    return { supervisorReady: input.supervisorReady, failure: null };
  }
  const runtime = inspectExactTransactionRuntime({ ...input, transaction: input.transaction });
  if (input.supervisorReady) {
    let commit = executeExact(runtime, sharedStateTransactionCommand("commit", input.transaction), {
      timeoutMs: 30_000,
    });
    if (commit.status !== 0 && commit.error) {
      commit = executeExact(runtime, sharedStateTransactionCommand("commit", input.transaction), {
        timeoutMs: 30_000,
      });
    }
    if (commit.status === 0) return { supervisorReady: true, failure: null };
    const failure = new Error(
      `OpenShell supervisor reconnected, but managed shared-state commit failed: ${commandDetail(commit)}`,
    );
    if (commit.error) {
      throw new Error(
        `${failure.message}. Commit completion is ambiguous; the exact sandbox is retained for recovery.`,
      );
    }
    const rollback = executeExact(
      runtime,
      sharedStateTransactionCommand("rollback", input.transaction),
      { timeoutMs: 30_000 },
    );
    if (rollback.status !== 0 || rollback.error) {
      throw new Error(
        `Managed-startup shared-state commit failed and exact in-sandbox rollback did not complete: ${commandDetail(rollback)}`,
      );
    }
    return { supervisorReady: false, failure };
  }
  const rollback = executeExact(
    runtime,
    sharedStateTransactionCommand("rollback", input.transaction),
    { timeoutMs: 30_000 },
  );
  if (rollback.status !== 0 || rollback.error) {
    throw new Error(`Exact in-sandbox managed-startup rollback failed: ${commandDetail(rollback)}`);
  }
  return { supervisorReady: false, failure: null };
}

export function releaseProviderManagedStartupHold(input: {
  readonly runtimeProvider: RuntimeProviderBundle;
  readonly sandboxName: string;
  readonly sandboxId: string;
  readonly transaction: ProviderManagedStartupTransaction;
  readonly profileFingerprint: string;
}): void {
  if (!/^[a-f0-9]{64}$/u.test(input.profileFingerprint)) {
    throw new Error("Managed startup release requires one exact profile fingerprint.");
  }
  if (input.transaction.protocol === "legacy-unbound") return;
  const runtime = inspectExactTransactionRuntime({
    runtimeProvider: input.runtimeProvider,
    sandboxName: input.sandboxName,
    sandboxId: input.sandboxId,
    transaction: input.transaction,
  });
  const result = executeExact(
    runtime,
    [
      "/usr/bin/env",
      "-i",
      ...FIXED_ROOT_ENV,
      "/usr/local/bin/node",
      MANAGED_STARTUP_RUNTIME_EXECUTABLE,
      "--release-startup-hold",
      "--agent",
      input.transaction.agent,
      "--profile-fingerprint",
      input.profileFingerprint,
      "--bootstrap-identity",
      input.transaction.bootstrapIdentity,
    ],
    { timeoutMs: 30_000 },
  );
  if (result.status !== 0 || result.error) {
    throw new Error(
      `Managed startup hold release failed in exact ${input.transaction.providerId} container ${input.transaction.containerId.slice(0, 12)}${
        commandDetail(result) ? `: ${commandDetail(result)}` : ""
      }`,
    );
  }
}

/** Reload the supervisor's upstream TLS roots after the root apply installs a CA. */
export async function refreshManagedStartupCorporateCaTrust(
  request: MutateOpenShellSandboxRequest,
  lifecycle: OpenShellSandboxStateLifecycle = createSdkOpenShellSandboxStateLifecycle(),
): Promise<void> {
  // OpenShell snapshots its TLS roots before the held managed workload receives
  // its profile. Native stop/start retains that exact container and its CA files.
  for (const action of ["stop", "start"] as const) {
    const result = await lifecycle[`${action}Sandbox`](request);
    if (result.kind === "failed") {
      throw new Error(
        `Could not ${action} sandbox '${request.sandboxName}' to activate corporate CA trust: ${result.error.message}`,
      );
    }
  }
}
