// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  type ManagedImageContractV1,
  type ManagedImagePlatform,
  managedImagePlatformForNodeArchitecture,
  parseManagedImageContractV1,
} from "../../../src/lib/onboard/managed-image/contract.ts";
import { INFERENCE_ROUTE_URL } from "../../../src/lib/inference/config.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

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

export interface PiRuntimePackageEvidence {
  readonly integrity: string;
  readonly version: string;
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
  return value.content
    .flatMap((entry) => {
      const content = record(entry, "Pi message content");
      return content.type === "text" && typeof content.text === "string" ? [content.text] : [];
    })
    .join("")
    .trim();
}

export function derivePiImageSourcePaths(dockerfiles: readonly string[]): string[] {
  const paths = new Set<string>([".dockerignore"]);
  for (const dockerfile of dockerfiles) {
    const logicalLines = dockerfile.replace(/\\\r?\n\s*/gu, " ").split(/\r?\n/u);
    for (const rawLine of logicalLines) {
      const line = rawLine.trim();
      if (!line.startsWith("COPY ")) continue;
      const tokens = line.split(/\s+/u).slice(1);
      if (tokens.some((token) => token.startsWith("--from="))) continue;
      const operands = tokens.filter((token) => !token.startsWith("--"));
      if (operands.length < 2 || operands.some((token) => /[\[\]",]/u.test(token))) {
        throw new Error("Pi Dockerfile COPY instruction must use plain path operands");
      }
      for (const source of operands.slice(0, -1)) {
        const normalized = source.replace(/\/$/u, "");
        paths.add(normalized.startsWith("agents/pi/") ? "agents/pi" : normalized);
      }
    }
  }
  return [...paths].sort();
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

export function parsePiRuntimePackageEvidence(contents: string): PiRuntimePackageEvidence {
  const packageLock = record(JSON.parse(contents) as unknown, "Pi runtime package lock");
  const packages = record(packageLock.packages, "Pi runtime package lock entries");
  const runtimePackage = record(
    packages["node_modules/@earendil-works/pi-coding-agent"],
    "Pi runtime package lock entry",
  );
  if (
    typeof runtimePackage.version !== "string" ||
    runtimePackage.version.length === 0 ||
    typeof runtimePackage.integrity !== "string" ||
    runtimePackage.integrity.length === 0
  ) {
    throw new Error("Pi runtime package lock entry is missing version or integrity evidence");
  }
  return { integrity: runtimePackage.integrity, version: runtimePackage.version };
}

export function readOptionalUtf8File(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  }
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
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let contents: string;
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error("Pi qualification receipt must be a regular non-symlink file");
    }
    contents = fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
  return {
    contract: parseManagedImageContractV1(JSON.parse(contents) as unknown, "pi", platform),
    digest: createHash("sha256").update(contents, "utf8").digest("hex"),
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
    event.type === "tool_execution_end" && event.toolCallId === start.toolCallId
      ? [{ event, index }]
      : [],
  );
  if (
    completions.length !== 1 ||
    completions[0]!.index <= startIndex ||
    completions[0]!.event.toolName !== "read" ||
    completions[0]!.event.isError !== false
  ) {
    throw new Error("Pi read tool call did not complete successfully");
  }
  const replies = events.flatMap((event) => {
    if (event.type !== "message_end") return [];
    const text = assistantText(event.message);
    return text === null ? [] : [text];
  });
  const finalText = replies.at(-1);
  if (finalText !== expectedText) {
    throw new Error(`Pi task returned ${JSON.stringify(finalText)} instead of exact file contents`);
  }
  return {
    assistantText: finalText,
    eventCount: events.length,
    toolCallId: start.toolCallId,
  };
}
