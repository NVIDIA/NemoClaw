// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";

const PROBE_VERSION = 1;
const PROBE_CATEGORIES = [
  "credentialFiles",
  "configFiles",
  "processEnvironment",
  "processArguments",
] as const;

export interface ForbiddenLeakPattern {
  readonly name: string;
  readonly value: string;
}

interface BedrockForbiddenLeakValues {
  readonly adapterToken: string;
  readonly bedrockHostname: string;
  readonly compatibleKey: string;
}

export interface BedrockLeakFingerprint {
  readonly name: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly byteSum: number;
}

export interface BedrockLeakProbeInput {
  readonly version: typeof PROBE_VERSION;
  readonly patterns: readonly BedrockLeakFingerprint[];
  readonly credentialFiles: readonly string[];
  readonly configFiles: readonly string[];
  readonly procRoot: string;
}

type ProbeCategoryName = (typeof PROBE_CATEGORIES)[number];
type ProbeStatus = "clean" | "error" | "leak";

export interface BedrockLeakProbeCategory {
  readonly status: ProbeStatus;
  readonly itemsScanned: number;
  readonly bytesScanned: number;
  readonly matches: readonly string[];
  readonly errors: readonly string[];
}

export interface BedrockLeakProbeResult {
  readonly version: typeof PROBE_VERSION;
  readonly status: ProbeStatus;
  readonly categories: Readonly<Record<ProbeCategoryName, BedrockLeakProbeCategory>>;
}

export const BEDROCK_LEAK_PROBE_SOURCE = fs.readFileSync(
  new URL("./bedrock-runtime-compatible-anthropic-leak-probe.py", import.meta.url),
  "utf8",
);

export function createBedrockLeakProbeExecArgs(sandboxName: string): readonly string[] {
  return [
    "sandbox",
    "exec",
    "-n",
    sandboxName,
    "--",
    "python3",
    "-I",
    "-c",
    BEDROCK_LEAK_PROBE_SOURCE,
  ];
}

interface BedrockLeakProbeInputOptions {
  readonly credentialFiles: readonly string[];
  readonly configFiles: readonly string[];
  readonly procRoot?: string;
}

export function createBedrockForbiddenLeakPatterns(
  values: BedrockForbiddenLeakValues,
): readonly ForbiddenLeakPattern[] {
  return [
    { name: "fake user key", value: values.compatibleKey },
    { name: "adapter token", value: values.adapterToken },
    { name: "aws bearer env name", value: "AWS_BEARER_TOKEN_BEDROCK" },
    { name: "adapter token env name", value: "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN" },
    { name: "raw bedrock hostname", value: values.bedrockHostname },
  ];
}

function validatePatterns(patterns: readonly ForbiddenLeakPattern[]): void {
  if (patterns.length === 0 || patterns.length > 16) {
    throw new Error("Bedrock leak probe requires between 1 and 16 forbidden values");
  }
  const names = new Set<string>();
  for (const pattern of patterns) {
    if (!/^[a-z][a-z0-9 -]{0,63}$/u.test(pattern.name) || names.has(pattern.name)) {
      throw new Error("Bedrock leak probe pattern names must be unique safe labels");
    }
    const byteLength = Buffer.byteLength(pattern.value, "utf8");
    if (byteLength < 8 || byteLength > 4096) {
      throw new Error("Bedrock leak probe values must contain 8 to 4096 UTF-8 bytes");
    }
    names.add(pattern.name);
  }
}

function validatePaths(label: string, paths: readonly string[]): void {
  const countInvalid = paths.length === 0 || paths.length > 16;
  const pathInvalid = paths.some(
    (filePath) => !filePath.startsWith("/") || /[\r\n]/u.test(filePath),
  );
  if (countInvalid || pathInvalid) {
    throw new Error(
      countInvalid
        ? `Bedrock leak probe ${label} must contain between 1 and 16 paths`
        : `Bedrock leak probe ${label} must contain absolute single-line paths`,
    );
  }
}

export function createBedrockLeakProbeInput(
  patterns: readonly ForbiddenLeakPattern[],
  options: BedrockLeakProbeInputOptions,
): BedrockLeakProbeInput {
  validatePatterns(patterns);
  validatePaths("credential files", options.credentialFiles);
  validatePaths("config files", options.configFiles);
  const procRoot = options.procRoot ?? "/proc";
  validatePaths("process root", [procRoot]);
  const input: BedrockLeakProbeInput = {
    version: PROBE_VERSION,
    patterns: patterns.map((pattern) => {
      const value = Buffer.from(pattern.value, "utf8");
      return {
        name: pattern.name,
        byteLength: value.length,
        sha256: createHash("sha256").update(value).digest("hex"),
        byteSum: value.reduce((sum, byte) => sum + byte, 0),
      };
    }),
    credentialFiles: [...options.credentialFiles],
    configFiles: [...options.configFiles],
    procRoot,
  };
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 32_768) {
    throw new Error("Bedrock leak probe input exceeded its byte limit");
  }
  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}

