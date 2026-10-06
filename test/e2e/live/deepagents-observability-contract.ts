// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as policyDenialNamespace from "../../../src/lib/actions/sandbox/exec-policy-hint-detection.ts";
import type { DecodedOtlpSpan } from "./otlp-trace-decoder.ts";
import * as decoderNamespace from "./otlp-trace-decoder.ts";
import * as policyStateNamespace from "./policy-list-state.ts";

function moduleExports<T>(namespace: T & { default?: T }): T {
  return namespace.default ?? namespace;
}

const { isPolicyDenialLine } = moduleExports(policyDenialNamespace);
const { decodeExportTraceServiceRequest, otlpValueContains } = moduleExports(decoderNamespace);
const { parsePolicyPresetState } = moduleExports(policyStateNamespace);

const INPUT_ATTRIBUTE_KEYS = ["input.value", "llm.input_messages"] as const;
const OUTPUT_ATTRIBUTE_KEYS = ["output.value", "llm.output_messages"] as const;
const TOOL_INPUT_ATTRIBUTE_KEYS = ["tool.parameters", "input.value"] as const;
const CONFIRMED_EXEC_HINT =
  /^[a-z][a-z0-9-]*: recent network policy denial detected(?: for [^\r\n]+)? inside sandbox '[a-zA-Z0-9][a-zA-Z0-9_-]*'\.$/mu;
const EMBEDDED_STRUCTURED_PROXY_JSON_RE = /\{[^{}\r\n]{1,4094}\}/gu;
export type LlmTraceExpectation = {
  label: string;
  promptMarker: string;
  redactionMarker?: string;
  responseMarker: string;
};

export type ToolTraceExpectation = {
  argumentMarker: string;
  name: string;
  resultMarker: string;
};

export type DeepAgentsTraceExpectations = {
  ambientCanary: string;
  llmExchanges: readonly LlmTraceExpectation[];
  redaction: {
    rawCredential: string;
  };
  serviceName: string;
  tool: ToolTraceExpectation;
};

type CaptureMetadata = {
  accepted?: unknown;
  method?: unknown;
  path?: unknown;
  port?: unknown;
  rejection?: unknown;
};

function spanKind(span: DecodedOtlpSpan): string {
  const kind = span.attributes["openinference.span.kind"];
  return typeof kind === "string" ? kind.toUpperCase() : "";
}

function markerInAttributes(
  span: DecodedOtlpSpan,
  keys: readonly string[],
  marker: string,
): boolean {
  return keys.some((key) => otlpValueContains(span.attributes[key], marker));
}

function hasManagedService(span: DecodedOtlpSpan, serviceName: string): boolean {
  return span.resourceAttributes["service.name"] === serviceName;
}

function assertLlmExchange(
  spans: readonly DecodedOtlpSpan[],
  serviceName: string,
  expectation: LlmTraceExpectation,
): void {
  const match = spans.find(
    (span) =>
      hasManagedService(span, serviceName) &&
      spanKind(span) === "LLM" &&
      markerInAttributes(span, INPUT_ATTRIBUTE_KEYS, expectation.promptMarker) &&
      (expectation.redactionMarker === undefined ||
        markerInAttributes(span, INPUT_ATTRIBUTE_KEYS, expectation.redactionMarker)) &&
      markerInAttributes(span, OUTPUT_ATTRIBUTE_KEYS, expectation.responseMarker),
  );
  if (!match) {
    throw new Error(
      `${expectation.label} prompt and response markers were not associated on one managed LLM span`,
    );
  }
}

function assertToolCall(
  spans: readonly DecodedOtlpSpan[],
  serviceName: string,
  expectation: ToolTraceExpectation,
): void {
  const match = spans.find(
    (span) =>
      hasManagedService(span, serviceName) &&
      spanKind(span) === "TOOL" &&
      otlpValueContains(span.attributes["tool.name"], expectation.name) &&
      markerInAttributes(span, TOOL_INPUT_ATTRIBUTE_KEYS, expectation.argumentMarker) &&
      markerInAttributes(span, OUTPUT_ATTRIBUTE_KEYS, expectation.resultMarker),
  );
  if (!match) {
    throw new Error(
      "tool name, argument, and result markers were not associated on one managed TOOL span",
    );
  }
}

