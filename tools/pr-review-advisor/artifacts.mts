// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export type ArtifactPaths = {
  result: string;
  finalResult: string;
  findingLedger: string;
  terminologyLedger: string;
  summary: string;
  sessionHtml: string;
};

export function artifactPaths(outDir: string): ArtifactPaths {
  return {
    result: path.join(outDir, "pr-review-advisor-result.json"),
    finalResult: path.join(outDir, "pr-review-advisor-final-result.json"),
    findingLedger: path.join(outDir, "pr-review-advisor-finding-ledger.json"),
    terminologyLedger: path.join(outDir, "pr-review-advisor-terminology-ledger.json"),
    summary: path.join(outDir, "pr-review-advisor-summary.md"),
    sessionHtml: path.join(outDir, "pr-review-advisor-session.html"),
  };
}
