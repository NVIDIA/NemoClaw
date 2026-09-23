// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  discoverCredentialFreeTests,
  stripCredentialFreeTestDeclarations,
} from "../../../tools/e2e/credential-free-tests.mts";
import {
  validateE2eWorkflowBoundary,
  validateNativePodmanStagingAction,
} from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";
import { testTimeoutOptions } from "../../helpers/timeouts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

type Workflow = {
  jobs: Record<
    string,
    {
      env?: Record<string, unknown>;
      needs?: string[];
      "continue-on-error"?: unknown;
      steps?: Array<{
        name?: string;
        uses?: string;
        run?: string;
        if?: unknown;
        "continue-on-error"?: unknown;
        with?: Record<string, unknown>;
      }>;
    }
  >;
};

function validateMutatedWorkflow(mutator: (workflow: Workflow) => void): string[] {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shared-e2e-workflow-"));
  const workflowPath = path.join(directory, "workflow.yaml");
  const workflow = readWorkflow() as Workflow;
  try {
    mutator(workflow);
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));
    return validateE2eWorkflowBoundary(workflowPath);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

type WorkflowSteps = NonNullable<Workflow["jobs"][string]["steps"]>;

function moveStagingAfter(steps: WorkflowSteps, index: number, boundary: string): void {
  const [step] = steps.splice(index, 1);
  steps.splice(steps.findIndex((candidate) => candidate.name === boundary) + 1, 0, step!);
}

const stagingMutations: Array<[string, (steps: WorkflowSteps, index: number) => void]> = [
  [
    "renamed",
    (steps, index) => {
      steps[index]!.name = "Different name";
    },
  ],
  ["duplicate-renamed", (steps, index) => steps.push({ ...steps[index]!, name: "Second staging" })],
  [
    "duplicate-unreviewed-renamed",
    (steps, index) =>
      steps.push({
        ...steps[index]!,
        name: "Second staging",
        uses: steps[index]!.uses!.split("@")[0] + "@" + "0".repeat(40),
      }),
  ],
  [
    "missing",
    (steps, index) => {
      steps.splice(index, 1);
    },
  ],
  [
    "reference",
    (steps, index) => {
      steps[index]!.uses =
        "NVIDIA/NemoClaw/.github/actions/stage-native-podman-e2e-toolchains@" + "0".repeat(40);
    },
  ],
  ["checkout-order", (steps, index) => moveStagingAfter(steps, index, "Check out E2E candidate")],
  ["prepare-order", (steps, index) => moveStagingAfter(steps, index, "Prepare E2E workspace")],
  [
    "disabled",
    (steps, index) => {
      steps[index]!.if = false;
    },
  ],
  [
    "ignore-errors",
    (steps, index) => {
      steps[index]!["continue-on-error"] = true;
    },
  ],
  [
    "enabled-input",
    (steps, index) => {
      steps[index]!.with!.enabled = "false";
    },
  ],
  [
    "token-input",
    (steps, index) => {
      steps[index]!.with!["github-token"] = "";
    },
  ],
];

const actionMutations: Array<[string, (source: string) => string]> = [
  ["artifact-id", (source) => source.replace('artifact-ids: "10385514729"', 'artifact-ids: "1"')],
  ["digest", (source) => source.replace(/sha256:[a-f0-9]{64}/, "sha256:" + "0".repeat(64))],
  ["source-run", (source) => source.replace('run-id: "33211526093"', 'run-id: "1"')],
  [
    "verification-order",
    (source) => {
      const start = source.indexOf("    - name: Verify immutable");
      const end = source.indexOf("    - name: Download immutable");
      return source.slice(0, start) + source.slice(end) + source.slice(start, end);
    },
  ],
];

