// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { redactString } from "./redaction.ts";

export type TargetContract = string | readonly string[];

export type TargetMetadata<Extension extends object = Record<string, unknown>> = {
  id: string;
  contract?: TargetContract;
  contracts?: readonly string[];
} & Extension;

export type TargetResult<Extension extends object = Record<string, unknown>> = {
  id: string;
  /**
   * Optional for the normal success path: reaching `complete()` after the live
   * assertions have passed records `passed`. Skipped or non-success evidence
   * must set an explicit status at the call site. Omit the key to use the
   * default; an explicit `undefined` value is rejected like any other invalid
   * status payload.
   */
  status?: string;
} & Extension;

type TargetEvidenceKind = "metadata" | "result";

function normalizeTargetEvidence(
  kind: TargetEvidenceKind,
  value: TargetMetadata | TargetResult,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`target ${kind} must be an object`);
  }
  if (typeof value.id !== "string" || value.id.trim() === "") {
    throw new TypeError(`target ${kind} id must be a non-empty string`);
  }
  if (
    kind === "result" &&
    "status" in value &&
    (typeof value.status !== "string" || value.status.trim() === "")
  ) {
    throw new TypeError("target result status must be a non-empty string");
  }

  const record = { ...value } as Record<string, unknown>;
  if (kind === "metadata") {
    const singular = record.contract;
    const plural = record.contracts;
    if (singular !== undefined && plural !== undefined) {
      throw new TypeError("target metadata must use either contract or contracts, not both");
    }
    const contracts = singular ?? plural;
    if (contracts !== undefined) {
      const normalized = typeof contracts === "string" ? [contracts] : contracts;
      if (
        !Array.isArray(normalized) ||
        normalized.some((contract) => typeof contract !== "string")
      ) {
        throw new TypeError("target contracts must be a string or an array of strings");
      }
      record.contracts = normalized;
    }
    delete record.contract;
  }
  if (kind === "result") record.status ??= "passed";
  record.runner = "vitest";
  return record;
}

export class TargetEvidenceWriter {
  constructor(private readonly artifacts: ArtifactSink) {}

  async declare<Extension extends object>(metadata: TargetMetadata<Extension>): Promise<string> {
    return this.artifacts.writeJson("target.json", normalizeTargetEvidence("metadata", metadata));
  }

  async complete<Extension extends object>(result: TargetResult<Extension>): Promise<string> {
    return this.artifacts.writeJson(
      "target-result.json",
      normalizeTargetEvidence("result", result),
    );
  }
}

/**
 * The publication boundary for live E2E evidence.
 *
 * Every text or JSON write is redacted here, including direct writers that do
 * not pass through ShellProbe. The fixture seeds environment-derived secrets;
 * callers can register values generated during a test before persisting them.
 */
export class ArtifactSink {
  readonly rootDir: string;
  readonly target: TargetEvidenceWriter;
  private readonly redactionValues = new Set<string>();

  constructor(rootDir: string, redactionValues: Iterable<string> = []) {
    const resolvedRoot = path.resolve(rootDir);
    fsSync.mkdirSync(resolvedRoot, { recursive: true });
    this.rootDir = fsSync.realpathSync(resolvedRoot);
    this.target = new TargetEvidenceWriter(this);
    this.addRedactionValues(redactionValues);
  }

  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  pathFor(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new Error(`artifact path must be relative: ${relativePath}`);
    }
    const resolved = path.resolve(this.rootDir, relativePath);
    if (resolved !== this.rootDir && !resolved.startsWith(`${this.rootDir}${path.sep}`)) {
      throw new Error(`artifact path escapes root: ${relativePath}`);
    }
    return resolved;
  }

  addRedactionValues(values: Iterable<string>): void {
    for (const value of values) {
      if (value) this.redactionValues.add(value);
    }
  }

  async writeText(relativePath: string, text: string): Promise<string> {
    const target = this.pathFor(relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, redactString(text, this.redactionValues), "utf8");
    return target;
  }

  async writeJson(relativePath: string, value: unknown): Promise<string> {
    return this.writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }
}

export function slugifyArtifactName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unnamed-test";
}

export function createArtifactSink(
  testName: string,
  rootDir = process.cwd(),
  redactionValues: Iterable<string> = [],
): ArtifactSink {
  const baseDir = process.env.E2E_ARTIFACT_DIR ?? path.join(rootDir, ".e2e", "live");
  return new ArtifactSink(path.join(baseDir, slugifyArtifactName(testName)), redactionValues);
}
