// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import path from "node:path";

import { cloneAndDeepFreeze } from "../../core/immutable";
import type {
  RuntimeProviderNativeArtifactReadinessEvidence,
  RuntimeProviderNativeArtifactRecoveryOutcome,
  RuntimeProviderNativeArtifactVerifyAndCreateOutcome,
} from "./contract";
import type { MxcOpenShellAttachmentReceipt } from "./mxc-openshell-attachment";
import {
  requireIssuedMxcOpenShellCreateRequest,
  type MxcOpenShellCreateRequest,
  type MxcOpenShellRequestScopedOperations,
} from "./mxc-openshell-create-request";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_PATH_BYTES = 4096;
const MAX_OUTPUT_BYTES = 512 * 1024;
const CREATE_TIMEOUT_MS = 5 * 60_000;
const COMMAND_TIMEOUT_MS = 30_000;

const LABEL_PROVIDER = "nemoclaw-provider";
const LABEL_ATTACHMENT = "nemoclaw-attachment-sha256";
const LABEL_AUTHORITY = "nemoclaw-authority-sha256";
const LABEL_POLICY = "nemoclaw-policy-sha256";
const LABEL_REQUEST = "nemoclaw-request-sha256";
const LABEL_LIFECYCLE = "nemoclaw-lifecycle-sha256";

export interface MxcOpenShellLivePolicyBinding {
  readonly path: string;
  readonly sha256: string;
}

export interface MxcOpenShellLiveCommand {
  readonly executablePath: string;
  readonly arguments: readonly string[];
  readonly timeoutMs: number;
}

export interface MxcOpenShellLiveCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type MxcOpenShellLiveFailureOperation =
  | "create"
  | "readiness"
  | "inspect"
  | "list"
  | "delete"
  | "confirm";

export type MxcOpenShellLiveFailureClass =
  | "boundary-error"
  | "identity-drift"
  | "invalid-output"
  | "nonzero-exit"
  | "timeout"
  | "unknown-result";

export interface MxcOpenShellLiveFailureRecord {
  readonly contractVersion: 1;
  readonly providerId: "mxc";
  readonly operation: MxcOpenShellLiveFailureOperation;
  readonly errorClass: MxcOpenShellLiveFailureClass;
  readonly sandboxName: string;
  readonly lifecycleGeneration: string;
  readonly sandboxId?: string;
}

export type MxcOpenShellVerifiedCreateResult =
  | { readonly status: "artifact-verification-failed" }
  | { readonly status: "create-rejected" }
  | { readonly status: "unknown" }
  | {
      readonly status: "completed";
      readonly command: MxcOpenShellLiveCommandResult;
    };

export interface MxcOpenShellLiveHostBoundary {
  /**
   * Verify the exact artifact, executable, CLI, gateway configuration, and policy, then run the
   * create command without releasing or re-resolving those stable filesystem authorities.
   */
  verifyAndRunCreate(input: {
    readonly attachment: MxcOpenShellAttachmentReceipt;
    readonly policy: MxcOpenShellLivePolicyBinding;
    readonly request: MxcOpenShellCreateRequest;
    readonly command: MxcOpenShellLiveCommand;
  }): Promise<MxcOpenShellVerifiedCreateResult>;
  /** Requalify the attachment-owned CLI and gateway configuration before each command. */
  run(input: {
    readonly attachment: MxcOpenShellAttachmentReceipt;
    readonly command: MxcOpenShellLiveCommand;
  }): Promise<MxcOpenShellLiveCommandResult>;
  /**
   * Delete only the still-current sandbox ID bound to the request labels. A name-only
   * list-then-delete implementation does not satisfy this boundary because the name may be reused.
   */
  deleteExact(input: {
    readonly attachment: MxcOpenShellAttachmentReceipt;
    readonly request: MxcOpenShellCreateRequest;
    readonly sandboxId: string;
    readonly command: MxcOpenShellLiveCommand;
  }): Promise<MxcOpenShellLiveCommandResult>;
  /** Record only bounded operation and identity evidence; never command output or environment. */
  recordFailure(record: MxcOpenShellLiveFailureRecord): void;
}

export interface MxcOpenShellLiveOperationsInput {
  readonly attachment: MxcOpenShellAttachmentReceipt;
  readonly gatewayName: string;
  readonly workspace: string;
  readonly policy: MxcOpenShellLivePolicyBinding;
  readonly boundary: MxcOpenShellLiveHostBoundary;
}

