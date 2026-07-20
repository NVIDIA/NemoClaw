// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";
import { requireFixture } from "./require-fixture";

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
};

type RoutingWorkflow = {
  jobs: Record<
    string,
    {
      outputs?: Record<string, string>;
      steps?: WorkflowStep[];
      "runs-on"?: string;
    }
  >;
};

function routingStep(workflow: RoutingWorkflow): WorkflowStep {
  const step = workflow.jobs["generate-matrix"]?.steps?.find(
    (candidate) => candidate.id === "runner_routing",
  );
  requireFixture(step?.run, "trusted larger-runner routing step is missing");
  return step;
}

function evaluateRouting(
  workflow: RoutingWorkflow,
  env: { label: string; ref: string; repository: string },
): Record<string, string> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runner-routing-"));
  const outputPath = path.join(directory, "github-output");
  try {
    execFileSync("bash", ["-c", routingStep(workflow).run!], {
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        LARGER_RUNNER_LABEL: env.label,
        REF: env.ref,
        REPOSITORY: env.repository,
      },
    });
    const output = fs.readFileSync(outputPath, "utf8").trim();
    requireFixture(output.startsWith("runner_routing="), "runner routing output is missing");
    return JSON.parse(output.slice("runner_routing=".length)) as Record<string, string>;
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

const standardRouting = {
  "common-egress-agent": "ubuntu-latest",
  "mcp-bridge-deepagents": "ubuntu-latest",
  "mcp-bridge-hermes": "ubuntu-latest",
  "mcp-bridge-openclaw": "ubuntu-latest",
  "rebuild-hermes": "ubuntu-latest",
  "rebuild-hermes-stale-base": "ubuntu-latest",
};

describe("larger-runner workflow routing boundary", () => {
  // source-shape-contract: security -- Executes the shipped pre-checkout router to prove untrusted and unset configurations stay on standard runners
  it.each([
    {
      label: "",
      name: "the administrator label is unset",
      ref: "refs/heads/main",
      repository: "NVIDIA/NemoClaw",
    },
    {
      label: "ubuntu-24.04-8core",
      name: "the workflow is not running from main",
      ref: "refs/heads/feature",
      repository: "NVIDIA/NemoClaw",
    },
    {
      label: "ubuntu-24.04-8core",
      name: "the workflow belongs to another repository",
      ref: "refs/heads/main",
      repository: "someone/NemoClaw",
    },
  ])("keeps every candidate on standard runners when $name (#7145)", ({
    label,
    ref,
    repository,
  }) => {
    expect(evaluateRouting(readWorkflow() as RoutingWorkflow, { label, ref, repository })).toEqual(
      standardRouting,
    );
  });

  // source-shape-contract: security -- Executes the shipped pre-checkout router to prove trusted main can reach only the reviewed heavy lanes
  it("routes only the measured heavy lanes on trusted main (#7145)", () => {
    const largerRunner = "ubuntu-24.04-8core";
    expect(
      evaluateRouting(readWorkflow() as RoutingWorkflow, {
        label: largerRunner,
        ref: "refs/heads/main",
        repository: "NVIDIA/NemoClaw",
      }),
    ).toEqual({
      ...standardRouting,
      "common-egress-agent": largerRunner,
      "mcp-bridge-deepagents": largerRunner,
      "mcp-bridge-hermes": largerRunner,
      "rebuild-hermes": largerRunner,
      "rebuild-hermes-stale-base": largerRunner,
    });
  });

  // source-shape-contract: security -- Executes the shipped pre-checkout router to prove malformed administrator labels fail before job routing
  it("rejects malformed administrator workflow labels (#7145)", () => {
    expect(() =>
      evaluateRouting(readWorkflow() as RoutingWorkflow, {
        label: "invalid runner\nlabel",
        ref: "refs/heads/main",
        repository: "NVIDIA/NemoClaw",
      }),
    ).toThrow();
  });

  it("rejects moving or weakening the trusted pre-checkout map (#7145)", () => {
    const workflow = readWorkflow() as RoutingWorkflow;
    const generate = workflow.jobs["generate-matrix"];
    const steps = generate.steps!;
    const routing = routingStep(workflow);
    generate.outputs!.runner_routing = "${{ steps.matrix.outputs.runner_routing }}";
    routing.env!.REF = "${{ inputs.base_sha }}";
    routing.run = routing.run!.replace('"${REF}" == "refs/heads/main" && ', "");
    steps.splice(steps.indexOf(routing), 1);
    steps.push(routing);

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "generate-matrix job must expose the trusted larger-runner routing output",
        "trusted larger-runner routing step must bind only the administrator label and trusted repository identity",
        "trusted larger-runner routing step must preserve the exact main-only map and ubuntu-latest fallback",
        "trusted larger-runner routing step must run before PR checkout",
      ]),
    );
  });

  it("rejects routing any lane outside the centralized eligible set (#7145)", () => {
    const workflow = readWorkflow() as RoutingWorkflow;
    workflow.jobs["common-egress-agent"]["runs-on"] = "ubuntu-latest";
    workflow.jobs["mcp-bridge"]["runs-on"] = "ubuntu-latest";
    workflow.jobs["mcp-bridge-dev"]["runs-on"] =
      "${{ fromJSON(needs.generate-matrix.outputs.runner_routing)['mcp-bridge-deepagents'] }}";
    workflow.jobs["network-policy"]["runs-on"] = "${{ vars.E2E_LARGER_RUNNER_LABEL }}";
    workflow.jobs["shields-config"]["runs-on"] =
      "${{ fromJSON(needs.generate-matrix.outputs.runner_routing)['common-egress-agent'] }}";

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "common-egress-agent job must use the trusted larger-runner routing map",
        "mcp-bridge job must route each agent through the trusted runner map",
        "mcp-bridge-dev job must remain on ubuntu-latest",
        "network-policy job must not consume E2E_LARGER_RUNNER_LABEL directly",
        "shields-config job must not use the larger-runner routing map",
      ]),
    );
  });
});
