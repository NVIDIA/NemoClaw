// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import {
  buildOpenShellSandboxPolicySetArgs,
  buildOpenShellSandboxPolicyInspectionArgs,
  buildOpenShellSandboxPolicyReadArgs,
  buildOpenShellSandboxPolicyRevisionReadArgs,
  classifyOpenShellSandboxPolicySetResult,
  parseOpenShellPolicy,
  parseOpenShellSandboxPolicyRead,
  parseSandboxPolicyMetadata,
  type OpenShellPolicyInspection,
} from "./policy-boundary";
import { isValidName } from "../../sandbox-name-contract";
import { stripCredentials, redactCredentialText } from "../../security/credential-filter";
import { stripAnsi } from "./client";
import {
  openshellNotFoundDiagnosticLines,
  tryResolveOpenshellBinary,
  withSelectedOpenShellCommandOptions,
} from "./command-argv";
import { captureSanitizedResolvedOpenshellAsync } from "./sanitized-capture";
import type { OpenShellSandboxResult } from "./sandbox-observer";
import {
  classifyCliOpenShellCommandError,
  type CapturedOpenShellCommandResult,
  type CaptureOpenShellCommand,
} from "./sandbox-observer-cli";
import type {
  SyncOpenShellSandboxPolicyReader,
  InspectOpenShellSandboxPolicyRequest,
  OpenShellSandboxPolicyRead,
  OpenShellSandboxPolicyReader,
  OpenShellSandboxPolicyRevisionRead,
  OpenShellSandboxPolicySetSubmission,
  OpenShellSandboxPolicyWriter,
  ReadOpenShellSandboxPolicyRequest,
  ReadOpenShellSandboxPolicyRevisionRequest,
  SetOpenShellSandboxPolicyRequest,
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

type CapturePolicyOptions = Omit<Parameters<CaptureOpenShellCommand>[1], "maxBuffer"> & {
  readonly outputLimitBytes: number;
};
type SyncCapturePolicyCommand = (
  args: string[],
  options: Parameters<CaptureOpenShellCommand>[1] & { readonly maxBuffer: number },
) => CapturedOpenShellCommandResult;
type CapturePolicyCommand = (
  args: string[],
  options: CapturePolicyOptions,
) => CapturedOpenShellCommandResult | Promise<CapturedOpenShellCommandResult>;
type PolicyReaderDeps<Capture> = Readonly<{ capture: Capture; defaultTimeoutMs?: number }>;
type PolicyWriterDeps<Capture> = Readonly<{ capture: Capture; defaultTimeoutMs?: number }>;

const DEFAULT_POLICY_READ_TIMEOUT_MS = 15_000;
const POLICY_READ_MAX_BYTES = 1024 * 1024;
const POLICY_READ_ERROR_MESSAGES = {
  authentication: "OpenShell could not authenticate the sandbox policy read.",
  command: "The OpenShell sandbox policy read failed.",
  schema: "The OpenShell CLI and gateway policy schemas do not match.",
  timeout: "The OpenShell sandbox policy read timed out.",
  unavailable: () => openshellNotFoundDiagnosticLines().join("\n"),
} as const;

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

function parsePolicyMetadata(output: string): NonNullable<OpenShellSandboxPolicyRead["metadata"]> {
  return metadataSection(stripAnsi(output))
    .split(/\r?\n/u)
    .flatMap((input) => {
      const line = safePolicyMetadataLine(input);
      if (line === null) return [];
      const separator = line.indexOf(":");
      const field = line.slice(0, separator) as NonNullable<
        OpenShellSandboxPolicyRead["metadata"]
      >[number]["field"];
      return [{ field, value: line.slice(separator + 1).trim() }];
    });
}

function assertPolicyRequest(request: {
  readonly sandboxName: string;
  readonly runtimeSelection?: ReadOpenShellSandboxPolicyRequest["runtimeSelection"];
  readonly target: ReadOpenShellSandboxPolicyRequest["target"];
}): void {
  if (!isValidName(request.sandboxName)) throw new Error("Invalid OpenShell sandbox name");
  if (request.target.kind !== "named") return;
  if (!isValidName(request.target.gatewayName)) throw new Error("Invalid OpenShell gateway name");
  if (request.runtimeSelection) {
    if (request.runtimeSelection.gatewayName !== request.target.gatewayName) {
      throw new Error("OpenShell runtime selection does not match the sandbox policy target");
    }
    return;
  }
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

function policySetArgs(request: SetOpenShellSandboxPolicyRequest, policyPath: string): string[] {
  return buildOpenShellSandboxPolicySetArgs({
    ...gatewayRequest(request),
    policyPath,
  });
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

function captureOptions(
  request: {
    readonly runtimeSelection?: ReadOpenShellSandboxPolicyRequest["runtimeSelection"];
    readonly timeoutMs?: number;
  },
  defaultTimeoutMs?: number,
) {
  return withSelectedOpenShellCommandOptions(
    {
      ignoreError: true,
      includeStderr: true,
      includeStreams: true,
      outputLimitBytes: POLICY_READ_MAX_BYTES,
      timeout: request.timeoutMs ?? defaultTimeoutMs ?? DEFAULT_POLICY_READ_TIMEOUT_MS,
    } as const,
    request.runtimeSelection,
  );
}

function capturedOutput(captured: CapturedOpenShellCommandResult): string {
  return (captured.stdout ?? captured.output ?? "").trim();
}

export const classifyCliOpenShellSandboxPolicySetResult = classifyOpenShellSandboxPolicySetResult;

function parsePolicySet(
  captured: CapturedOpenShellCommandResult,
): OpenShellSandboxPolicySetSubmission {
  let outcome = classifyOpenShellSandboxPolicySetResult(captured);
  if (outcome.kind === "rejected") {
    outcome = { ...outcome, message: redactCredentialText(outcome.message) };
  } else if (outcome.kind === "ambiguous") {
    outcome = { kind: "ambiguous", detail: "OpenShell did not confirm the policy submission" };
  }
  return { status: captured.status, outcome };
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
    (output) => ({
      ...parseOpenShellSandboxPolicyRead(stripAnsi(output)),
      metadata: parsePolicyMetadata(output),
    }),
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

export function createCliOpenShellSandboxPolicyReader(
  deps: PolicyReaderDeps<CapturePolicyCommand>,
): OpenShellSandboxPolicyReader {
  return {
    readSandboxPolicy: async (request) =>
      parsePolicyRead(
        await deps.capture(policyReadArgs(request), captureOptions(request, deps.defaultTimeoutMs)),
      ),
    inspectSandboxPolicy: async (request) =>
      parsePolicyInspection(
        request,
        await deps.capture(
          policyInspectionArgs(request),
          captureOptions(request, deps.defaultTimeoutMs),
        ),
      ),
    readSandboxPolicyRevision: async (request) =>
      !Number.isSafeInteger(request.revision) || request.revision < 1
        ? parsePolicyRevision(request, { status: 0, output: "" })
        : parsePolicyRevision(
            request,
            await deps.capture(
              policyRevisionArgs(request),
              captureOptions(request, deps.defaultTimeoutMs),
            ),
          ),
  };
}

/** Ephemeral CLI input belongs to the transport, not to policy orchestration. */
export function createCliOpenShellSandboxPolicyWriter(
  deps: PolicyWriterDeps<CapturePolicyCommand>,
): OpenShellSandboxPolicyWriter {
  return {
    setSandboxPolicy: async (request) => {
      assertPolicyRequest(request);
      try {
        parseOpenShellPolicy(request.document);
      } catch {
        return {
          status: 1,
          outcome: { kind: "rejected", status: 1, message: "Invalid sandbox policy document." },
        };
      }
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-policy-"));
      let submission!: OpenShellSandboxPolicySetSubmission;
      let failure: { error: unknown } | undefined;
      try {
        const policyPath = path.join(directory, "policy.yaml");
        fs.writeFileSync(policyPath, request.document, { encoding: "utf-8", mode: 0o600 });
        submission = parsePolicySet(
          await deps.capture(
            policySetArgs(request, policyPath),
            captureOptions(request, deps.defaultTimeoutMs),
          ),
        );
      } catch (error) {
        failure = { error };
      }
      // A retained policy is never reported as a clean result, even after a successful write.
      let reason: string | null = null;
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        reason = typeof code === "string" && /^[A-Z_]+$/.test(code) ? code : "removal failed";
      }
      if (!reason && fs.existsSync(directory)) reason = "the path still exists";
      if (reason)
        throw new Error(
          `Could not remove the temporary policy directory '${directory}' (${reason}). It still holds the composed sandbox policy; remove it before retrying.`,
          failure ? { cause: failure.error } : undefined,
        );
      if (failure) throw failure.error;
      return submission;
    },
  };
}

export const cliOpenShellSandboxPolicyReader = createCliOpenShellSandboxPolicyReader({
  capture: captureSanitizedResolvedOpenshellAsync,
});
export const cliOpenShellSandboxPolicyWriter = createCliOpenShellSandboxPolicyWriter({
  capture: captureSanitizedResolvedOpenshellAsync,
});

/** Portable lifecycle retains synchronous lock ownership until its consumer migration. */
export function createSyncCliOpenShellSandboxPolicyReader(
  deps: PolicyReaderDeps<SyncCapturePolicyCommand>,
): SyncOpenShellSandboxPolicyReader {
  return {
    readSandboxPolicy: (request) => {
      const { outputLimitBytes, ...options } = captureOptions(request, deps.defaultTimeoutMs);
      return parsePolicyRead(
        deps.capture(policyReadArgs(request), { ...options, maxBuffer: outputLimitBytes }),
      );
    },
  };
}
