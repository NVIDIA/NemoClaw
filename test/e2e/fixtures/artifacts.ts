// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { ExecutionEvidence } from "../registry/parity-evidence.ts";
import { redactString } from "./redaction.ts";

export type TargetContract = string | readonly string[];

const ARTIFACT_DIRECTORY_MODE = 0o700;
const ARTIFACT_FILE_MODE = 0o600;

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
    fsSync.mkdirSync(resolvedRoot, { recursive: true, mode: ARTIFACT_DIRECTORY_MODE });
    this.rootDir = fsSync.realpathSync(resolvedRoot);
    this.assertPrivateDirectorySync(this.rootDir);
    this.target = new TargetEvidenceWriter(this);
    this.addRedactionValues(redactionValues);
  }

  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: ARTIFACT_DIRECTORY_MODE });
    await this.assertPrivateDirectory(this.rootDir);
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
    const parent = path.dirname(target);
    await this.ensurePrivateDirectoryChain(parent);

    const temporary = path.join(
      parent,
      `.${path.basename(target)}.${String(process.pid)}.${randomUUID()}.tmp`,
    );
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(
        temporary,
        fsSync.constants.O_WRONLY |
          fsSync.constants.O_CREAT |
          fsSync.constants.O_EXCL |
          fsSync.constants.O_NOFOLLOW,
        ARTIFACT_FILE_MODE,
      );
      await handle.chmod(ARTIFACT_FILE_MODE);
      await handle.writeFile(redactString(text, this.redactionValues), "utf8");
      await handle.sync();
      const staged = await handle.stat({ bigint: true });
      if (
        !staged.isFile() ||
        staged.isSymbolicLink() ||
        staged.nlink !== 1n ||
        (staged.mode & 0o777n) !== BigInt(ARTIFACT_FILE_MODE)
      ) {
        throw new Error("artifact temporary file authority is invalid");
      }
      await handle.close();
      handle = undefined;

      await fs.rename(temporary, target);
      const published = await fs.lstat(target, { bigint: true });
      if (
        !published.isFile() ||
        published.isSymbolicLink() ||
        published.dev !== staged.dev ||
        published.ino !== staged.ino ||
        published.nlink !== 1n ||
        (published.mode & 0o777n) !== BigInt(ARTIFACT_FILE_MODE)
      ) {
        throw new Error("artifact file authority changed during publication");
      }
      return target;
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async writeJson(relativePath: string, value: unknown): Promise<string> {
    return this.writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async writeExecutionEvidence(resultId: string, evidence: ExecutionEvidence): Promise<string> {
    if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(resultId)) {
      throw new Error(`execution result id is not artifact-safe: ${resultId}`);
    }
    if (resultId !== evidence.resultId) {
      throw new Error(
        `execution result id '${resultId}' does not match evidence result '${evidence.resultId}'`,
      );
    }
    return this.writeJson(path.join("execution", `${resultId}.json`), evidence);
  }

  private assertPrivateDirectorySync(directory: string): void {
    const stat = fsSync.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("artifact directory authority is invalid");
    }
    fsSync.chmodSync(directory, ARTIFACT_DIRECTORY_MODE);
  }

  private async assertPrivateDirectory(directory: string): Promise<void> {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("artifact directory authority is invalid");
    }
    await fs.chmod(directory, ARTIFACT_DIRECTORY_MODE);
  }

  private async ensurePrivateDirectoryChain(directory: string): Promise<void> {
    await this.ensureRoot();
    const relative = path.relative(this.rootDir, directory);
    if (relative === "") return;
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("artifact directory escapes root");
    }

    let current = this.rootDir;
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component);
      try {
        await fs.mkdir(current, { mode: ARTIFACT_DIRECTORY_MODE });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      await this.assertPrivateDirectory(current);
    }
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
