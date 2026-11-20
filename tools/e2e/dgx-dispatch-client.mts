// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";
import {
  DGX_STATION_DISPATCH_AUDIENCE,
  DGX_STATION_DISPATCH_TARGET,
  DGX_SPARK_DISPATCH_AUDIENCE,
  DGX_SPARK_DISPATCH_TARGET,
  parseDgxStationDispatchRequest,
  parseDgxSparkDispatchRequest,
} from "./jetson-dispatch-contract.mts";
import {
  createGitHubOidcTokenProvider,
  dispatcherBaseUrl,
  dispatcherRequest,
  runDispatchClient,
  printableDispatchError,
} from "./jetson-dispatch-client.mts";

const DGX_DISPATCH = {
  [DGX_STATION_DISPATCH_TARGET]: {
    schemaVersion: 3,
    audience: DGX_STATION_DISPATCH_AUDIENCE,
    prefix: "DGX_STATION_DISPATCH",
    waitMs: 54 * 60_000,
    receiptName: "dgx-station-dispatch.json",
    archiveName: "dgx-station-e2e-artifacts.tar.gz",
    parseRequest: parseDgxStationDispatchRequest,
  },
  [DGX_SPARK_DISPATCH_TARGET]: {
    schemaVersion: 4,
    audience: DGX_SPARK_DISPATCH_AUDIENCE,
    prefix: "DGX_SPARK_DISPATCH",
    waitMs: 90 * 60_000,
    receiptName: "dgx-spark-dispatch.json",
    archiveName: "dgx-spark-e2e-artifacts.tar.gz",
    parseRequest: parseDgxSparkDispatchRequest,
  },
} as const;

export function dgxDispatchOptionsFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const target = environment.E2E_TARGET_ID;
  if (target !== DGX_STATION_DISPATCH_TARGET && target !== DGX_SPARK_DISPATCH_TARGET) {
    throw new Error("E2E_TARGET_ID must select dgx-station-express or spark-vllm-extra-arguments");
  }
  const config = DGX_DISPATCH[target];
  return {
    request: config.parseRequest({
      schemaVersion: config.schemaVersion,
      target,
      candidateSha: environment[`${config.prefix}_CANDIDATE_SHA`],
      managedImageRevision: environment[`${config.prefix}_MANAGED_IMAGE_REVISION`],
      workflowRunId: environment.GITHUB_RUN_ID,
      workflowRunAttempt: Number(environment.GITHUB_RUN_ATTEMPT),
    }),
    audience: config.audience,
    baseUrl: dispatcherBaseUrl(environment[`${config.prefix}_URL`], `${config.prefix}_URL`),
    artifactDirectory: environment.E2E_ARTIFACT_DIR ?? "",
    waitMs: config.waitMs,
    receiptName: config.receiptName,
    archiveName: config.archiveName,
  };
}

async function main(): Promise<void> {
  const { audience, ...options } = dgxDispatchOptionsFromEnvironment();
  const tokenProvider = createGitHubOidcTokenProvider({ audience });
  await runDispatchClient({
    ...options,
    requestImpl: (request) => dispatcherRequest({ ...request, tokenProvider }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(printableDispatchError(error));
    process.exitCode = 1;
  });
}
