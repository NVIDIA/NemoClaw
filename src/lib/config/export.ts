// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { renderCanonicalNemoClawConfig } from "./canonical";
import { buildExportConfig } from "./export-builder";
import type { ExportObservationResult, NonEmptyExportFindings } from "./export-observation";
import type { NemoClawConfigDocumentName, NemoClawConfigDocumentUid } from "./model";
import {
  YamlExportOutputError,
  type YamlExportFailureKind,
  type YamlExportFileState,
} from "./output";

export const CONFIG_EXPORT_RESULT_VERSION = 1 as const;

export type ConfigExportTarget =
  | { readonly kind: "stdout" }
  | { readonly kind: "file"; readonly outputPath: string; readonly force: boolean };

export interface ConfigExportRequest {
  readonly sandboxName: string;
  readonly documentName: NemoClawConfigDocumentName;
  readonly target: ConfigExportTarget;
}

export interface ConfigExportResult {
  readonly version: typeof CONFIG_EXPORT_RESULT_VERSION;
  readonly status: "succeeded";
  readonly sourceSandbox: string;
  readonly outputPath: string;
  readonly documentDigest: string;
  readonly specDigest: string;
}

export interface ConfigExportDependencies {
  readonly observe: (sandboxName: string) => Promise<ExportObservationResult>;
  readonly createDocumentUid: () => NemoClawConfigDocumentUid;
  readonly publish: (path: string, contents: string, force: boolean) => string;
  readonly writeStdout: (contents: string) => Promise<void>;
}

export type ConfigExportCompletion =
  | { readonly kind: "stdout" }
  | { readonly kind: "file"; readonly result: ConfigExportResult };

export type ConfigExportFailure =
  | {
      readonly kind: "observation";
      readonly findings: NonEmptyExportFindings;
      readonly attempts: 1 | 2;
    }
  | {
      readonly kind: "output";
      readonly target: "stdout";
      readonly category: "unsafe-output";
      readonly diagnostic: string;
    }
  | {
      readonly kind: "output";
      readonly target: "file";
      readonly fileState: YamlExportFileState | "unknown";
      readonly category: YamlExportFailureKind;
      readonly diagnostic: string;
    };

export type ConfigExportOutcome =
  | { readonly ok: true; readonly completion: ConfigExportCompletion }
  | { readonly ok: false; readonly failure: ConfigExportFailure };

function stdoutFailure(): ConfigExportOutcome {
  return {
    ok: false,
    failure: {
      kind: "output",
      target: "stdout",
      category: "unsafe-output",
      diagnostic: "The export could not be written to stdout.",
    },
  };
}

function unreachable(value: never): never {
  throw new Error(`Unexpected export file state: ${String(value)}`);
}

function fileDiagnostic(
  category: YamlExportFailureKind,
  fileState: YamlExportFileState,
): string {
  switch (fileState.publication) {
    case "unknown":
      return fileState.stagingCleanup === "incomplete"
        ? "The export publication state and staging cleanup could not be confirmed."
        : "The export may have been written, but its publication state could not be confirmed.";
    case "not-published":
      if (fileState.stagingCleanup === "incomplete") {
        return "The export was not published, and its staging file could not be removed.";
      }
      return category === "output-conflict"
        ? "The output path already exists."
        : "The output path could not be published safely.";
    case "published": {
      const concerns = [
        ...(fileState.durability === "unknown" ? ["filesystem durability"] : []),
        ...(fileState.location === "unknown" ? ["the final output location"] : []),
        ...(fileState.stagingCleanup === "incomplete" ? ["staging cleanup"] : []),
      ];
      return concerns.length > 0
        ? `The export was written, but ${concerns.join(", ")} could not be confirmed.`
        : "The export was written, but output finalization failed.";
    }
    default:
      return unreachable(fileState);
  }
}

function fileFailure(error: unknown): ConfigExportOutcome {
  if (error instanceof YamlExportOutputError) {
    const { fileState } = error;
    const category =
      error.category === "output-conflict" &&
      fileState.publication === "not-published" &&
      fileState.stagingCleanup === "complete"
        ? "output-conflict"
        : "unsafe-output";
    return {
      ok: false,
      failure: {
        kind: "output",
        target: "file",
        fileState,
        category,
        diagnostic: fileDiagnostic(category, fileState),
      },
    };
  }
  return {
    ok: false,
    failure: {
      kind: "output",
      target: "file",
      fileState: "unknown",
      category: "unsafe-output",
      diagnostic: "The export publication state could not be determined safely.",
    },
  };
}

export async function runConfigExport(
  request: ConfigExportRequest,
  dependencies: ConfigExportDependencies,
): Promise<ConfigExportOutcome> {
  const observation = await dependencies.observe(request.sandboxName);
  if (!observation.ok) {
    return {
      ok: false,
      failure: {
        kind: "observation",
        findings: observation.findings,
        attempts: observation.attempts,
      },
    };
  }
  const config = buildExportConfig(observation.source, {
    documentName: request.documentName,
    documentUid: dependencies.createDocumentUid(),
  });
  const rendered = renderCanonicalNemoClawConfig(config);

  if (request.target.kind === "stdout") {
    try {
      await dependencies.writeStdout(rendered.yaml);
      return { ok: true, completion: { kind: "stdout" } };
    } catch {
      return stdoutFailure();
    }
  }

  const { outputPath, force } = request.target;
  try {
    const published = dependencies.publish(outputPath, rendered.yaml, force);
    return {
      ok: true,
      completion: {
        kind: "file",
        result: {
          version: CONFIG_EXPORT_RESULT_VERSION,
          status: "succeeded",
          sourceSandbox: request.sandboxName,
          outputPath: published,
          documentDigest: rendered.documentDigest,
          specDigest: rendered.specDigest,
        },
      },
    };
  } catch (error) {
    return fileFailure(error);
  }
}