export class MxcOpenShellLiveOperationsError extends Error {
  constructor(
    message: string,
    readonly operation?: MxcOpenShellLiveFailureOperation,
    readonly errorClass?: MxcOpenShellLiveFailureClass,
  ) {
    super(`Inactive OpenShell MXC live operation failed: ${message}`);
    this.name = "MxcOpenShellLiveOperationsError";
  }
}

type SandboxRecord = Readonly<{
  id: string;
  labels: Readonly<Record<string, string>>;
  name: string;
  phase: string;
  workspace: string;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireName(value: unknown, label: string): string {
  if (typeof value !== "string" || !NAME_PATTERN.test(value)) {
    throw new MxcOpenShellLiveOperationsError(`${label} is invalid`);
  }
  return value;
}

function canonicalWindowsPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !/^[A-Za-z]:\\/u.test(value) ||
    !path.win32.isAbsolute(value) ||
    path.win32.normalize(value) !== value
  ) {
    throw new MxcOpenShellLiveOperationsError(
      `${label} must be a canonical absolute local-drive Windows path`,
    );
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new MxcOpenShellLiveOperationsError(`${label} is invalid`);
  }
  return value;
}

function labelsFor(
  attachment: MxcOpenShellAttachmentReceipt,
  policy: MxcOpenShellLivePolicyBinding,
  request: MxcOpenShellCreateRequest,
): Readonly<Record<string, string>> {
  return cloneAndDeepFreeze({
    [LABEL_PROVIDER]: "mxc",
    [LABEL_ATTACHMENT]: attachment.authoritySha256,
    [LABEL_AUTHORITY]: request.authoritySha256,
    [LABEL_POLICY]: policy.sha256,
    [LABEL_REQUEST]: request.requestSha256,
    [LABEL_LIFECYCLE]: sha256(request.lifecycleGeneration),
  });
}

function baseArguments(gatewayName: string, workspace: string): string[] {
  return ["--gateway", gatewayName, "--workspace", workspace];
}

function createCommand(
  input: Readonly<{
    attachment: MxcOpenShellAttachmentReceipt;
    gatewayName: string;
    policy: MxcOpenShellLivePolicyBinding;
    request: MxcOpenShellCreateRequest;
    workspace: string;
  }>,
): MxcOpenShellLiveCommand {
  const labels = labelsFor(input.attachment, input.policy, input.request);
  const argumentsList = [
    ...baseArguments(input.gatewayName, input.workspace),
    "sandbox",
    "create",
    "--name",
    input.request.sandboxName,
    "--policy",
    input.policy.path,
    "--driver-config-json",
    input.request.driverConfigJson,
    "--no-tty",
    "--no-auto-providers",
  ];
  for (const [name, value] of Object.entries(labels)) {
    argumentsList.push("--label", `${name}=${value}`);
  }
  for (const [name, value] of Object.entries(input.request.environment)) {
    argumentsList.push("--env", `${name}=${value}`);
  }
  argumentsList.push("--output", "json");
  return cloneAndDeepFreeze({
    executablePath: input.attachment.components.cli.path,
    arguments: argumentsList,
    timeoutMs: CREATE_TIMEOUT_MS,
  });
}

