// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const WORKFLOW_PATH = path.resolve(
  import.meta.dirname,
  "../.github/workflows/codebase-growth-guardrails.yaml",
);

describe("codebase growth guardrails workflow trust boundary", () => {
  // source-shape-contract: security -- The pull_request_target guardrail must run only the trusted base test and treat pull request files as data
  it("runs the trusted Vitest guardrails against pull request data", () => {
    const workflow = YAML.parse(readFileSync(WORKFLOW_PATH, "utf8"));

    expect(workflow).toEqual({
      name: "CI / Codebase Growth Guardrails",
      on: {
        pull_request_target: {
          types: ["opened", "reopened", "synchronize", "ready_for_review"],
        },
      },
      permissions: { contents: "read", "pull-requests": "read" },
      jobs: {
        "codebase-growth-guardrails": {
          name: "codebase-growth-guardrails",
          "runs-on": "ubuntu-latest",
          "timeout-minutes": 5,
          steps: [
            {
              name: "Check out the trusted base revision",
              uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
              with: {
                ref: "${{ github.event.pull_request.base.sha }}",
                "persist-credentials": false,
              },
            },
            {
              name: "Install trusted dependencies",
              run: "npm ci --ignore-scripts --no-audit --no-fund",
            },
            {
              name: "Test codebase growth guardrails",
              env: {
                NEMOCLAW_GROWTH_PR: "1",
                GH_TOKEN: "${{ github.token }}",
                PR_NUMBER: "${{ github.event.pull_request.number }}",
                REPO: "${{ github.repository }}",
                BASE_SHA: "${{ github.event.pull_request.base.sha }}",
                HEAD_REPO: "${{ github.event.pull_request.head.repo.full_name }}",
                HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
              },
              run: "set -euo pipefail\nnpx vitest run --project integration test/growth-guardrails.test.ts\n",
            },
          ],
        },
      },
    });
  });
});
