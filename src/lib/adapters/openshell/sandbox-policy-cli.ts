// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";

import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import {
  buildOpenShellSandboxPolicyInspectionArgs,
  buildOpenShellSandboxPolicyReadArgs,
  buildOpenShellSandboxPolicyRevisionReadArgs,
  parseOpenShellPolicy,
  parseSandboxPolicyMetadata,
  type OpenShellPolicyInspection,
} from "./policy-boundary";
import { isValidName } from "../../sandbox-name-contract";
import { stripCredentials } from "../../security/credential-filter";
import { stripAnsi } from "./client";
import { openshellNotFoundDiagnosticLines, tryResolveOpenshellBinary } from "./command-argv";
import { captureSanitizedResolvedOpenshell } from "./runtime";
import type { OpenShellSandboxResult } from "./sandbox-observer";
import {
  classifyCliOpenShellCommandError,
  type CapturedOpenShellCommandResult,
  type CaptureOpenShellCommand,
} from "./sandbox-observer-cli";
import type {
  InspectOpenShellSandboxPolicyRequest,
  OpenShellSandboxPolicyRead,
  OpenShellSandboxPolicyReader,
  OpenShellSandboxPolicyRevisionRead,
  OpenShellSandboxPolicySetOutcome,
  OpenShellSandboxPolicySetSubmission,
  OpenShellSandboxPolicyWriter,
  ReadOpenShellSandboxPolicyRequest,
  ReadOpenShellSandboxPolicyRevisionRequest,
  SetOpenShellSandboxPolicyRequest,
  SyncOpenShellSandboxPolicyReader,
  SyncOpenShellSandboxPolicyWriter,
} from "./sandbox-policy";

export { namedOpenShellGateway, selectedOpenShellGateway } from "./sandbox-observer";
export type { OpenShellSandboxError, OpenShellSandboxResult } from "./sandbox-observer";
export type {
  OpenShellSandboxPolicyReader,
  OpenShellSandboxPolicySetOutcome,
  OpenShellSandboxPolicySetSubmission,
  OpenShellSandboxPolicyWriter,
} from "./sandbox-policy";

export { openshellNotFoundDiagnosticLines, tryResolveOpenshellBinary };

type SyncCapturePolicyCommand = (
  args: string[],
  options: Parameters<CaptureOpenShellCommand>[1] & { readonly maxBuffer: number },
) => CapturedOpenShellCommandResult;
type CapturePolicyCommand = (
  args: string[],
  options: Parameters<SyncCapturePolicyCommand>[1],
) => CapturedOpenShellCommandResult | Promise<CapturedOpenShellCommandResult>;
type PolicyReaderDeps<Capture> = Readonly<{ capture: Capture; defaultTimeoutMs?: number }>;
type PolicyWriterDeps<Capture> = Readonly<{ capture: Capture; defaultTimeoutMs?: number }>;
type CapturedPolicySetCommandResult = Readonly<{
  status: number | null;
  stderr?: string | null;
  error?: { readonly message?: string } | null;
}>;

export type CliOpenShellSandboxPolicyReadResult = Readonly<{
  result: OpenShellSandboxResult<OpenShellSandboxPolicyRead>;
  displayOutput: string;
}>;
export type CliOpenShellSandboxPolicyRead = (
  request: ReadOpenShellSandboxPolicyRequest,
) => Promise<CliOpenShellSandboxPolicyReadResult>;

const DEFAULT_POLICY_READ_TIMEOUT_MS = 15_000;
const POLICY_READ_MAX_BYTES = 1024 * 1024;
const POLICY_READ_ERROR_MESSAGES = {
  authentication: "OpenShell could not authenticate the sandbox policy read.",
  command: "The OpenShell sandbox policy read failed.",
  schema: "The OpenShell CLI and gateway policy schemas do not match.",
  timeout: "The OpenShell sandbox policy read timed out.",
  unavailable: () => openshellNotFoundDiagnosticLines().join("\n"),
} as const;