export function assertDeepAgentsTraceContract(
  bodies: readonly Uint8Array[],
  expectations: DeepAgentsTraceExpectations,
): { requestCount: number; spanCount: number } {
  // Required LLM and tool spans below also reject an empty capture.
  const canary = Buffer.from(expectations.ambientCanary);
  const rawCredential = Buffer.from(expectations.redaction.rawCredential);
  const spans = bodies.flatMap((body, index) => {
    const encoded = Buffer.from(body);
    if (encoded.includes(canary)) {
      throw new Error("ambient exporter configuration reached OTLP");
    }
    if (encoded.includes(rawCredential)) {
      throw new Error("credential-shaped prompt content reached OTLP");
    }
    try {
      return decodeExportTraceServiceRequest(body);
    } catch (error) {
      throw new Error(
        `captured OTLP request ${index + 1} is not a valid ExportTraceServiceRequest: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  // Check the replacement marker on the originating LLM span, not merely
  // somewhere in the encoded request.
  for (const expectation of expectations.llmExchanges) {
    assertLlmExchange(spans, expectations.serviceName, expectation);
  }
  assertToolCall(spans, expectations.serviceName, expectations.tool);
  return { requestCount: bodies.length, spanCount: spans.length };
}

export function hasConfirmedOpenShellPolicyDenial(output: string): boolean {
  if (output.split(/\r?\n/u).some(isPolicyDenialLine) || CONFIRMED_EXEC_HINT.test(output)) {
    return true;
  }
  // curl writes the response body to stdout and its error to stderr. Once the
  // E2E harness merges those descriptors, the exact OpenShell JSON object can
  // land between two curl error fragments. Keep this fallback bounded to one
  // flat object and delegate the payload validation to the production parser.
  return (output.match(EMBEDDED_STRUCTURED_PROXY_JSON_RE) ?? []).some(isPolicyDenialLine);
}

export function observabilityPresetState(output: string): string {
  return parsePolicyPresetState(output, "observability-otlp-local");
}

function nativeDcodeData(output: string, command: string): Record<string, unknown> | unknown[] {
  let envelope;
  try {
    envelope = JSON.parse(output);
  } catch {
    throw new Error("invalid native DCode result envelope");
  }
  if (
    envelope?.schema_version !== 1 ||
    envelope.command !== command ||
    typeof envelope.data !== "object" ||
    envelope.data === null
  ) {
    throw new Error("invalid native DCode result envelope");
  }
  return envelope.data;
}

export function observabilityProbeThreadId(output: string, probeCwd?: string): string {
  const data = nativeDcodeData(output, probeCwd ? "threads list" : "non-interactive");
  // A fresh, privately owned cwd identifies the probe even when cancellation
  // prevents a completion envelope. The native list filters by exact cwd;
  // require the returned metadata to agree and reject ambiguous results.
  if (probeCwd && Array.isArray(data) && data.length === 0) return "";
  const listed = (Array.isArray(data) && data.length === 1 ? data[0] : undefined) as
    | { cwd?: unknown; thread_id?: unknown }
    | undefined;
  const completion = (Array.isArray(data) ? undefined : data.completion) as
    | { thread_id?: unknown }
    | undefined;
  const threadId = probeCwd
    ? listed?.cwd === probeCwd
      ? listed.thread_id
      : undefined
    : completion?.thread_id;
  if (
    typeof threadId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(threadId)
  ) {
    throw new Error("observability probe did not report its native thread ID");
  }
  return threadId;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`required environment variable ${name} is missing`);
  return value;
}

function captureMetadata(value: unknown, filename: string): CaptureMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${filename} does not contain a capture metadata object`);
  }
  return value as CaptureMetadata;
}

export function validateCaptureDirectory(
  captureDir: string,
  collectorPort: number,
  allowedProbeBody: string,
  expectations: DeepAgentsTraceExpectations,
): { requestCount: number; spanCount: number } {
  const metadataFiles = fs
    .readdirSync(captureDir)
    .filter((filename) => filename.endsWith(".json"))
    .sort();
  const traceBodies: Buffer[] = [];
  let allowedProbeCount = 0;

  for (const metadataFile of metadataFiles) {
    const metadata = captureMetadata(
      JSON.parse(fs.readFileSync(path.join(captureDir, metadataFile), "utf8")),
      metadataFile,
    );
    if (metadata.accepted !== true) {
      throw new Error(`${metadataFile} records a rejected request: ${String(metadata.rejection)}`);
    }
    if (
      metadata.port !== collectorPort ||
      metadata.method !== "POST" ||
      metadata.path !== "/v1/traces"
    ) {
      throw new Error(
        `unexpected captured route ${String(metadata.method)} ${String(metadata.path)} on ${String(metadata.port)}`,
      );
    }
    // The capture server accepts only application/x-protobuf; rejected
    // content types fail the accepted check above.
    const body = fs.readFileSync(path.join(captureDir, metadataFile.replace(/\.json$/u, ".body")));
    if (body.equals(Buffer.from(allowedProbeBody))) {
      allowedProbeCount += 1;
      continue;
    }
    traceBodies.push(body);
  }

  if (allowedProbeCount !== 1) {
    throw new Error(`expected one managed-Python allow probe, captured ${allowedProbeCount}`);
  }
  return assertDeepAgentsTraceContract(traceBodies, expectations);
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  const input = command === "validate-captures" ? "" : fs.readFileSync(0, "utf8");
  if (command === "policy-state") {
    process.stdout.write(`${observabilityPresetState(input)}\n`);
    return;
  }
  if (command === "denial-state") {
    process.stdout.write(
      `${hasConfirmedOpenShellPolicyDenial(input) ? "policy-denied" : "other-failure"}\n`,
    );
    return;
  }
  if (command === "probe-thread-id") {
    process.stdout.write(`${observabilityProbeThreadId(input, argument)}\n`);
    return;
  }
  if (command === "validate-captures" && argument) {
    const result = validateCaptureDirectory(
      argument,
      Number(requiredEnvironment("COLLECTOR_PORT")),
      requiredEnvironment("ALLOWED_PROBE"),
      {
        ambientCanary: requiredEnvironment("AMBIENT_CANARY"),
        redaction: {
          rawCredential: requiredEnvironment("REDACTION_PROBE"),
        },
        serviceName: requiredEnvironment("SERVICE_NAME"),
        llmExchanges: [
          {
            label: "direct-exec",
            promptMarker: requiredEnvironment("DIRECT_PROMPT"),
            redactionMarker: requiredEnvironment("REDACTION_MARKER"),
            responseMarker: requiredEnvironment("DIRECT_RESPONSE"),
          },
          {
            label: "login-shell",
            promptMarker: requiredEnvironment("LOGIN_PROMPT"),
            responseMarker: requiredEnvironment("LOGIN_RESPONSE"),
          },
        ],
        tool: {
          argumentMarker: requiredEnvironment("TOOL_ARGUMENT"),
          name: requiredEnvironment("TOOL_NAME"),
          resultMarker: requiredEnvironment("TOOL_RESULT"),
        },
      },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error(
    "usage: deepagents-observability-contract.ts <policy-state|denial-state|validate-captures|probe-thread-id> [argument]",
  );
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
