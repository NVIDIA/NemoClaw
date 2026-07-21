// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type JsonRecord = Record<string, unknown>;
type SarifLevel = "error" | "warning" | "note";

type ShellCheckComment = {
  readonly code: number;
  readonly column: number;
  readonly endColumn?: number;
  readonly endLine?: number;
  readonly file: string;
  readonly level: string;
  readonly line: number;
  readonly message: string;
};

type SarifRule = {
  readonly id: string;
  readonly name: string;
  readonly shortDescription: { readonly text: string };
};

type SarifRegion = {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine?: number;
  readonly endColumn?: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function requireString(record: JsonRecord, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${path}.${key} must be a string`);
  return value;
}

function requireInteger(record: JsonRecord, key: string, path: string, minimum: number): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`${path}.${key} must be an integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function optionalInteger(
  record: JsonRecord,
  key: string,
  path: string,
  minimum: number,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(
      `${path}.${key} must be null or an integer greater than or equal to ${minimum}`,
    );
  }
  return value as number;
}

function parseComment(value: unknown, index: number): ShellCheckComment {
  const path = `ShellCheck json1 comments[${index}]`;
  const record = requireRecord(value, path);
  const comment: ShellCheckComment = {
    code: requireInteger(record, "code", path, 0),
    column: requireInteger(record, "column", path, 1),
    endColumn: optionalInteger(record, "endColumn", path, 1),
    endLine: optionalInteger(record, "endLine", path, 1),
    file: requireString(record, "file", path),
    level: requireString(record, "level", path),
    line: requireInteger(record, "line", path, 1),
    message: requireString(record, "message", path),
  };

  if (comment.endLine !== undefined && comment.endLine < comment.line) {
    throw new Error(`${path}.endLine must be greater than or equal to ${path}.line`);
  }
  if (
    comment.endColumn !== undefined &&
    (comment.endLine === undefined || comment.endLine === comment.line) &&
    comment.endColumn < comment.column
  ) {
    throw new Error(
      `${path}.endColumn must be greater than or equal to ${path}.column for a same-line region`,
    );
  }

  return comment;
}

function sarifLevel(level: string): SarifLevel {
  if (level === "error") return "error";
  if (level === "warning") return "warning";
  return "note";
}

function ruleId(code: number): string {
  return `SC${code}`;
}

export function convertShellCheckJson1(input: unknown) {
  const root = requireRecord(input, "ShellCheck json1 input");
  if (!Array.isArray(root.comments)) {
    throw new Error("ShellCheck json1 input.comments must be an array");
  }
  const comments = root.comments.map(parseComment);

  const rulesById = new Map<string, SarifRule>();
  for (const comment of comments) {
    const id = ruleId(comment.code);
    if (!rulesById.has(id)) {
      rulesById.set(id, {
        id,
        name: id,
        shortDescription: { text: comment.level },
      });
    }
  }
  const rules = [...rulesById.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );

  const results = comments.map((comment) => {
    const region: SarifRegion = {
      startLine: comment.line,
      startColumn: comment.column,
      ...(comment.endLine === undefined ? {} : { endLine: comment.endLine }),
      ...(comment.endColumn === undefined ? {} : { endColumn: comment.endColumn }),
    };
    return {
      ruleId: ruleId(comment.code),
      level: sarifLevel(comment.level),
      message: { text: comment.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: comment.file },
            region,
          },
        },
      ],
    } as const;
  });

  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "ShellCheck",
            informationUri: "https://www.shellcheck.net/",
            rules,
          },
        },
        results,
      },
    ],
  } as const;
}

export function parseShellCheckJson1(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`ShellCheck json1 input is not valid JSON: ${formatError(error)}`);
  }
}

export function writeShellCheckSarif(inputPath: string, outputPath: string): void {
  const input = parseShellCheckJson1(readFileSync(inputPath, "utf-8"));
  const sarif = convertShellCheckJson1(input);
  writeFileSync(outputPath, `${JSON.stringify(sarif, null, 2)}\n`, "utf-8");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usage(): string {
  return (
    "Usage: node --experimental-strip-types scripts/shellcheck-json1-to-sarif.mts " +
    "<shellcheck.json> <shellcheck.sarif>"
  );
}

function main(argv: string[]): void {
  const [inputPath, outputPath, ...extra] = argv;
  if (!inputPath || !outputPath || extra.length > 0) throw new Error(usage());
  writeShellCheckSarif(inputPath, outputPath);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invokedPath === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ERROR: ${formatError(error)}\n`);
    process.exitCode = 1;
  }
}
