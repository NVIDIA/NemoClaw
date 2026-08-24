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
  const metadata = fs.lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Pi qualification receipt must be a regular non-symlink file");
  }
  const contents = fs.readFileSync(file, "utf8");
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
  const starts = events.filter((event) => event.type === "tool_execution_start");
  if (starts.length !== 1) {
    throw new Error(`Pi task must start exactly one tool, observed ${String(starts.length)}`);
  }
  const start = starts[0];
  const args = record(start.args, "Pi read arguments");
  if (
    start.toolName !== "read" ||
    typeof start.toolCallId !== "string" ||
    args.path !== expectedPath
  ) {
    throw new Error("Pi task did not issue the exact read tool call");
  }
  const end = events.find(
    (event) => event.type === "tool_execution_end" && event.toolCallId === start.toolCallId,
  );
  if (!end || end.toolName !== "read" || end.isError !== false) {
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
