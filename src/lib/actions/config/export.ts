// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type * as TypeBoxModule from "typebox" with { "resolution-mode": "import" };
import {
  SandboxNameSchema,
  type NemoClawConfigDocumentName,
  type NemoClawConfigDocumentUid,
} from "../../config/model";
import { renderCanonicalNemoClawConfig } from "../../config/canonical";
import type { NonEmptyExportFindings } from "../../domain/config/export-evidence";
import type { V1Alpha1Export } from "../../config/v1alpha1-export";
import { buildExportConfig } from "../../domain/config/export-document";
import { exportOmissions, type ExportOmission } from "../../domain/config/export-omissions";
import { renderExportReportHeader } from "../../domain/config/export-report";
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
  | {
      readonly ok: true;
      readonly completion: ConfigExportCompletion;
      readonly corporateCaOmitted?: true;
      readonly omissions: readonly ExportOmission[];
    }
  | { readonly ok: false; readonly failure: ConfigExportFailure };

/**
 * The report is comments only, so specDigest is unchanged. documentDigest covers the bytes written,
 * header included, so it matches a digest of the file.
 */
function withReportHeader(
  config: V1Alpha1Export,
  omissions: readonly ExportOmission[],
  yaml: string,
): string {
  return renderExportReportHeader(omissions, config.spec.gateway.target.docker.port) + yaml;
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
  const omissions = exportOmissions(observation.source);
  const omittedCa = {
    ...(observation.corporateCaOmitted ? { corporateCaOmitted: true as const } : {}),
    omissions,
  };
  const yaml = withReportHeader(config, omissions, rendered.yaml);

  if (request.target.kind === "stdout") {
    try {
      await dependencies.writeStdout(yaml);
      return { ok: true, completion: { kind: "stdout" }, ...omittedCa };
    } catch {
      return {
        ok: false,
        failure: { kind: "output", target: "stdout", category: "unsafe-output" },
      };
    }
  }

  const { outputPath, force } = request.target;
  const published = dependencies.publish(outputPath, yaml, force);
  if (!published.ok) {
    return { ok: false, failure: { kind: "output", target: "file", ...published.failure } };
  }
  return {
    ok: true,
    ...omittedCa,
    completion: {
      kind: "file",
      result: {
        version: CONFIG_EXPORT_RESULT_VERSION,
        status: "succeeded",
        sourceSandbox: request.sandboxName,
        outputPath: published.outputPath,
        documentDigest: "sha256:" + createHash("sha256").update(yaml, "utf8").digest("hex"),
        specDigest: rendered.specDigest,
      },
    },
  };
}
