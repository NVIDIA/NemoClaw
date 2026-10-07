// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";
import { validateStandardProfileWorkflowBoundary } from "../../../tools/e2e/standard-profile-workflow-boundary.mts";
import {
  FIXED_HOSTED_PLAN_SCRIPT,
  FIXED_HOSTED_RUN_SCRIPT,
  FIXED_HOSTED_QUALIFICATIONS,
  validateFixedHostedSelection,
} from "../../../tools/e2e/fixed-hosted-qualification.mts";
import {
  buildE2eWorkflowPlan,
  releaseRequiredWorkflowJobs,
} from "../../../tools/e2e/workflow-plan.mts";
import { catalogueTargetsForChangedFiles } from "../../../tools/e2e/target-catalogue.mts";

const explicit = { hostedModel: "approved/model", eventName: "workflow_dispatch" };

describe("fixed hosted qualification planning", () => {
  it.each(FIXED_HOSTED_QUALIFICATIONS)(
    "selects only the requested protocol representative [$id]",
    ({ id, agent }) => {
      const plan = buildE2eWorkflowPlan({ targets: id }, explicit);
      expect(plan.catalogueMatrices["fixed-hosted"]).toMatchObject([
        { id, agent_runtime: agent, runtime_provider: "docker" },
      ]);
      expect(plan.catalogueMatrices["fixed-hosted"]).toHaveLength(1);
    },
  );

  it("keeps explicit qualification out of default, shared-change and release inventory", () => {
    expect(buildE2eWorkflowPlan().catalogueMatrices["fixed-hosted"]).toEqual([]);
    expect(
      catalogueTargetsForChangedFiles(["tools/e2e/target-catalogue.mts"]).some(
        (row) => row.profile === "fixed-hosted",
      ),
    ).toBe(false);
    expect(releaseRequiredWorkflowJobs()).not.toContain("catalogue-fixed-hosted");
    expect(
      buildE2eWorkflowPlan({ targets: "hermes-inference-switch" }).catalogueMatrices[
        "fixed-hosted"
      ],
    ).toEqual([]);
  });

  it("rejects missing models, automatic selection and mixed selections before planning work", () => {
    const id = FIXED_HOSTED_QUALIFICATIONS[0].id;
    expect(() => buildE2eWorkflowPlan({ targets: id })).toThrow(/manual/);
    expect(() => buildE2eWorkflowPlan({ targets: id }, { eventName: "workflow_dispatch" })).toThrow(
      /model/,
    );
    expect(() => buildE2eWorkflowPlan({ targets: id }, { ...explicit, eventName: "push" })).toThrow(
      /manual/,
    );
    expect(() =>
      buildE2eWorkflowPlan({ targets: `${id},hermes-inference-switch` }, explicit),
    ).toThrow(/one explicitly/);
    expect(() =>
      buildE2eWorkflowPlan({ targets: id }, { ...explicit, gatewayRuntimes: ["podman"] }),
    ).toThrow(/does not support/);
    expect(() => validateFixedHostedSelection(["unknown"], "model", "workflow_dispatch")).toThrow(
      /requires one/,
    );
    expect(() =>
      buildE2eWorkflowPlan({ targets: id }, { ...explicit, hostedModel: "$(leak)" }),
    ).toThrow(/model/);
  });

  it("rejects credential crossover in the trusted caller", () => {
    const workflow = readWorkflow();
    (workflow.jobs as Record<string, { secrets: Record<string, string> }>)[
      "catalogue-fixed-hosted"
    ]!.secrets.HOSTED_PROVIDER_API_KEY = "${{ secrets.NVIDIA_API_KEY }}";
    expect(validateStandardProfileWorkflowBoundary(workflow)).toContain(
      "catalogue-fixed-hosted must receive only its profile secrets",
    );
  });

  it("exports only the selected credential and removes the transport alias without logging values", () => {
    const credential = "fake-selected-provider-key";
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
${FIXED_HOSTED_RUN_SCRIPT}
[[ "$OPENAI_API_KEY" == "fake-selected-provider-key" ]]
[[ -z "\${HOSTED_PROVIDER_API_KEY+x}" ]]
[[ -z "\${ANTHROPIC_API_KEY+x}" && -z "\${NOUS_API_KEY+x}" && -z "\${NVIDIA_API_KEY+x}" && -z "\${OPENROUTER_API_KEY+x}" ]]
[[ "$NEMOCLAW_SWITCH_MODEL" == "approved/model" ]]
`,
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOSTED_CREDENTIAL_NAME: "OPENAI_API_KEY",
          HOSTED_PROVIDER_API_KEY: credential,
          HOSTED_MODEL: "approved/model",
        },
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(credential);
    const missing = spawnSync("bash", ["-c", `set -euo pipefail\n${FIXED_HOSTED_RUN_SCRIPT}`], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOSTED_CREDENTIAL_NAME: "OPENAI_API_KEY",
        HOSTED_PROVIDER_API_KEY: "",
        HOSTED_MODEL: "approved/model",
      },
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("Selected hosted provider credential is unavailable");
  });

  it.each(FIXED_HOSTED_QUALIFICATIONS)(
    "derives credentials before checkout without accepting candidate metadata [$id]",
    (selection) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixed-hosted-plan-"));
      try {
        const output = path.join(directory, "outputs");
        const result = spawnSync(
          "bash",
          ["-c", `set -euo pipefail\nfail() { exit 17; }\n${FIXED_HOSTED_PLAN_SCRIPT}`],
          {
            encoding: "utf8",
            env: {
              PATH: process.env.PATH,
              CATALOGUE_ID: selection.id,
              TARGET_ID: `${selection.agent}-inference-switch`,
              TEST_FILE: `test/e2e/live/${selection.agent}-inference-switch.test.ts`,
              SHARD: selection.provider,
              HOSTED_MODEL: "approved/model",
              RUNTIME_PROVIDER: "docker",
              GITHUB_OUTPUT: output,
              HOSTED_CREDENTIAL_NAME: "ATTACKER_SECRET",
              NEMOCLAW_SWITCH_PROVIDER: "attacker",
            },
          },
        );
        expect(result.status).toBe(0);
        expect(fs.readFileSync(output, "utf8")).toBe(`hosted_credential=${selection.credential}\n`);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { scenario: "target mismatch", override: { TARGET_ID: "hermes-e2e" } },
    { scenario: "test file mismatch", override: { TEST_FILE: "test/e2e/live/hermes-e2e.test.ts" } },
    { scenario: "shard mismatch", override: { SHARD: "nvidia-prod" } },
    { scenario: "missing model", override: { HOSTED_MODEL: "" } },
    { scenario: "unsafe model", override: { HOSTED_MODEL: "model\nATTACKER=value" } },
    { scenario: "unknown target", override: { CATALOGUE_ID: "unknown" } },
  ])("refuses invalid qualification metadata [$scenario]", ({ override }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fixed-hosted-denial-"));
    try {
      const result = spawnSync(
        "bash",
        ["-c", `set -euo pipefail\nfail() { exit 17; }\n${FIXED_HOSTED_PLAN_SCRIPT}`],
        {
          env: {
            PATH: process.env.PATH,
            CATALOGUE_ID: FIXED_HOSTED_QUALIFICATIONS[0].id,
            TARGET_ID: "hermes-inference-switch",
            TEST_FILE: "test/e2e/live/hermes-inference-switch.test.ts",
            SHARD: "hermes-provider",
            HOSTED_MODEL: "approved/model",
            RUNTIME_PROVIDER: "docker",
            GITHUB_OUTPUT: path.join(directory, "outputs"),
            ...override,
          },
        },
      );
      expect(result.status).toBe(17);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
