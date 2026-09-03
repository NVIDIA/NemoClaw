// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { NemoClawConfig } from "./model";
import type { ObservedExportSource } from "./export-observation";
import type { PublishExportFileResult } from "./output";

export const CONFIG_EXPORT_RESULT_VERSION = 1 as const;

export interface ConfigExportRequest {
  readonly sandboxName: string;
  readonly documentName: string;
  readonly output: string;
  readonly force: boolean;
  readonly json: boolean;
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
  readonly observe: (sandboxName: string) => Promise<ObservedExportSource>;
  readonly buildConfig: (observation: ObservedExportSource, documentName: string) => NemoClawConfig;
  readonly render: (config: NemoClawConfig) => {
    yaml: string;
    documentDigest: string;
    specDigest: string;
  };
  readonly publish: (path: string, contents: string, force: boolean) => PublishExportFileResult;
  readonly writeStdout: (contents: string) => void;
}

export class ConfigExportInputError extends Error {
  readonly category = "output-conflict" as const;
}

export async function runConfigExport(
  request: ConfigExportRequest,
  dependencies: ConfigExportDependencies,
): Promise<ConfigExportResult | undefined> {
  if (request.json && request.output === "-") {
    throw new ConfigExportInputError("--json cannot be used when --output is stdout (-).");
  }

  const observation = await dependencies.observe(request.sandboxName);
  const config = dependencies.buildConfig(observation, request.documentName);
  const rendered = dependencies.render(config);

  if (request.output === "-") {
    dependencies.writeStdout(rendered.yaml);
    return undefined;
  }

  const published = dependencies.publish(request.output, rendered.yaml, request.force);
  return {
    version: CONFIG_EXPORT_RESULT_VERSION,
    status: "succeeded",
    sourceSandbox: request.sandboxName,
    outputPath: published.path,
    documentDigest: rendered.documentDigest,
    specDigest: rendered.specDigest,
  };
}
