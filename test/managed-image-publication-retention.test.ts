// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  publicationAgents,
  publicationPlatforms,
} from "./helpers/managed-image-publication-barrier";

type Workflow = {
  jobs?: {
    promote?: {
      steps?: Array<{
        uses?: string;
        with?: Record<string, unknown>;
      }>;
    };
  };
};

describe("managed-image publication evidence retention", () => {
  it("retains exact platform and aggregate cohort contracts for ninety days (#7744)", () => {
    const workflow = YAML.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname, "../.github/workflows/managed-images.yaml"),
        "utf8",
      ),
    ) as Workflow;
    const uploads = (workflow.jobs?.promote?.steps ?? [])
      .filter((candidate) => candidate.uses?.startsWith("actions/upload-artifact@"))
      .map((candidate) => candidate.with);

    expect(uploads).toEqual([
      {
        name: "managed-image-cohort-${{ github.run_id }}-${{ github.run_attempt }}",
        path: "${{ runner.temp }}/managed-image-contracts/cohort.json",
        "if-no-files-found": "error",
        "retention-days": 90,
      },
      ...publicationAgents.flatMap((agent) =>
        publicationPlatforms.map((platform) => {
          const artifactPlatform = platform.replaceAll("/", "-");
          return {
            name:
              "managed-image-${{ github.run_id }}-${{ github.run_attempt }}-" +
              `${agent}-${artifactPlatform}`,
            path: `\${{ runner.temp }}/managed-image-contracts/${agent}/${artifactPlatform}/contract.json`,
            "if-no-files-found": "error",
            "retention-days": 90,
          };
        }),
      ),
    ]);
  });
});
