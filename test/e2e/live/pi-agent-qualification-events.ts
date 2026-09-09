// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import path from "node:path";

import {
  type ManagedImageContractV1,
  type ManagedImagePlatform,
  managedImagePlatformForNodeArchitecture,
  parseManagedImageContractV1,
} from "../../../src/lib/onboard/managed-image/contract.ts";
import { INFERENCE_ROUTE_URL } from "../../../src/lib/inference/config.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { readRegularArtifact } from "./managed-image-multiarch-startup-helpers.ts";

type JsonRecord = Record<string, unknown>;

export interface PiReadTaskProof {
  readonly assistantText: string;
  readonly eventCount: number;
  readonly toolCallId: string;
}

export interface PiQualificationReceipt {
  readonly contract: ManagedImageContractV1;
  readonly digest: string;
  readonly path: string;
}

export interface PiInferenceEvidence {
  readonly api: string;
  readonly model: string;
  readonly route: string;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function assistantText(message: unknown): string | null {
  const value = record(message, "Pi message");
  if (value.role !== "assistant" || !Array.isArray(value.content)) return null;
  const text = value.content.flatMap((entry) => {
    const content = record(entry, "Pi message content");
    return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
  });
  return text.length === 0 ? null : text.join("").trim();
}

export function parsePiInferenceEvidence(
  contents: string,
  expectedModel: string,
): PiInferenceEvidence {
  const config = record(JSON.parse(contents) as unknown, "Pi managed inference configuration");
  const providers = record(config.providers, "Pi managed inference providers");
  const openshell = record(providers.openshell, "Pi managed inference provider");
  const models = openshell.models;
  const model = Array.isArray(models) ? record(models[0], "Pi managed inference model").id : null;
  if (
    openshell.api !== "openai-completions" ||
    openshell.baseUrl !== INFERENCE_ROUTE_URL ||
    model !== expectedModel
  ) {
    throw new Error("Pi managed inference configuration does not match the qualified route");
  }
  return {
    api: openshell.api,
    model,
    route: openshell.baseUrl,
  };
}

export function parsePiJsonEvents(stdout: string): JsonRecord[] {
  return stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => record(JSON.parse(line) as unknown, "Pi JSON event"));
}

export function qualificationPlatform(
  architecture: string,
  expected?: string,
): ManagedImagePlatform {
  const platform = managedImagePlatformForNodeArchitecture(architecture);
  if (!platform) throw new Error(`Pi qualification does not support ${architecture}`);
  if (expected && expected !== platform) {
    throw new Error(`Pi qualification expected ${expected}, running on ${platform}`);
  }
  return platform;
}

export function readPiQualificationReceipt(platform: ManagedImagePlatform): PiQualificationReceipt {
  const file = path.join(
    REPO_ROOT,
    `ci/pi-agent-qualification-v1-${platform.replace("/", "-")}.json`,
  );
  const contents = readRegularArtifact(file, REPO_ROOT);
  return {
    contract: parseManagedImageContractV1(
      JSON.parse(contents.toString("utf8")) as unknown,
      "pi",
      platform,
    ),
    digest: createHash("sha256").update(contents).digest("hex"),
    path: file,
  };
}

export function qualifyPiReadTask(
  events: readonly JsonRecord[],
  expectedPath: string,
  expectedText: string,
): PiReadTaskProof {
  const starts = events.flatMap((event, index) =>
    event.type === "tool_execution_start" ? [{ event, index }] : [],
  );
  if (starts.length !== 1) {
    throw new Error(`Pi task must start exactly one tool, observed ${String(starts.length)}`);
  }
  const { event: start, index: startIndex } = starts[0]!;
  const args = record(start.args, "Pi read arguments");
  if (
    start.toolName !== "read" ||
    typeof start.toolCallId !== "string" ||
    args.path !== expectedPath
  ) {
    throw new Error("Pi task did not issue the exact read tool call");
  }
  const completions = events.flatMap((event, index) =>
    event.type === "tool_execution_end" ? [{ event, index }] : [],
  );
  const completion = completions[0];
  if (
    completions.length !== 1 ||
    completion!.index <= startIndex ||
    completion!.event.toolCallId !== start.toolCallId ||
    completion!.event.toolName !== "read" ||
    completion!.event.isError !== false
  ) {
    throw new Error("Pi read tool call did not complete successfully");
  }
  const replies = events.flatMap((event, index) => {
    if (event.type !== "message_end") return [];
    const text = assistantText(event.message);
    return text === null ? [] : [{ index, text }];
  });
  const reply = replies[0];
  if (replies.length !== 1 || !reply || reply.index <= completion!.index) {
    throw new Error("Pi task must return exactly one assistant response after the read completed");
  }
  if (reply.text !== expectedText) {
    throw new Error(
      `Pi task returned ${JSON.stringify(reply.text)} instead of exact file contents`,
    );
  }
  return {
    assistantText: reply.text,
    eventCount: events.length,
    toolCallId: start.toolCallId,
  };
}
