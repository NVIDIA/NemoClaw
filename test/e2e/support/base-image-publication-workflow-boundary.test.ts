// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

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
  needs?: unknown;
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
  it.each([
    ["scheduled main", "schedule", "", "1"],
    ["manual main", "workflow_dispatch", "", "1"],
    ["controller-selected PR", "workflow_dispatch", "a".repeat(40), "0"],
  ])("classifies %s without executing untrusted code (#7372)", (_case, eventName, checkoutSha, required) => {
    expect(
      runClassifier({
        checkoutSha,
        eventName,
        ref: "refs/heads/main",
        repository: "NVIDIA/NemoClaw",
      }),
    ).toEqual({ output: `required=${required}\n`, status: 0 });
  });

  it.each([
    ["a fork", "schedule", "", "refs/heads/main", "attacker/NemoClaw"],
    ["a non-main ref", "schedule", "", "refs/heads/release", "NVIDIA/NemoClaw"],
    ["an unexpected event", "pull_request", "", "refs/heads/main", "NVIDIA/NemoClaw"],
    [
      "a scheduled controller checkout",
      "schedule",
      "a".repeat(40),
      "refs/heads/main",
      "NVIDIA/NemoClaw",
    ],
  ])("rejects %s instead of skipping the gate (#7372)", (_case, eventName, checkoutSha, ref, repository) => {
    expect(runClassifier({ checkoutSha, eventName, ref, repository }).status).not.toBe(0);
  });

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
        gateSteps(value)[0].run = gateSteps(value)[0].run!.replace("required=0", "required=1");
      },
    ],
    ["checkout condition", (value) => (gateSteps(value)[1].if = "${{ always() }}")],
    ["checkout pin", (value) => (gateSteps(value)[1].uses = "actions/checkout@v6")],
    ["checkout ref", (value) => (gateSteps(value)[1].with!.ref = "${{ inputs.checkout_sha }}")],
    ["checkout history", (value) => (gateSteps(value)[1].with!["fetch-depth"] = 1)],
    ["checkout credentials", (value) => (gateSteps(value)[1].with!["persist-credentials"] = true)],
    ["Node condition", (value) => (gateSteps(value)[2].if = "${{ always() }}")],
    ["Node pin", (value) => (gateSteps(value)[2].uses = "actions/setup-node@v6")],
    ["Node version", (value) => (gateSteps(value)[2].with!["node-version"] = 20)],
    ["verifier condition", (value) => (gateSteps(value)[3].if = "${{ always() }}")],
    ["verifier token", (value) => (gateSteps(value)[3].env!.GITHUB_TOKEN = "${{ secrets.TOKEN }}")],
    [
      "verifier SHA",
      (value) => (gateSteps(value)[3].env!.EXPECTED_SHA = "${{ inputs.checkout_sha }}"),
    ],
    [
      "verifier command",
      (value) => {
        gateSteps(value)[3].run = "node tools/e2e/base-image-publication.mts";
      },
    ],
    ["step count", (value) => gateSteps(value).push({ name: "Unreviewed step", run: "true" })],
    ["fanout dependency", (value) => (value.jobs["generate-matrix"].needs = [])],
  ];

  it.each(mutations)("rejects %s drift (#7372)", (_case, mutate) => {
    const value = workflow();
    mutate(value);
    expect(validate(value)).not.toEqual([]);
  });
});
