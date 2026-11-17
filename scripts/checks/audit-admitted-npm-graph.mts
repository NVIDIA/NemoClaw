// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  auditReviewedNpmGraphs,
  readTrustedAuditConfig,
  reportReviewedAuditFailure,
} from "../audit-reviewed-npm-graph.mts";
import { auditWithApprovedOpenShellSdk } from "./candidate-openshell-sdk.mts";
import { githubRequest } from "../../tools/e2e/base-image-publication.mts";

async function main(): Promise<void> {
  // Only the controller retains API access; npm children must never inherit it.
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  let stage: string | undefined = "configuration";
  try {
    const trusted = readTrustedAuditConfig();
    stage = "sdk-admission";
    await auditWithApprovedOpenShellSdk(
      process.env.NEMOCLAW_REVIEWED_NPM_AUDIT_TARGET_ROOT ?? resolve(import.meta.dirname, "../.."),
      {
        prNumber: Number(process.env.UPGRADE_PR_NUMBER),
        candidateSha: process.env.CHECKOUT_SHA ?? "",
        baseSha: process.env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_BASE_SHA ?? "",
      },
      (url) => {
        if (!token)
          throw new Error("Candidate SDK audit admission requires authenticated GitHub access");
        return githubRequest(url, token);
      },
      JSON.stringify(trusted),
      (config) => {
        stage = undefined;
        auditReviewedNpmGraphs(config);
        stage = "sdk-admission";
      },
    );
  } catch (error) {
    reportReviewedAuditFailure(error, stage);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
