// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readRepoText,
  readYaml,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from "../../helpers/e2e-workflow-contract";

type PodmanProofWorkflow = Workflow & {
  on: { pull_request: { paths: string[]; types: string[] } };
  permissions: Record<string, string>;
};

function workflow(): PodmanProofWorkflow {
  return readYaml(".github/workflows/podman-cpu-proof.yaml") as PodmanProofWorkflow;
}

function proofJob(): WorkflowJob {
  const job = workflow().jobs["podman-cpu-lifecycle"];
  expect(job).toBeDefined();
  return job!;
}

function namedStep(name: string): WorkflowStep {
  const step = proofJob().steps?.find((candidate) => candidate.name === name);
  expect(step, `missing Podman CPU proof step '${name}'`).toBeDefined();
  return step!;
}

describe("native Podman CPU proof workflow", () => {
  // source-shape-contract: security -- Exact checkout and package pins bind the credential-free Podman proof to the reported PR head and reviewed runtime bytes
  it("runs as a credential-free exact-head PR workflow", () => {
    const parsed = workflow();
    const job = proofJob();

    expect(parsed.permissions).toEqual({ contents: "read" });
    expect(parsed.on.pull_request.types).toEqual(["opened", "synchronize", "reopened"]);
    expect(parsed.on.pull_request.paths).toContain("src/lib/adapters/podman/**");
    expect(job.name).toBe("Rootless Podman CPU lifecycle with Docker disabled");
    expect(job["runs-on"]).toBe("ubuntu-26.04");
    expect(job["timeout-minutes"]).toBe(30);
    expect(job.env?.NEMOCLAW_RUN_LIVE_E2E).toBe("1");
    expect(job.env?.PODMAN_APT_VERSION).toBe("5.7.0+ds2-3build1");
    expect(namedStep("Checkout").with).toMatchObject({
      ref: "${{ github.event.pull_request.head.sha }}",
    });
    const installPodman = namedStep("Install Podman 5 runtime").run ?? "";
    expect(installPodman).toContain('apt-get install --yes "podman=$PODMAN_APT_VERSION"');
    expect(installPodman).toContain('test "$package_version" = "$PODMAN_APT_VERSION"');
    expect(installPodman).toContain('test "$version" = "podman version 5.7.0"');
    expect(readRepoText(".github/workflows/podman-cpu-proof.yaml")).not.toContain("secrets.");
  });

  it("pins one rootless socket and fails closed on Docker use", () => {
    const installGuard = namedStep("Install Docker invocation guard").run ?? "";
    const disableDocker = namedStep("Disable Docker daemon and socket").run ?? "";
    const startPodman = namedStep("Start exact rootless Podman API socket").run ?? "";
    const scripts = proofJob()
      .steps?.map((step) => step.run ?? "")
      .join("\n");

    expect(installGuard).toContain("exit 97");
    expect(installGuard).toContain("DOCKER_HOST=");
    expect(disableDocker).toContain("systemctl stop docker.service docker.socket");
    expect(disableDocker).toContain("pkill -TERM -x dockerd");
    expect(disableDocker).toContain("docker-absence-boundary.json");
    expect(disableDocker).toContain("Docker socket remained available after Docker shutdown");
    expect(startPodman).toContain("umask 077");
    expect(startPodman).toContain('socket_path="$runtime_dir/podman/podman.sock"');
    expect(startPodman).toContain('podman system service --time=0 "unix://$socket_path"');
    expect(startPodman).toContain("E2E_PODMAN_SOCKET");
    expect(scripts).not.toMatch(/\bdocker\s+(?:build|info|login|pull|run)\b/u);
    expect(scripts).not.toContain("podman-docker");
  });

  it("creates all-agent fixtures and invokes only the native lifecycle proof", () => {
    const fixtures = namedStep("Create exact managed lifecycle fixtures").run ?? "";
    const proof = namedStep("Prove native Podman preflight and all-agent CPU lifecycle");
    const cleanup = namedStep("Clean up rootless Podman fixtures");

    expect(fixtures).toContain("for agent in openclaw hermes langchain-deepagents-code");
    expect(fixtures).toContain("openshell.managed=true");
    expect(fixtures).toContain("openshell.sandbox-name=$sandbox_name");
    expect(fixtures).toContain("openshell.sandbox-namespace=default");
    expect(proof.run).toBe(
      "npx vitest run --project e2e-live test/e2e/live/podman-cpu-lifecycle.test.ts",
    );
    expect(cleanup.if).toBe("always()");
    expect(cleanup.run).toContain('podman --url "$endpoint" rm --force');
  });
});
