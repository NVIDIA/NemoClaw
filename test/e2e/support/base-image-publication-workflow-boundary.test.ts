// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  type OperationsWorkflow,
  validateBaseImagePublicationGate,
} from "../../../tools/e2e/operations-workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type MutableStep = {
  env?: Record<string, unknown>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type MutableJob = Record<string, unknown> & {
  env?: Record<string, unknown>;
  needs?: unknown;
  outputs?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  steps?: MutableStep[];
};

type MutableWorkflow = {
  jobs: Record<string, MutableJob>;
};

function workflow(): MutableWorkflow {
  return structuredClone(readWorkflow()) as MutableWorkflow;
}

function validate(value: MutableWorkflow): string[] {
  return validateBaseImagePublicationGate(value as unknown as OperationsWorkflow);
}

function required<T>(value: T | undefined, message: string): T {
  return (
    value ??
    (() => {
      throw new Error(message);
    })()
  );
}

function gateSteps(value: MutableWorkflow): MutableStep[] {
  return required(
    value.jobs["base-image-publication"]?.steps,
    "base-image-publication test fixture is missing steps",
  );
}

function gateStep(value: MutableWorkflow, name: string): MutableStep {
  return required(
    gateSteps(value).find((step) => step.name === name),
    `base-image-publication test fixture is missing step ${name}`,
  );
}