describe("shared E2E workflow boundary", () => {
  it.each([true, false, "${{ always() }}"])(
    "rejects generate-matrix continue-on-error=%s",
    (value) => {
      const errors = validateMutatedWorkflow((workflow) => {
        workflow.jobs["generate-matrix"]["continue-on-error"] = value;
      });
      expect(errors).toContain(
        "native Podman staging must preserve runtime selection, token, and fail-closed execution",
      );
    },
  );

  it.each(stagingMutations)("rejects native Podman staging %s mutations", (_name, mutate) => {
    const errors = validateMutatedWorkflow((workflow) => {
      const steps = workflow.jobs["generate-matrix"].steps!;
      const index = steps.findIndex(
        (step) => step.name === "Stage immutable native Podman E2E toolchains",
      );
      mutate(steps, index);
    });
    expect(errors.some((error) => error.includes("native Podman staging"))).toBe(true);
  });

  it.each(actionMutations)("rejects native Podman staging action %s mutations", (_name, mutate) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-staging-"));
    const actionPath = path.join(directory, "action.yaml");
    const reviewedPath = path.resolve(
      ".github/actions/stage-native-podman-e2e-toolchains/action.yaml",
    );
    const source = fs.readFileSync(reviewedPath, "utf8");
    try {
      expect(validateNativePodmanStagingAction()).toEqual([]);
      const mutated = mutate(source);
      fs.writeFileSync(actionPath, mutated);
      expect(validateNativePodmanStagingAction(actionPath)).toContain(
        "native Podman staging action content must match its immutable commit pin",
      );
      const overrides = new Map([[reviewedPath, mutated]]);
      vi.mocked(readFileSync).mockImplementation(
        (file, options) => overrides.get(String(file)) ?? fs.readFileSync(file, options),
      );
      expect(validateE2eWorkflowBoundary()).toContain(
        "native Podman staging action content must match its immutable commit pin",
      );
    } finally {
      vi.mocked(readFileSync).mockImplementation(fs.readFileSync);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["22.19.0", "jetson-nvmap-gpu", "Set up Node for Jetson controller"],
    ["22.19.0", "generate-matrix", "Set up Node for trusted E2E planning"],
    ["22.19.0", "base-image-publication", "Set up Node for publication verification"],
    ["22.19.0", "hermes-gpu-startup", "Reassert trusted Node runtime"],
    ["^22.19.0", "jetson-nvmap-gpu", "Set up Node for Jetson controller"],
    ["^22.19.0", "generate-matrix", "Set up Node for trusted E2E planning"],
    ["^22.19.0", "base-image-publication", "Set up Node for publication verification"],
    ["^22.19.0", "hermes-gpu-startup", "Reassert trusted Node runtime"],
  ])("accepts the compatible Node selector %s in %s (%s)", (version, job, stepName) => {
    const errors = validateMutatedWorkflow((workflow) => {
      const step = workflow.jobs[job].steps!.find((candidate) => candidate.name === stepName)!;
      step.with!["node-version"] = version;
    });
    expect(errors).toEqual([]);
  });

  it(
    "keeps every tagged credential-free test visible to Vitest discovery",
    testTimeoutOptions(15_000),
    () => {
      const declaredFiles = fs
        .globSync(["**/*.test.js", "**/*.test.ts"], {
          cwd: process.cwd(),
          exclude: ["**/dist/**", "**/node_modules/**"],
        })
        .filter((file) => {
          const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
          return stripCredentialFreeTestDeclarations(source) !== source;
        })
        .sort();

      expect(
        discoverCredentialFreeTests()
          .map(({ file }) => file)
          .sort(),
      ).toEqual(declaredFiles);
    },
  );

  it("ratchets shared setup, tagged test execution, and aggregation", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      const job = workflow.jobs["shared-e2e"];
      job.env!.CHECK_DOC_LINKS_REMOTE = "1";
      job.steps!.find((step) => step.name === "Run tagged credential-free test")!.run =
        "echo skipped";
      workflow.jobs["report-to-pr"].needs = workflow.jobs["report-to-pr"].needs!.filter(
        (name) => name !== "shared-e2e",
      );
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "shared E2E job must set CHECK_DOC_LINKS_REMOTE to 0",
        'step \'Run tagged credential-free test\' run script must include npx vitest run --project "${TEST_PROJECT}" "${TEST_FILE}"',
        "step 'Run tagged credential-free test' run script must include --tags-filter=e2e/credential-free",
        "report-to-pr job must wait for shared-e2e",
      ]),
    );
  });

  it("reports a missing shared job as a contract error", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      delete workflow.jobs["shared-e2e"];
    });

    expect(errors).toContain("workflow missing shared E2E job");
  });
});
