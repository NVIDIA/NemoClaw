// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readYaml,
  type NightlyWorkflow,
  type RunnerWorkflow,
  type WorkflowJob,
} from "./helpers/e2e-workflow-contract";

const CPU_RUNNER = "linux-amd64-cpu4";
const VPN_WORKFLOW = ".github/workflows/nightly-e2e-vpn.yaml";
const BASE_WORKFLOW = ".github/workflows/nightly-e2e.yaml";
const VPN_RUNNER = ".github/workflows/e2e-script-vpn.yaml";
const VPN_ACTION = ".github/actions/run-e2e-script-vpn";
const VPN_E2E_TREE = "test/e2e-vpn";
const INFRA_JOBS = new Set(["notify-on-failure", "report-to-pr", "scorecard"]);
const SELF_HOSTED_GPU_JOBS = new Set(["gpu-e2e", "gpu-double-onboard-e2e", "gpu-jetson-nvmap-e2e"]);

function e2eJobNames(workflow: NightlyWorkflow): string[] {
  return Object.keys(workflow.jobs).filter((name) => !INFRA_JOBS.has(name));
}

function reusableJobs(workflow: NightlyWorkflow): Array<[string, WorkflowJob]> {
  return Object.entries(workflow.jobs).filter(([, job]) => job.uses !== undefined);
}

function needsOf(job: WorkflowJob | undefined): string[] {
  const needs = (job as Record<string, unknown> | undefined)?.needs;
  if (typeof needs === "string") return [needs];
  if (Array.isArray(needs)) return needs.filter((name): name is string => typeof name === "string");
  return [];
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(collectStrings);
}

function listFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((entry) => listFiles(join(path, entry)));
}

function workflowCall(runner: RunnerWorkflow): Record<string, any> {
  return runner.on?.workflow_call ?? runner.true?.workflow_call ?? {};
}

describe("VPN nightly E2E workflow validation", () => {
  const baseWorkflow = readYaml<NightlyWorkflow>(BASE_WORKFLOW);
  const vpnWorkflow = readYaml<NightlyWorkflow>(VPN_WORKFLOW);
  const vpnRunner = readYaml<RunnerWorkflow>(VPN_RUNNER);
  const baseE2eJobs = e2eJobNames(baseWorkflow);
  const vpnE2eJobs = e2eJobNames(vpnWorkflow);

  it("keeps the VPN nightly job graph parallel to the current nightly", () => {
    expect(vpnE2eJobs).toEqual(baseE2eJobs);

    for (const aggregateJob of INFRA_JOBS) {
      expect(vpnWorkflow.jobs[aggregateJob], aggregateJob).toBeDefined();
      expect(new Set(needsOf(vpnWorkflow.jobs[aggregateJob]))).toEqual(new Set(vpnE2eJobs));
    }
  });

  it("uses the VPN reusable runner for every reusable E2E job", () => {
    const baseReusableNames = reusableJobs(baseWorkflow).map(([name]) => name);
    const vpnReusable = reusableJobs(vpnWorkflow);

    expect(vpnReusable.map(([name]) => name)).toEqual(baseReusableNames);
    for (const [name, job] of vpnReusable) {
      expect(job.uses, name).toBe("./.github/workflows/e2e-script-vpn.yaml");
      expect(job.with?.script, name).toMatch(/^test\/e2e-vpn\/test-.*\.sh$/);
      expect(existsSync(job.with?.script ?? ""), name).toBe(true);
    }
  });

  it("runs CPU jobs on the VPN CPU runner and preserves GPU runner labels", () => {
    const call = workflowCall(vpnRunner);
    expect(call.inputs?.runner?.default).toBe(CPU_RUNNER);

    for (const [name, job] of Object.entries(vpnWorkflow.jobs)) {
      if (job.uses) {
        expect(job.with?.runner ?? CPU_RUNNER, name).toBe(CPU_RUNNER);
        continue;
      }

      if (SELF_HOSTED_GPU_JOBS.has(name)) {
        expect(job["runs-on"], name).toBe(baseWorkflow.jobs[name]?.["runs-on"]);
      } else {
        expect(job["runs-on"], name).toBe(CPU_RUNNER);
      }
    }
  });

  it("points direct E2E jobs at copied VPN shell scripts only", () => {
    const missing: string[] = [];
    for (const [name, job] of Object.entries(vpnWorkflow.jobs)) {
      if (INFRA_JOBS.has(name) || job.uses) continue;

      const strings = collectStrings(job);
      const oldPaths = strings.filter(
        (value) => value.includes("test/e2e/") || value.includes("test/e2e-scenario/"),
      );
      expect(oldPaths, name).toEqual([]);

      const scriptRefs = new Set(
        strings.flatMap((value) =>
          [...value.matchAll(/test\/e2e-vpn\/test-[A-Za-z0-9_.-]+\.sh/g)].map((match) => match[0]),
        ),
      );
      for (const script of scriptRefs) {
        if (!existsSync(script)) missing.push(`${name}:${script}`);
      }
    }

    expect(missing).toEqual([]);
  });

  it("keeps VPN files free of the legacy hosted inference contract", () => {
    const files = [VPN_WORKFLOW, VPN_RUNNER, ...listFiles(VPN_ACTION), ...listFiles(VPN_E2E_TREE)];
    const forbidden = [
      /NVIDIA_INFERENCE_API_KEY/u,
      /inference-api\.nvidia\.com/u,
      /build\.nvidia\.com/u,
      /\bNVCF\b|\bnvcf\b/u,
      /nvidia-prod/u,
      /NEMOCLAW_PROVIDER=(?:cloud|build)/u,
      /NEMOCLAW_PROVIDER="build"/u,
      /NEMOCLAW_PROVIDER: "build"/u,
      /public NVIDIA/u,
      /NVIDIA Endpoints/u,
      /test\/e2e-scenario/u,
      /test\/e2e-vpn-scenario/u,
      /--project e2e-scenarios-live/u,
    ];
    const violations: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(text)) violations.push(`${file}: ${pattern}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("sources only NVIDIA_API_KEY as the VPN inference secret", () => {
    const call = workflowCall(vpnRunner);
    const secretNames = Object.keys(call.secrets ?? {}).filter((name) => name.includes("NVIDIA"));
    const exportStep = vpnRunner.jobs.run.steps.find(
      (step) => step.name === "Export hosted CI inference environment",
    );
    const runStep = vpnRunner.jobs.run.steps.find((step) => step.name === "Run E2E script");

    expect(secretNames).toEqual(["NVIDIA_API_KEY"]);
    expect(exportStep?.env).toEqual({ NVIDIA_API_KEY: "${{ secrets.NVIDIA_API_KEY }}" });
    expect(exportStep?.run).toContain("NEMOCLAW_PROVIDER=custom");
    expect(exportStep?.run).toContain("NEMOCLAW_ENDPOINT_URL=https://inference.nvidia.com/v1");
    expect(exportStep?.run).toContain("COMPATIBLE_API_KEY=%s\\n");
    expect(exportStep?.run).toContain('"${NVIDIA_API_KEY}"');
    expect(runStep?.uses).toBe("./workflow-actions/.github/actions/run-e2e-script-vpn");
    expect(runStep?.env?.NVIDIA_API_KEY).toBe(
      "${{ inputs.nvidia_api_key && secrets.NVIDIA_API_KEY || '' }}",
    );
  });
});
