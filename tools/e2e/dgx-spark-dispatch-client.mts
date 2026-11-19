// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";
import {
  DGX_SPARK_DISPATCH_AUDIENCE,
  DGX_SPARK_DISPATCH_TARGET,
  parseDgxSparkDispatchRequest,
} from "./jetson-dispatch-contract.mts";
import {
  createGitHubOidcTokenProvider,
  dispatcherBaseUrl,
  dispatcherRequest,
  runDispatchClient,
  printableDispatchError,
} from "./jetson-dispatch-client.mts";

export function dgxSparkDispatchRequestFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return parseDgxSparkDispatchRequest({
    schemaVersion: 4,
    target: DGX_SPARK_DISPATCH_TARGET,
    candidateSha: environment.DGX_SPARK_DISPATCH_CANDIDATE_SHA,
    managedImageRevision: environment.DGX_SPARK_DISPATCH_MANAGED_IMAGE_REVISION,
    workflowRunId: environment.GITHUB_RUN_ID,
    workflowRunAttempt: Number(environment.GITHUB_RUN_ATTEMPT),
  });
}

async function main(): Promise<void> {
  const tokenProvider = createGitHubOidcTokenProvider({ audience: DGX_SPARK_DISPATCH_AUDIENCE });
  await runDispatchClient({
    request: dgxSparkDispatchRequestFromEnvironment(),
    waitMs: 90 * 60_000,
    baseUrl: dispatcherBaseUrl(process.env.DGX_SPARK_DISPATCH_URL, "DGX_SPARK_DISPATCH_URL"),
    artifactDirectory: process.env.E2E_ARTIFACT_DIR ?? "",
    receiptName: "dgx-spark-dispatch.json",
    archiveName: "dgx-spark-e2e-artifacts.tar.gz",
    requestImpl: (options) => dispatcherRequest({ ...options, tokenProvider }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(printableDispatchError(error));
    process.exitCode = 1;
  });
}
