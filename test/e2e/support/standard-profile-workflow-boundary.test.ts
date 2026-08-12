// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { validateStandardProfileWorkflowBoundary } from "../../../tools/e2e/standard-profile-workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

describe("standard E2E execution profile boundary", () => {
  it("accepts the catalogue callers and reusable profile", () => {
    expect(validateStandardProfileWorkflowBoundary(readWorkflow())).toEqual([]);
  });

  it("rejects secret crossover between catalogue profiles", () => {
    const workflow = readWorkflow() as {
      jobs: Record<string, { secrets: Record<string, string> }>;
    };
    workflow.jobs["catalogue-standard"]!.secrets.NVIDIA_INFERENCE_API_KEY =
      "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";

    expect(validateStandardProfileWorkflowBoundary(workflow)).toContain(
      "catalogue-standard must receive only its profile secrets",
    );
  });

  it("rejects checkout, credential guard, target execution, and cleanup drift", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-standard-profile-"));
    const profilePath = path.join(tmp, "profile.yaml");
    const profile = YAML.parse(
      fs.readFileSync(
        path.join(process.cwd(), ".github/workflows/e2e-standard-profile.yaml"),
        "utf8",
      ),
    ) as {
      jobs: {
        run: {
          steps: Array<{
            if?: string;
            name?: string;
            run?: string;
            uses?: string;
            with?: Record<string, unknown>;
          }>;
        };
      };
    };
    const steps = profile.jobs.run.steps;
    const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"))!;
    checkout.uses = "actions/checkout@v7";
    checkout.with!["persist-credentials"] = true;
    const auth = steps.find((step) => step.name === "Authenticate to Docker Hub")!;
    auth.with!["auth-required"] = "1";
    const execute = steps.find((step) => step.name === "Run catalogue E2E target")!;
    execute.run = "npm test";
    const cleanup = steps.pop()!;
    steps.unshift(cleanup);
    fs.writeFileSync(profilePath, YAML.stringify(profile));

    try {
      expect(validateStandardProfileWorkflowBoundary(readWorkflow(), profilePath)).toEqual(
        expect.arrayContaining([
          "standard E2E profile checkout action must use a full commit SHA",
          "standard E2E profile must check out the exact candidate without credentials",
          "standard E2E profile Docker Hub auth-required must be guarded by trusted_main",
          "standard E2E profile must run the planned catalogue target with guarded secrets",
          "standard E2E profile must always clean up Docker authentication last",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