function runClassifier(environment: {
  checkoutSha: string;
  eventName: string;
  ref: string;
  repository: string;
}): { output: string; status: number | null } {
  const source = required(
    gateSteps(workflow())[0]?.run,
    "publication classifier fixture is missing its script",
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-publication-mode-"));
  const outputPath = path.join(directory, "github-output");
  try {
    const result = spawnSync("/bin/bash", ["-c", source], {
      encoding: "utf8",
      env: {
        CHECKOUT_SHA: environment.checkoutSha,
        EVENT_NAME: environment.eventName,
        GITHUB_OUTPUT: outputPath,
        REF: environment.ref,
        REPOSITORY: environment.repository,
      },
    });
    return {
      output: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "",
      status: result.status,
    };
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

describe("base-image publication workflow boundary (#7372)", () => {
  it("keeps Launchable off the base-image publication critical path", () => {
    const value = workflow();

    expect(validate(value)).toEqual([]);
  });

  it.each([
    ["push to main", "push", "", "refs/heads/main", "1", "0"],
    ["manual main", "workflow_dispatch", "", "refs/heads/main", "1", "0"],
    [
      "controller-selected PR",
      "workflow_dispatch",
      "a".repeat(40),
      "refs/heads/candidate",
      "0",
      "1",
    ],
    [
      "pinned a4f9b59 diagnostic",
      "workflow_dispatch",
      "a4f9b59aa64f88532a3e64e949dd1b4068aa1f1e",
      "refs/heads/candidate",
      "0",
      "1",
    ],
  ])(
    "classifies %s without executing untrusted code (#7372)",
    (_case, eventName, checkoutSha, ref, required, reuse) => {
      expect(
        runClassifier({
          checkoutSha,
          eventName,
          ref,
          repository: "NVIDIA/NemoClaw",
        }),
      ).toEqual({ output: `required=${required}\nreuse=${reuse}\n`, status: 0 });
    },
  );

  it.each([
    ["a fork", "push", "", "refs/heads/main", "attacker/NemoClaw"],
    ["a non-main ref", "push", "", "refs/heads/release", "NVIDIA/NemoClaw"],
    ["an unexpected event", "pull_request", "", "refs/heads/main", "NVIDIA/NemoClaw"],
    [
      "a push with a controller checkout",
      "push",
      "a".repeat(40),
      "refs/heads/main",
      "NVIDIA/NemoClaw",
    ],
  ])(
    "rejects %s instead of skipping the gate (#7372)",
    (_case, eventName, checkoutSha, ref, repository) => {
      expect(runClassifier({ checkoutSha, eventName, ref, repository }).status).not.toBe(0);
    },
  );

  const mutations: Array<[string, (value: MutableWorkflow) => void]> = [
    ["runner size", (value) => (value.jobs["base-image-publication"]["runs-on"] = "self-hosted")],
    ["timeout", (value) => (value.jobs["base-image-publication"]["timeout-minutes"] = 60)],
    [
      "permissions",
      (value) => {
        value.jobs["base-image-publication"].permissions!.actions = "write";
      },
    ],
    [
      "failure tolerance",
      (value) => (value.jobs["base-image-publication"]["continue-on-error"] = true),
    ],
    [
      "classifier context",
      (value) => {
        gateSteps(value)[0].env!.REPOSITORY = "${{ github.actor }}";
      },
    ],
    [
      "classifier outcome",
      (value) => {
        gateSteps(value)[0].run = gateSteps(value)[0].run!.replace("required=1", "required=0");
      },
    ],
    ["checkout condition", (value) => (gateSteps(value)[1].if = "${{ always() }}")],
    ["checkout pin", (value) => (gateSteps(value)[1].uses = "actions/checkout@v6")],
    [
      "candidate checkout ref",
      (value) => (gateSteps(value)[1].with!.ref = "${{ inputs.checkout_sha }}"),
    ],
    ["checkout history", (value) => (gateSteps(value)[1].with!["fetch-depth"] = 1)],
    ["checkout credentials", (value) => (gateSteps(value)[1].with!["persist-credentials"] = true)],
    ["Node condition", (value) => (gateSteps(value)[2].if = "${{ always() }}")],
    ["Node pin", (value) => (gateSteps(value)[2].uses = "actions/setup-node@v6")],
    ["Node version", (value) => (gateSteps(value)[2].with!["node-version"] = 20)],
    [
      "pairing condition",
      (value) =>
        (gateStep(
          value,
          "Resolve Deep Agents Code base publication for the exact PR managed image",
        ).if = "${{ always() }}"),
    ],
    [
      "pairing catalog",
      (value) =>
        (gateStep(
          value,
          "Resolve Deep Agents Code base publication for the exact PR managed image",
        ).env!["MANAGED_IMAGE_CATALOG"] = "${{ inputs.catalog }}"),
    ],
    [
      "pairing verifier",
      (value) =>
        (gateStep(
          value,
          "Resolve Deep Agents Code base publication for the exact PR managed image",
        ).run = "node unreviewed.mts"),
    ],
    [
      "verifier condition",
      (value) =>
        (gateStep(value, "Verify applicable base-image publication").if = "${{ always() }}"),
    ],
    [
      "verifier token",
      (value) =>
        (gateStep(value, "Verify applicable base-image publication").env!.GITHUB_TOKEN =
          "${{ secrets.TOKEN }}"),
    ],
    [
      "verifier SHA",
      (value) =>
        (gateStep(value, "Verify applicable base-image publication").env!.EXPECTED_SHA =
          "${{ inputs.checkout_sha }}"),
    ],
    [
      "managed-image publication requirement",
      (value) =>
        (gateStep(value, "Verify applicable base-image publication").env![
          "REQUIRE_MANAGED_IMAGE_PUBLICATION"
        ] = "0"),
    ],
    [
      "verifier command",
      (value) => {
        gateStep(value, "Verify applicable base-image publication").run =
          "node tools/e2e/base-image-publication.mts";
      },
    ],
    [
      "contract download command",
      (value) =>
        (gateStep(value, "Download immutable Deep Agents Code base contract").run =
          "node unreviewed.mts"),
    ],
    [
      "contract run binding",
      (value) =>
        (gateStep(value, "Download immutable Deep Agents Code base contract").env![
          "PUBLICATION_RUN_ID"
        ] = "${{ github.run_id }}"),
    ],
    [
      "contract validation",
      (value) =>
        (gateStep(value, "Validate immutable Deep Agents Code base").run =
          "node tools/e2e/dcode-base-image-contract.mts contract.json"),
    ],
    ["step count", (value) => gateSteps(value).push({ name: "Unreviewed step", run: "true" })],
    ["publication matrix dependency", (value) => delete value.jobs["base-image-publication"].needs],
    [
      "matrix publication dependency",
      (value) => (value.jobs["generate-matrix"].needs = "base-image-publication"),
    ],
    ["live publication dependency", (value) => (value.jobs.live.needs = ["generate-matrix"])],
    [
      "live managed-image revision",
      (value) => (value.jobs.live.env!.E2E_MANAGED_IMAGE_REVISION = "${{ github.sha }}"),
    ],
    [
      "cloud-onboard publication dependency",
      (value) => (value.jobs["cloud-onboard"].needs = ["generate-matrix"]),
    ],
    [
      "cloud-onboard managed-image revision",
      (value) =>
        (value.jobs["cloud-onboard"].env!.E2E_MANAGED_IMAGE_REVISION = "${{ github.sha }}"),
    ],
    [
      "Launchable publication dependency",
      (value) =>
        (value.jobs["staging-brev-launchable"].needs = [
          "base-image-publication",
          "generate-matrix",
        ]),
    ],
    [
      "Launchable identity publication dependency",
      (value) =>
        (value.jobs["staging-brev-launchable-identity"].needs = [
          "base-image-publication",
          "generate-matrix",
        ]),
    ],
    [
      "matrix base output",
      (value) => {
        (value.jobs["generate-matrix"].outputs as Record<string, unknown>).dcode_base_ref =
          "${{ inputs.base_ref }}";
      },
    ],
    [
      "live mutable base",
      (value) => {
        value.jobs.live.env!.NEMOCLAW_LANGCHAIN_DEEPAGENTS_CODE_SANDBOX_BASE_IMAGE_REF =
          "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base:latest";
      },
    ],
    [
      "live base evidence ordering",
      (value) => {
        const steps = value.jobs.live.steps!;
        const evidence = steps.find(
          (step) => step.name === "Record immutable Deep Agents Code base evidence",
        )!;
        steps.splice(steps.indexOf(evidence), 1);
        steps.push(evidence);
      },
    ],
    [
      "live base evidence upload",
      (value) => {
        const upload = value.jobs.live.steps!.find((step) => step.name === "Upload E2E artifacts")!;
        upload.with!.path = String(upload.with!.path).replace(
          "e2e-artifacts/live/${{ matrix.id }}/dcode-base-image.json\n",
          "",
        );
      },
    ],
  ];

  it.each(mutations)("rejects %s drift (#7372)", (_case, mutate) => {
    const value = workflow();
    mutate(value);
    expect(validate(value)).not.toEqual([]);
  });
});
