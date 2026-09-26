// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { pathToFileURL } from "node:url";
import {
  DGX_STATION_DISPATCH_AUDIENCE,
  DGX_STATION_DISPATCH_TARGET,
  parseDgxStationDispatchRequest,
} from "./jetson-dispatch-contract.mts";
import {
  createGitHubOidcTokenProvider,
  dispatcherBaseUrl,
  dispatcherRequest,
  runDispatchClient,
  printableDispatchError,
} from "./jetson-dispatch-client.mts";

export function dgxStationDispatchRequestFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return parseDgxStationDispatchRequest({
    schemaVersion: 3,
    target: DGX_STATION_DISPATCH_TARGET,
    candidateSha: environment.DGX_STATION_DISPATCH_CANDIDATE_SHA,
    managedImageRevision: environment.DGX_STATION_DISPATCH_MANAGED_IMAGE_REVISION,
    workflowRunId: environment.GITHUB_RUN_ID,
    workflowRunAttempt: Number(environment.GITHUB_RUN_ATTEMPT),
  });
}

async function main(): Promise<void> {
  const tokenProvider = createGitHubOidcTokenProvider({ audience: DGX_STATION_DISPATCH_AUDIENCE });
  await runDispatchClient({
    request: dgxStationDispatchRequestFromEnvironment(),
    baseUrl: dispatcherBaseUrl(process.env.DGX_STATION_DISPATCH_URL, "DGX_STATION_DISPATCH_URL"),
    artifactDirectory: process.env.E2E_ARTIFACT_DIR ?? "",
    receiptName: "dgx-station-dispatch.json",
    archiveName: "dgx-station-e2e-artifacts.tar.gz",
    requestImpl: (options) => dispatcherRequest({ ...options, tokenProvider }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(printableDispatchError(error));
    process.exitCode = 1;
  });
}