// These markers identify the torn-stream failure observed in #8991. OpenShell
// renders transport and semantic failures with the same code/message shape, so
// transport evidence must win before a diagnostic can be treated as final.
const TRANSPORT_FAILURE_MARKERS: ReadonlyArray<string> = [
  "h2 protocol error",
  "http2 error",
  "tonic::transport::error",
];
// Accept a final refusal only when the complete first diagnostic line carries
// one FailedPrecondition frame. Later output can quote operator-supplied policy
// text and therefore cannot provide authoritative status evidence.
const AUTHORITATIVE_REFUSAL_PATTERN =
  /^Error:\s+code:\s*'failed[ _]precondition',\s*message:\s*'([^'\r\n]+)'(?:,\s*source:\s*tonic::Status\s*\{\s*code:\s*FailedPrecondition,\s*grpc_status:\s*9\s*\})?\s*$/iu;

function metadataSection(output: string): string {
  const separator = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/u.exec(output);
  return separator ? output.slice(0, separator.index) : "";
}

function safePolicyMetadataLine(input: string): string | null {
  const line = input.trimEnd();
  const revision = /^(Version|Active):\s*(\d+)$/u.exec(line);
  if (revision) return Number.isSafeInteger(Number(revision[2])) ? line : null;
  return /^(?:Hash:\s*sha256:[0-9a-f]{64}|Status:\s*(?:active|inactive)|(?:Created|Loaded|Updated):\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/iu.test(
    line,
  )
    ? line
    : null;
}

export function redactOpenShellSandboxPolicyDocumentForDisplay(document: string): string | null {
  try {
    return YAML.stringify(stripCredentials(parseOpenShellPolicy(document).policy)).trim();
  } catch {
    return null;
  }
}

export function redactOpenShellSandboxPolicyReadForDisplay(input: {
  readonly displayOutput: string;
  readonly document: string;
}): { readonly raw: string; readonly yaml: string } | null {
  const yaml = redactOpenShellSandboxPolicyDocumentForDisplay(input.document);
  if (yaml === null) return null;
  const metadata = metadataSection(stripAnsi(input.displayOutput))
    .split(/\r?\n/u)
    .map(safePolicyMetadataLine)
    .filter((line): line is string => line !== null)
    .join("\n");
  return { raw: metadata ? `${metadata}\n---\n${yaml}` : yaml, yaml };
}

function assertPolicyRequest(request: {
  readonly sandboxName: string;
  readonly target: ReadOpenShellSandboxPolicyRequest["target"];
}): void {
  if (!isValidName(request.sandboxName)) throw new Error("Invalid OpenShell sandbox name");
  if (request.target.kind !== "named") return;
  if (!isValidName(request.target.gatewayName)) throw new Error("Invalid OpenShell gateway name");
  assertNoOpenShellGatewayEndpointOverride();
}

function gatewayRequest(request: {
  readonly sandboxName: string;
  readonly target: ReadOpenShellSandboxPolicyRequest["target"];
}) {
  assertPolicyRequest(request);
  return {
    sandboxName: request.sandboxName,
    ...(request.target.kind === "named" ? { gatewayName: request.target.gatewayName } : {}),
  };
}

function policySetArgs(request: SetOpenShellSandboxPolicyRequest): string[] {
  const target = gatewayRequest(request);
  return [
    "policy",
    "set",
    ...(target.gatewayName ? ["-g", target.gatewayName] : []),
    "--policy",
    request.policyPath,
    "--wait",
    target.sandboxName,
  ];
}

const policyReadArgs = (request: ReadOpenShellSandboxPolicyRequest) =>
  buildOpenShellSandboxPolicyReadArgs({ ...gatewayRequest(request), scope: request.scope });
const policyInspectionArgs = (request: InspectOpenShellSandboxPolicyRequest) =>
  buildOpenShellSandboxPolicyInspectionArgs(gatewayRequest(request));
const policyRevisionArgs = (request: ReadOpenShellSandboxPolicyRevisionRequest) =>
  buildOpenShellSandboxPolicyRevisionReadArgs({
    ...gatewayRequest(request),
    revision: request.revision,
  });

function captureOptions(timeoutMs?: number, defaultTimeoutMs?: number) {
  return {
    ignoreError: true,
    includeStderr: true,
    includeStreams: true,
    maxBuffer: POLICY_READ_MAX_BYTES,
    timeout: timeoutMs ?? defaultTimeoutMs ?? DEFAULT_POLICY_READ_TIMEOUT_MS,
  } as const;
}

function capturedOutput(captured: CapturedOpenShellCommandResult): string {
  return (captured.stdout ?? captured.output ?? "").trim();
}

function policySetDetail(captured: CapturedPolicySetCommandResult): string {
  return [captured.error?.message, captured.stderr]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join("\n");
}

function authoritativeRefusalMessage(stderr: string | null | undefined): string | null {
  const firstLine = stderr?.split("\n", 1)[0] ?? "";
  const matched = firstLine.match(AUTHORITATIVE_REFUSAL_PATTERN)?.[1]?.trim();
  return matched ? matched : null;
}

export function classifyCliOpenShellSandboxPolicySetResult(
  captured: CapturedPolicySetCommandResult,
): OpenShellSandboxPolicySetOutcome {
  const detail = policySetDetail(captured);
  const ambiguous = (): OpenShellSandboxPolicySetOutcome => ({
    kind: "ambiguous",
    detail: detail || `openshell policy set exited with status ${String(captured.status)}`,
  });
  const normalizedDetail = detail.toLowerCase();
  if (TRANSPORT_FAILURE_MARKERS.some((marker) => normalizedDetail.includes(marker))) {
    return ambiguous();
  }
  // A clean exit alongside a spawn-level error is not proof of application.
  if (captured.status === 0) return captured.error ? ambiguous() : { kind: "applied" };
  // spawnSync uses null when the command may not have started or its result was
  // lost, so only readback can resolve the resulting policy state.
  if (captured.status === null) return ambiguous();
  const message = authoritativeRefusalMessage(captured.stderr);
  return message === null ? ambiguous() : { kind: "rejected", status: captured.status, message };
}

function parsePolicySet(
  captured: CapturedOpenShellCommandResult,
): OpenShellSandboxPolicySetSubmission {
  return {
    outcome: classifyCliOpenShellSandboxPolicySetResult(captured),
    status: captured.status,
  };
}

function parseCaptured<T>(
  captured: CapturedOpenShellCommandResult,
  invalidMessage: string,
  parse: (output: string) => T,
): OpenShellSandboxResult<T> {
  const commandFailure = classifyCliOpenShellCommandError(captured, POLICY_READ_ERROR_MESSAGES);
  if (commandFailure) return { ok: false, error: commandFailure };
  try {
    return { ok: true, value: parse(capturedOutput(captured)) };
  } catch {
    return { ok: false, error: { kind: "schema", message: invalidMessage } };
  }
}

function parsePolicyRead(captured: CapturedOpenShellCommandResult) {
  return parseCaptured(
    captured,
    "OpenShell returned an invalid sandbox policy document.",
    (output) => {
      const normalized = stripAnsi(output);
      const parsed = parseOpenShellPolicy(normalized);
      const rawRevision = metadataSection(normalized).match(/^Active:\s*(\d+)\s*$/imu)?.[1];
      const revision = rawRevision ? Number.parseInt(rawRevision, 10) : null;
      return {
        document: parsed.yamlBody,
        appliedRevision: revision !== null && Number.isSafeInteger(revision) ? revision : null,
      };
    },
  );
}

function parsePolicyInspection(
  request: InspectOpenShellSandboxPolicyRequest,
  captured: CapturedOpenShellCommandResult,
): OpenShellSandboxResult<OpenShellPolicyInspection> {
  return parseCaptured(captured, "OpenShell returned invalid sandbox policy metadata.", (output) =>
    parseSandboxPolicyMetadata(stripAnsi(output), request.sandboxName),
  );
}

function parsePolicyRevision(
  request: ReadOpenShellSandboxPolicyRevisionRequest,
  captured: CapturedOpenShellCommandResult,
): OpenShellSandboxResult<OpenShellSandboxPolicyRevisionRead> {
  if (!Number.isSafeInteger(request.revision) || request.revision < 1) {
    return {
      ok: false,
      error: {
        kind: "command",
        reason: "invalid_request",
        message: "The requested OpenShell sandbox policy revision is invalid.",
      },
    };
  }
  return parseCaptured(
    captured,
    "OpenShell returned an invalid sandbox policy revision document.",
    (output) => ({
      document: parseOpenShellPolicy(stripAnsi(output)).yamlBody,
      revision: request.revision,
    }),
  );
}

export function createCliOpenShellSandboxPolicyRead(
  deps: PolicyReaderDeps<CapturePolicyCommand>,
): CliOpenShellSandboxPolicyRead {
  return async (request) => {
    const captured = await deps.capture(
      policyReadArgs(request),
      captureOptions(request.timeoutMs, deps.defaultTimeoutMs),
    );
    const result = parsePolicyRead(captured);
    return {
      result,
      displayOutput: result.ok ? capturedOutput(captured) : "",
    };
  };
}

export function createCliOpenShellSandboxPolicyReader(
  deps: PolicyReaderDeps<CapturePolicyCommand>,
): OpenShellSandboxPolicyReader {
  const read = createCliOpenShellSandboxPolicyRead(deps);
  return {
    readSandboxPolicy: async (request) => (await read(request)).result,
    inspectSandboxPolicy: async (request) =>
      parsePolicyInspection(
        request,
        await deps.capture(
          policyInspectionArgs(request),
          captureOptions(request.timeoutMs, deps.defaultTimeoutMs),
        ),
      ),
    readSandboxPolicyRevision: async (request) =>
      !Number.isSafeInteger(request.revision) || request.revision < 1
        ? parsePolicyRevision(request, { status: 0, output: "" })
        : parsePolicyRevision(
            request,
            await deps.capture(
              policyRevisionArgs(request),
              captureOptions(request.timeoutMs, deps.defaultTimeoutMs),
            ),
          ),
  };
}

export function createSyncCliOpenShellSandboxPolicyReader(
  deps: PolicyReaderDeps<SyncCapturePolicyCommand>,
): SyncOpenShellSandboxPolicyReader {
  return {
    readSandboxPolicy: (request) =>
      parsePolicyRead(
        deps.capture(
          policyReadArgs(request),
          captureOptions(request.timeoutMs, deps.defaultTimeoutMs),
        ),
      ),
    inspectSandboxPolicy: (request) =>
      parsePolicyInspection(
        request,
        deps.capture(
          policyInspectionArgs(request),
          captureOptions(request.timeoutMs, deps.defaultTimeoutMs),
        ),
      ),
    readSandboxPolicyRevision: (request) =>
      !Number.isSafeInteger(request.revision) || request.revision < 1
        ? parsePolicyRevision(request, { status: 0, output: "" })
        : parsePolicyRevision(
            request,
            deps.capture(
              policyRevisionArgs(request),
              captureOptions(request.timeoutMs, deps.defaultTimeoutMs),
            ),
          ),
  };
}

export function createCliOpenShellSandboxPolicyWriter(
  deps: PolicyWriterDeps<CapturePolicyCommand>,
): OpenShellSandboxPolicyWriter {
  return {
    setSandboxPolicy: async (request) => {
      assertPolicyRequest(request);
      return parsePolicySet(
        await deps.capture(
          policySetArgs(request),
          captureOptions(request.timeoutMs, deps.defaultTimeoutMs),
        ),
      );
    },
  };
}

export function createSyncCliOpenShellSandboxPolicyWriter(
  deps: PolicyWriterDeps<SyncCapturePolicyCommand>,
): SyncOpenShellSandboxPolicyWriter {
  return {
    setSandboxPolicy: (request) => {
      assertPolicyRequest(request);
      return parsePolicySet(
        deps.capture(
          policySetArgs(request),
          captureOptions(request.timeoutMs, deps.defaultTimeoutMs),
        ),
      );
    },
  };
}

export const readCliOpenShellSandboxPolicy = createCliOpenShellSandboxPolicyRead({
  capture: captureSanitizedResolvedOpenshell,
});
export const syncCliOpenShellSandboxPolicyReader = createSyncCliOpenShellSandboxPolicyReader({
  capture: captureSanitizedResolvedOpenshell,
});
export const syncCliOpenShellSandboxPolicyWriter = createSyncCliOpenShellSandboxPolicyWriter({
  capture: captureSanitizedResolvedOpenshell,
});
