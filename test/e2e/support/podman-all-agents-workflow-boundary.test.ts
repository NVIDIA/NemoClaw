// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type WorkflowStep = {
  env?: Record<string, unknown>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
};

type WorkflowJob = {
  env?: Record<string, unknown>;
  if?: string;
  needs?: string;
  "runs-on"?: string;
  steps?: WorkflowStep[];
  strategy?: { matrix?: { agent?: string[] } };
  "timeout-minutes"?: number;
};

type Workflow = {
  on: {
    workflow_dispatch: {
      inputs: Record<string, { default?: string; description?: string; type?: string }>;
    };
  };
  jobs: Record<string, WorkflowJob & { needs?: string[] | string }>;
};

function workflow(): Workflow {
  return readWorkflow() as Workflow;
}

function namedStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  expect(step, `missing Podman workflow step '${name}'`).toBeDefined();
  return step!;
}

function liveTestSource(): string {
  return readFileSync(
    path.join(import.meta.dirname, "..", "live", "podman-all-agents.test.ts"),
    "utf8",
  );
}

describe("native Podman all-agent workflow boundary", () => {
  it("runs all supported agents on the native rootless Podman runner contract", () => {
    const parsed = workflow();
    const job = parsed.jobs["podman-all-agents"];

    expect(job).toBeDefined();
    expect(job).toMatchObject({
      needs: "generate-matrix",
      "runs-on": "ubuntu-26.04",
      "timeout-minutes": 90,
      strategy: {
        matrix: {
          agent: ["openclaw", "hermes", "langchain-deepagents-code"],
        },
      },
      env: {
        E2E_JOB: "1",
        E2E_DEFAULT_ENABLED: "0",
        E2E_TARGET_ID: "podman-all-agents",
        NEMOCLAW_SANDBOX_GPU: "0",
      },
    });
    expect(job?.if).toContain("inputs.jobs");
    expect(job?.if).toContain("inputs.targets");
    expect(job?.if).toContain("podman-all-agents");
    expect(liveTestSource()).toContain("timeout: 75 * 60_000");

    const start = namedStep(job!, "Start exact rootless Podman API socket").run ?? "";
    expect(start).toContain('socket_path="$runtime_dir/podman/podman.sock"');
    expect(start).toContain('podman system service --time=0 "unix://$socket_path"');
    expect(start).toContain('podman --url "unix://$socket_path" info --format json');
    expect(start).toContain("(.host.security.rootless // .Host.Security.Rootless) == true");
    expect(start).toContain("OPENSHELL_PODMAN_SOCKET");
    expect(start).toContain("OPENSHELL_PODMAN_NETWORK_NAME");
  });

  it("gates on a complete published three-agent managed-image release and records digests", () => {
    const parsed = workflow();
    const input = parsed.on.workflow_dispatch.inputs.podman_managed_image_release;
    const job = parsed.jobs["podman-all-agents"]!;
    const catalog = namedStep(job, "Resolve complete published managed-image release");
    const run = catalog.run ?? "";

    expect(input).toMatchObject({ default: "", type: "string" });
    expect(input.description?.toLowerCase()).toContain("published complete managed-image release");
    expect(input.description?.toLowerCase()).toContain("fails visibly");
    expect(catalog.env).toEqual({
      REQUESTED_RELEASE: "${{ inputs.podman_managed_image_release }}",
    });
    expect(run).toContain('status:"gated"');
    expect(run).toContain("reporting this lane as not passed");
    expect(run).toMatch(/if \[ -z "\$release" \]; then[\s\S]*?exit 1/u);
    expect(run).toContain("skopeo inspect --override-os linux --override-arch amd64");
    expect(run).toContain("openclaw-sandbox");
    expect(run).toContain("hermes-sandbox");
    expect(run).toContain("langchain-deepagents-code-sandbox");
    expect(run).toContain("cohort-$source_cohort");
    expect(run).toContain("org.opencontainers.image.revision");
    expect(run).toContain('reference: ($image + "@" + $digest)');
    expect(run).toContain("git merge-base --is-ancestor");

    const bind = namedStep(job, "Bind the candidate CLI to the verified release identity");
    expect(bind.run).toContain('git tag --force "$MANAGED_IMAGE_RELEASE" HEAD');
    expect(bind.run).not.toContain("git push");
  });

  it("installs a fail-closed Docker guard and runs only the native Podman live test", () => {
    const parsed = workflow();
    const job = parsed.jobs["podman-all-agents"]!;
    const names = job.steps?.map((step) => step.name).filter(Boolean);
    const scripts = job.steps?.map((step) => step.run ?? "").join("\n") ?? "";

    expect(names).not.toContain("Authenticate to Docker Hub");
    expect(names).not.toContain("Clean up Docker auth");
    expect(names?.indexOf("Install Docker invocation guard")).toBeLessThan(
      names?.indexOf("Disable the Docker daemon for native Podman proof") ?? -1,
    );
    const disableDocker = namedStep(job, "Disable the Docker daemon for native Podman proof").run;
    expect(disableDocker).toContain("systemctl stop docker.service docker.socket");
    expect(disableDocker).toContain("systemctl mask --runtime docker.service docker.socket");
    expect(disableDocker).toContain("[ -S /var/run/docker.sock ]");
    expect(disableDocker).toContain('docker_candidate="$(command -v docker || true)"');
    expect(disableDocker).toContain('"$docker_candidate" != "$E2E_DOCKER_GUARD_BIN"');
    expect(disableDocker).toContain("docker-absence-boundary.json");
    expect(disableDocker).not.toMatch(/\bdocker\s+info\b/u);
    expect(namedStep(job, "Install Docker invocation guard").run).toContain("exit 97");
    expect(namedStep(job, "Install Docker invocation guard").run).toContain("DOCKER_HOST=");
    expect(namedStep(job, "Verify the lane never invoked Docker").run).toContain(
      'if [ -s "$E2E_DOCKER_GUARD_LOG" ]',
    );
    expect(scripts).not.toMatch(/\bdocker\s+(?:login|pull|build|run|info)\b/u);
    expect(scripts).not.toContain("podman-docker");

    const live = namedStep(job, "Run native Podman all-agent live test");
    expect(live.env).toEqual({
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
    });
    expect(live.run).toContain(
      "tools/e2e/live-vitest-invocation.mts run --test-path test/e2e/live/podman-all-agents.test.ts",
    );

    const reportNeeds = parsed.jobs["report-to-pr"]?.needs;
    expect(Array.isArray(reportNeeds) ? reportNeeds : []).toContain("podman-all-agents");
  });

  it("proves the actual digest-bound Podman container across stop/start, recovery, rebuild, and cleanup", () => {
    const source = liveTestSource();

    expect(source).toContain('"openshell.sandbox-name"');
    expect(source).toContain('"openshell.managed"');
    expect(source).toContain("expect(imageName).toBe(options.catalog.reference)");
    expect(source).toContain("expect(imageDigest).toBe(options.catalog.digest)");
    expect(source).toContain("expect(imageRepoDigests).toContain(options.catalog.reference)");
    expect(source).toContain("OPENSHELL_SANDBOX_COMMAND=");
    expect(source).toContain("/usr/local/bin/nemoclaw-managed-startup-hold");
    expect(source).toContain("managed-startup-complete.json");
    expect(source).toContain("profileFingerprint: options.profileFingerprint");
    expect(source).toContain('expect(limits.get("nproc")).toEqual({ hard: 512, soft: 512 })');
    expect(source).toContain(
      'expect(limits.get("nofile")).toEqual({ hard: 65_536, soft: 65_536 })',
    );
    expect(source).toContain('"512:512:65536:65536"');
    expect(source).toContain("nemoclaw-backup-");
    expect(source).toContain('"io.nvidia.nemoclaw.managed-image.cohort"');
    expect(source).toContain("runtimeBindingBeforeRecovery");
    expect(source).toContain("socket_path: socketPath");
    expect(source).toContain("network_name: networkName");
    expect(source).toContain('host.nemoclaw([sandboxName, "stop"]');
    expect(source).toContain("expectedRunning: false");
    expect(source).toContain("expect(stoppedContainer).toEqual(initialContainer)");
    expect(source).toContain('host.nemoclaw([sandboxName, "start"]');
    expect(source).toContain("restartedContainer");
    expect(source).toContain("stoppedAndStarted: true");
    expect(source).toContain("host.expectStatus(sandboxName");
    expect(source).not.toMatch(/"--resume"[\s\S]{0,180}"--compute-driver"[\s\S]{0,40}"podman"/u);
    expect(source).toContain("rebuild must replace the managed Podman sandbox container");
    expect(source).toContain('"snapshot", "create", "--name", "podman-runtime"');
    expect(source).toContain("snapshotCloneRestored: true");
    expect(source).toContain(
      "snapshot clone cutover must resume a new exact standalone gateway process",
    );
    expect(source).toContain('"network", "exists", networkName');
    expect(source).toContain("networkAfterCleanup.exitCode");
  });
});
