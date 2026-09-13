// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as TypeBoxModule from "typebox" with { "resolution-mode": "import" };
import {
  SandboxNameSchema,
  type NemoClawConfigDocumentName,
  type NemoClawConfigDocumentUid,
} from "../../config/model";
import { renderCanonicalNemoClawConfig } from "../../config/canonical";
import { validateNemoClawConfig } from "../../config/schema";
import type { NonEmptyExportFindings } from "../../domain/config/export-evidence";
import { buildExportConfig } from "../../domain/config/export-document";
import type {
  YamlExportFailure,
  YamlExportPublication,
} from "../../adapters/fs/config-export-file";
import type { ExportObservationResult } from "./observe-export-source";

const { Type } = require("typebox") as typeof TypeBoxModule;

export const CONFIG_EXPORT_RESULT_VERSION = 1 as const;

export type ConfigExportTarget =
  | { readonly kind: "stdout" }
  | { readonly kind: "file"; readonly outputPath: string; readonly force: boolean };

export interface ConfigExportRequest {
  readonly sandboxName: string;
  readonly documentName: NemoClawConfigDocumentName;
  readonly target: ConfigExportTarget;
}

const DigestSchema = Type.String({ pattern: "^sha256:[0-9a-f]{64}$(?![\\s\\S])" });
export const ConfigExportResultSchema = Type.Object(
  {
    version: Type.Literal(CONFIG_EXPORT_RESULT_VERSION),
    status: Type.Literal("succeeded"),
    sourceSandbox: SandboxNameSchema,
    outputPath: Type.String({ pattern: "^/" }),
    documentDigest: DigestSchema,
    specDigest: DigestSchema,
  },
  { additionalProperties: false },
);
export type ConfigExportResult = Readonly<
  TypeBoxModule.Type.Static<typeof ConfigExportResultSchema>
>;

export interface ConfigExportDependencies {
  readonly observe: (sandboxName: string) => Promise<ExportObservationResult>;
  readonly createDocumentUid: () => NemoClawConfigDocumentUid;
  readonly publish: (path: string, contents: string, force: boolean) => YamlExportPublication;
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
  | { readonly kind: "output"; readonly target: "stdout"; readonly category: "unsafe-output" }
  | ({ readonly kind: "output"; readonly target: "file" } & YamlExportFailure);

export type ConfigExportOutcome =
  | { readonly ok: true; readonly completion: ConfigExportCompletion }
  | { readonly ok: false; readonly failure: ConfigExportFailure };

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
  const config = validateNemoClawConfig(
    buildExportConfig(observation.source, {
      documentName: request.documentName,
      documentUid: dependencies.createDocumentUid(),
    }),
  );
  const rendered = renderCanonicalNemoClawConfig(config);

  if (request.target.kind === "stdout") {
    try {
      await dependencies.writeStdout(rendered.yaml);
      return { ok: true, completion: { kind: "stdout" } };
    } catch {
      return {
        ok: false,
        failure: { kind: "output", target: "stdout", category: "unsafe-output" },
      };
    }
  }

  const { outputPath, force } = request.target;
  const published = dependencies.publish(outputPath, rendered.yaml, force);
  if (!published.ok) {
    return { ok: false, failure: { kind: "output", target: "file", ...published.failure } };
  }
  return {
    ok: true,
    completion: {
      kind: "file",
      result: {
        version: CONFIG_EXPORT_RESULT_VERSION,
        status: "succeeded",
        sourceSandbox: request.sandboxName,
        outputPath: published.outputPath,
        documentDigest: rendered.documentDigest,
        specDigest: rendered.specDigest,
      },
    },
  };
}