function inspectCommand(
  attachment: MxcOpenShellAttachmentReceipt,
  gatewayName: string,
  workspace: string,
  sandboxName: string,
): MxcOpenShellLiveCommand {
  return cloneAndDeepFreeze({
    executablePath: attachment.components.cli.path,
    arguments: [
      ...baseArguments(gatewayName, workspace),
      "sandbox",
      "get",
      sandboxName,
      "--output",
      "json",
    ],
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

function listCommand(
  attachment: MxcOpenShellAttachmentReceipt,
  gatewayName: string,
  workspace: string,
  request: MxcOpenShellCreateRequest,
): MxcOpenShellLiveCommand {
  return cloneAndDeepFreeze({
    executablePath: attachment.components.cli.path,
    arguments: [
      ...baseArguments(gatewayName, workspace),
      "sandbox",
      "list",
      "--limit",
      "2",
      "--selector",
      `${LABEL_REQUEST}=${request.requestSha256}`,
      "--output",
      "json",
    ],
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

function deleteCommand(
  attachment: MxcOpenShellAttachmentReceipt,
  gatewayName: string,
  workspace: string,
  sandboxName: string,
): MxcOpenShellLiveCommand {
  return cloneAndDeepFreeze({
    executablePath: attachment.components.cli.path,
    arguments: [...baseArguments(gatewayName, workspace), "sandbox", "delete", sandboxName],
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}

function parseJson(
  result: MxcOpenShellLiveCommandResult,
  label: string,
  operation: MxcOpenShellLiveFailureOperation,
): unknown {
  if (result.status === null) {
    throw new MxcOpenShellLiveOperationsError(`${label} timed out`, operation, "timeout");
  }
  if (result.status !== 0) {
    throw new MxcOpenShellLiveOperationsError(
      `${label} returned a nonzero status`,
      operation,
      "nonzero-exit",
    );
  }
  if (
    Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT_BYTES ||
    Buffer.byteLength(result.stderr, "utf8") > MAX_OUTPUT_BYTES
  ) {
    throw new MxcOpenShellLiveOperationsError(
      `${label} output is invalid`,
      operation,
      "invalid-output",
    );
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    throw new MxcOpenShellLiveOperationsError(
      `${label} returned invalid JSON`,
      operation,
      "invalid-output",
    );
  }
}

function record(
  value: unknown,
  label: string,
  operation: MxcOpenShellLiveFailureOperation,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MxcOpenShellLiveOperationsError(`${label} is invalid`, operation, "invalid-output");
  }
  return value as Record<string, unknown>;
}

function sandboxRecord(
  value: unknown,
  label: string,
  operation: MxcOpenShellLiveFailureOperation,
): SandboxRecord {
  const input = record(value, label, operation);
  const labels = record(input.labels, `${label} labels`, operation);
  const parsedLabels: Record<string, string> = {};
  for (const [name, entry] of Object.entries(labels)) {
    if (typeof entry !== "string") {
      throw new MxcOpenShellLiveOperationsError(
        `${label} labels are invalid`,
        operation,
        "invalid-output",
      );
    }
    parsedLabels[name] = entry;
  }
  if (
    typeof input.id !== "string" ||
    input.id.length === 0 ||
    typeof input.name !== "string" ||
    typeof input.phase !== "string" ||
    typeof input.workspace !== "string"
  ) {
    throw new MxcOpenShellLiveOperationsError(
      `${label} identity is invalid`,
      operation,
      "invalid-output",
    );
  }
  return cloneAndDeepFreeze({
    id: input.id,
    labels: parsedLabels,
    name: input.name,
    phase: input.phase,
    workspace: input.workspace,
  });
}

function requireRequestIdentity(
  sandbox: SandboxRecord,
  attachment: MxcOpenShellAttachmentReceipt,
  policy: MxcOpenShellLivePolicyBinding,
  request: MxcOpenShellCreateRequest,
  workspace: string,
  operation: MxcOpenShellLiveFailureOperation,
): void {
  if (sandbox.name !== request.sandboxName || sandbox.workspace !== workspace) {
    throw new MxcOpenShellLiveOperationsError(
      "sandbox name or workspace identity drifted",
      operation,
      "identity-drift",
    );
  }
  for (const [name, value] of Object.entries(labelsFor(attachment, policy, request))) {
    if (sandbox.labels[name] !== value) {
      throw new MxcOpenShellLiveOperationsError(
        "sandbox lifecycle authority drifted",
        operation,
        "identity-drift",
      );
    }
  }
}

function createdOutcome(
  request: MxcOpenShellCreateRequest,
): Extract<RuntimeProviderNativeArtifactVerifyAndCreateOutcome, { status: "created" }> {
  return cloneAndDeepFreeze({
    status: "created",
    authoritySha256: request.authoritySha256,
    providerHandle: request.providerHandle,
    sandboxName: request.sandboxName,
    lifecycleGeneration: request.lifecycleGeneration,
    artifactDigest: request.workload.artifactDigest,
    executableDigest: request.workload.executableDigest,
  });
}

function readinessEvidence(
  request: MxcOpenShellCreateRequest,
  ready: boolean,
): RuntimeProviderNativeArtifactReadinessEvidence {
  return cloneAndDeepFreeze({
    authoritySha256: request.authoritySha256,
    providerHandle: request.providerHandle,
    sandboxName: request.sandboxName,
    lifecycleGeneration: request.lifecycleGeneration,
    artifactDigest: request.workload.artifactDigest,
    executableDigest: request.workload.executableDigest,
    ready,
  });
}

function retainedOutcome(
  request: MxcOpenShellCreateRequest,
): Extract<RuntimeProviderNativeArtifactRecoveryOutcome, { status: "removed" | "retained" }> {
  return cloneAndDeepFreeze({
    status: "retained",
    authoritySha256: request.authoritySha256,
    providerHandle: request.providerHandle,
    sandboxName: request.sandboxName,
    lifecycleGeneration: request.lifecycleGeneration,
  });
}

function reportFailure(
  recordFailure: (record: MxcOpenShellLiveFailureRecord) => void,
  request: MxcOpenShellCreateRequest,
  operation: MxcOpenShellLiveFailureOperation,
  error: unknown,
  sandboxId?: string,
): void {
  const recordedOperation =
    error instanceof MxcOpenShellLiveOperationsError && error.operation
      ? error.operation
      : operation;
  const errorClass =
    error instanceof MxcOpenShellLiveOperationsError && error.errorClass
      ? error.errorClass
      : "boundary-error";
  try {
    recordFailure(
      cloneAndDeepFreeze({
        contractVersion: 1,
        providerId: "mxc",
        operation: recordedOperation,
        errorClass,
        sandboxName: request.sandboxName,
        lifecycleGeneration: request.lifecycleGeneration,
        ...(sandboxId === undefined ? {} : { sandboxId }),
      }),
    );
  } catch {
    // Diagnostics must not replace the conservative lifecycle outcome.
  }
}

async function runHostCommand(
  run: MxcOpenShellLiveHostBoundary["run"],
  input: Parameters<MxcOpenShellLiveHostBoundary["run"]>[0],
  operation: MxcOpenShellLiveFailureOperation,
): Promise<MxcOpenShellLiveCommandResult> {
  try {
    return await run(input);
  } catch {
    throw new MxcOpenShellLiveOperationsError(
      "trusted host command failed",
      operation,
      "boundary-error",
    );
  }
}

/**
 * Adapt one qualified installation and trusted Windows host boundary to request-scoped OpenShell
 * operations. This remains dormant: it neither registers MXC nor supplies an accepted package,
 * gateway, policy, or artifact authority.
 */
export function createMxcOpenShellLiveOperations(
  value: MxcOpenShellLiveOperationsInput,
): MxcOpenShellRequestScopedOperations {
  const gatewayName = requireName(value.gatewayName, "gateway name");
  const workspace = requireName(value.workspace, "workspace");
  const policy = cloneAndDeepFreeze({
    path: canonicalWindowsPath(value.policy?.path, "policy path"),
    sha256: requireSha256(value.policy?.sha256, "policy digest"),
  });
  if (
    typeof value.boundary?.verifyAndRunCreate !== "function" ||
    typeof value.boundary.run !== "function" ||
    typeof value.boundary.deleteExact !== "function" ||
    typeof value.boundary.recordFailure !== "function"
  ) {
    throw new MxcOpenShellLiveOperationsError("a trusted live host boundary is required");
  }
  const attachment = cloneAndDeepFreeze(value.attachment);
  const verifyAndRunCreate = value.boundary.verifyAndRunCreate.bind(value.boundary);
  const run = value.boundary.run.bind(value.boundary);
  const deleteExact = value.boundary.deleteExact.bind(value.boundary);
  const recordFailure = value.boundary.recordFailure.bind(value.boundary);

  const operations: MxcOpenShellRequestScopedOperations = {
    verifyAndCreate: async (
      request: MxcOpenShellCreateRequest,
    ): Promise<RuntimeProviderNativeArtifactVerifyAndCreateOutcome> => {
      requireIssuedMxcOpenShellCreateRequest(request);
      try {
        const result = await verifyAndRunCreate({
          attachment,
          policy,
          request,
          command: createCommand({ attachment, gatewayName, policy, request, workspace }),
        });
        if (result.status === "artifact-verification-failed") {
          return { status: "not-created", reason: "artifact-verification-failed" } as const;
        }
        if (result.status === "create-rejected") {
          return { status: "not-created", reason: "create-rejected" } as const;
        }
        if (result.status === "unknown") {
          reportFailure(
            recordFailure,
            request,
            "create",
            new MxcOpenShellLiveOperationsError(
              "sandbox creation result is unknown",
              "create",
              "unknown-result",
            ),
          );
          return { status: "unknown" } as const;
        }
        if (result.command.status !== 0) {
          reportFailure(
            recordFailure,
            request,
            "create",
            new MxcOpenShellLiveOperationsError(
              "sandbox creation did not complete",
              "create",
              result.command.status === null ? "timeout" : "nonzero-exit",
            ),
          );
          return { status: "unknown" } as const;
        }
        const sandbox = sandboxRecord(
          parseJson(result.command, "sandbox creation", "create"),
          "sandbox",
          "create",
        );
        requireRequestIdentity(sandbox, attachment, policy, request, workspace, "create");
        return createdOutcome(request);
      } catch (error) {
        reportFailure(recordFailure, request, "create", error);
        return { status: "unknown" } as const;
      }
    },
    verifyReadiness: async (request: MxcOpenShellCreateRequest) => {
      requireIssuedMxcOpenShellCreateRequest(request);
      try {
        const result = await runHostCommand(
          run,
          {
            attachment,
            command: inspectCommand(attachment, gatewayName, workspace, request.sandboxName),
          },
          "readiness",
        );
        const sandbox = sandboxRecord(
          parseJson(result, "sandbox readiness", "readiness"),
          "sandbox",
          "readiness",
        );
        requireRequestIdentity(sandbox, attachment, policy, request, workspace, "readiness");
        return readinessEvidence(request, sandbox.phase === "Ready");
      } catch (error) {
        reportFailure(recordFailure, request, "readiness", error);
        throw error;
      }
    },
    recoverCreate: async (
      request: MxcOpenShellCreateRequest,
    ): Promise<RuntimeProviderNativeArtifactRecoveryOutcome> => {
      requireIssuedMxcOpenShellCreateRequest(request);
      let candidate: SandboxRecord | undefined;
      try {
        const inspected = await runHostCommand(
          run,
          {
            attachment,
            command: inspectCommand(attachment, gatewayName, workspace, request.sandboxName),
          },
          "inspect",
        );
        if (inspected.status === 0) {
          candidate = sandboxRecord(
            parseJson(inspected, "sandbox recovery inspection", "inspect"),
            "sandbox",
            "inspect",
          );
        } else {
          const before = await runHostCommand(
            run,
            {
              attachment,
              command: listCommand(attachment, gatewayName, workspace, request),
            },
            "list",
          );
          const listed = parseJson(before, "sandbox recovery listing", "list");
          if (!Array.isArray(listed)) {
            throw new MxcOpenShellLiveOperationsError(
              "sandbox recovery listing is invalid",
              "list",
              "invalid-output",
            );
          }
          const matches = listed.map((entry, index) =>
            sandboxRecord(entry, `sandbox recovery item ${index}`, "list"),
          );
          if (matches.length === 0) return { status: "absent" };
          if (matches.length !== 1) {
            throw new MxcOpenShellLiveOperationsError(
              "sandbox recovery identity is ambiguous",
              "list",
              "identity-drift",
            );
          }
          candidate = matches[0]!;
        }
        try {
          requireRequestIdentity(candidate, attachment, policy, request, workspace, "inspect");
        } catch (error) {
          reportFailure(recordFailure, request, "inspect", error, candidate.id);
          return retainedOutcome(request);
        }
        let removed: MxcOpenShellLiveCommandResult;
        try {
          removed = await deleteExact({
            attachment,
            request,
            sandboxId: candidate.id,
            command: deleteCommand(attachment, gatewayName, workspace, request.sandboxName),
          });
        } catch {
          const error = new MxcOpenShellLiveOperationsError(
            "exact sandbox deletion failed",
            "delete",
            "boundary-error",
          );
          reportFailure(recordFailure, request, "delete", error, candidate.id);
          return retainedOutcome(request);
        }
        if (removed.status !== 0) {
          const error = new MxcOpenShellLiveOperationsError(
            "exact sandbox deletion did not complete",
            "delete",
            removed.status === null ? "timeout" : "nonzero-exit",
          );
          reportFailure(recordFailure, request, "delete", error, candidate.id);
          return retainedOutcome(request);
        }
        const after = await runHostCommand(
          run,
          {
            attachment,
            command: listCommand(attachment, gatewayName, workspace, request),
          },
          "confirm",
        );
        const relisted = parseJson(after, "sandbox recovery confirmation", "confirm");
        if (!Array.isArray(relisted)) {
          throw new MxcOpenShellLiveOperationsError(
            "sandbox recovery confirmation is invalid",
            "confirm",
            "invalid-output",
          );
        }
        if (relisted.length !== 0) {
          const error = new MxcOpenShellLiveOperationsError(
            "sandbox recovery confirmation found retained resources",
            "confirm",
            "unknown-result",
          );
          reportFailure(recordFailure, request, "confirm", error, candidate.id);
          return retainedOutcome(request);
        }
        return cloneAndDeepFreeze({
          status: "removed",
          authoritySha256: request.authoritySha256,
          providerHandle: request.providerHandle,
          sandboxName: request.sandboxName,
          lifecycleGeneration: request.lifecycleGeneration,
        });
      } catch (error) {
        reportFailure(recordFailure, request, "inspect", error, candidate?.id);
        throw error;
      }
    },
  };
  return Object.freeze(operations);
}