function parseCategory(
  value: unknown,
  expectedNames: ReadonlySet<string>,
  limits: { readonly maxItems: number; readonly maxBytes: number },
): BedrockLeakProbeCategory {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["status", "itemsScanned", "bytesScanned", "matches", "errors"])
  ) {
    throw new Error("Bedrock leak probe returned a malformed category");
  }
  const { status, itemsScanned, bytesScanned, matches, errors } = value;
  if (!(["clean", "error", "leak"] as const).includes(status as ProbeStatus)) {
    throw new Error("Bedrock leak probe returned an invalid category status");
  }
  if (
    !Number.isSafeInteger(itemsScanned) ||
    (itemsScanned as number) < 0 ||
    (itemsScanned as number) > limits.maxItems
  ) {
    throw new Error("Bedrock leak probe returned an invalid item count");
  }
  if (
    !Number.isSafeInteger(bytesScanned) ||
    (bytesScanned as number) < 0 ||
    (bytesScanned as number) > limits.maxBytes
  ) {
    throw new Error("Bedrock leak probe returned an invalid byte count");
  }
  if (
    !Array.isArray(matches) ||
    matches.some((name) => typeof name !== "string" || !expectedNames.has(name)) ||
    new Set(matches).size !== matches.length
  ) {
    throw new Error("Bedrock leak probe returned invalid match metadata");
  }
  if (
    !Array.isArray(errors) ||
    errors.some((error) => typeof error !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(error)) ||
    new Set(errors).size !== errors.length
  ) {
    throw new Error("Bedrock leak probe returned invalid error metadata");
  }
  const expectedStatus = errors.length > 0 ? "error" : matches.length > 0 ? "leak" : "clean";
  if (status !== expectedStatus) {
    throw new Error("Bedrock leak probe category status does not match its metadata");
  }
  return {
    status: status as ProbeStatus,
    itemsScanned: itemsScanned as number,
    bytesScanned: bytesScanned as number,
    matches: matches as string[],
    errors: errors as string[],
  };
}

export function parseBedrockLeakProbeResult(
  stdout: string,
  patterns: readonly ForbiddenLeakPattern[],
): BedrockLeakProbeResult {
  if (Buffer.byteLength(stdout, "utf8") > 32_768 || stdout.trim().includes("\n")) {
    throw new Error("Bedrock leak probe output exceeded its single-record bound");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Bedrock leak probe returned malformed JSON");
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, ["version", "status", "categories"]) ||
    parsed.version !== PROBE_VERSION
  ) {
    throw new Error("Bedrock leak probe returned a malformed result");
  }
  const parsedCategories = parsed.categories;
  if (!isRecord(parsedCategories) || !hasExactKeys(parsedCategories, PROBE_CATEGORIES)) {
    throw new Error("Bedrock leak probe returned a malformed result");
  }
  const expectedNames = new Set(patterns.map((pattern) => pattern.name));
  const categories = Object.fromEntries(
    PROBE_CATEGORIES.map((name) => [
      name,
      parseCategory(
        parsedCategories[name],
        expectedNames,
        name === "credentialFiles" || name === "configFiles"
          ? { maxItems: 16, maxBytes: 2_097_152 }
          : { maxItems: 512, maxBytes: 4_194_304 },
      ),
    ]),
  ) as Record<ProbeCategoryName, BedrockLeakProbeCategory>;
  const statuses = new Set(Object.values(categories).map((category) => category.status));
  const expectedStatus: ProbeStatus = statuses.has("error")
    ? "error"
    : statuses.has("leak")
      ? "leak"
      : "clean";
  if (parsed.status !== expectedStatus) {
    throw new Error("Bedrock leak probe result status does not match its categories");
  }
  const serialized = JSON.stringify(parsed);
  for (const pattern of patterns) {
    if (serialized.includes(pattern.value)) {
      throw new Error("Bedrock leak probe returned a forbidden raw value");
    }
  }
  return { version: PROBE_VERSION, status: expectedStatus, categories };
}
