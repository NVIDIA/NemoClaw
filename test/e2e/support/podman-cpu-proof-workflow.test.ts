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
    expect(parsed.on.pull_request.paths).toContain("src/lib/onboard/docker-driver-gateway-*.ts");
    expect(parsed.on.pull_request.paths).toContain("src/lib/onboard/managed-bootstrap/podman-*.ts");
    expect(parsed.on.pull_request.paths).toContain(
      "src/lib/onboard/experimental/portable-demo-lifecycle.ts",
    );
    expect(parsed.on.pull_request.paths).toContain("scripts/install-openshell.sh");
    expect(parsed.on.pull_request.paths).toContain(
      "test/e2e/live/podman-cpu-lifecycle-artifacts.ts",
    );
    expect(parsed.on.pull_request.paths).toContain("test/e2e/live/podman-cpu-lifecycle-helpers.ts");
    expect(parsed.on.pull_request.paths).toContain(
      "test/e2e/live/podman-cpu-lifecycle-policy.yaml",
    );
    expect(job.name).toBe("Rootless Podman CPU lifecycle with Docker disabled");
    expect(job["runs-on"]).toBe("ubuntu-26.04");
    expect(job["timeout-minutes"]).toBe(30);
    expect(job.env?.NEMOCLAW_RUN_LIVE_E2E).toBe("1");
    expect(job.env?.NEMOCLAW_OPENSHELL_PIN_VERSION).toBe("0.0.101");
    expect(job.env?.PODMAN_APT_VERSION).toBe("5.7.0+ds2-3build1");
    expect(namedStep("Checkout").with).toMatchObject({
      ref: "${{ github.event.pull_request.head.sha }}",
    });
    expect(namedStep("Build shared sandbox-name contract").run).toBe(
      "npm run build:policy-boundary",
    );
    const installPodman = namedStep("Install Podman 5 runtime").run ?? "";
    expect(installPodman).toContain("apt-get install --yes");
    expect(installPodman).toContain("passt");
    expect(installPodman).toContain("uidmap");
    expect(installPodman).toContain('"podman=$PODMAN_APT_VERSION"');
    expect(installPodman).toContain('test "$package_version" = "$PODMAN_APT_VERSION"');
    expect(installPodman).toContain('test "$version" = "podman version 5.7.0"');
    const installOpenShell = namedStep("Install pinned OpenShell runtime").run ?? "";
    expect(installOpenShell).toContain("env -u GH_TOKEN -u GITHUB_TOKEN");
    expect(installOpenShell).toContain("bash scripts/install-openshell.sh");
    expect(installOpenShell).toContain("$HOME/.local/bin");
    expect(readRepoText(".github/workflows/podman-cpu-proof.yaml")).not.toContain("${{ secrets.");
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
    const correctPastaPolicy = namedStep("Apply Ubuntu pasta signal policy correction").run ?? "";
    expect(correctPastaPolicy).toContain("/etc/apparmor.d/usr.bin.pasta");
    expect(correctPastaPolicy).toContain("signal (receive) peer=podman,");
    expect(correctPastaPolicy).toContain('apparmor_parser -r "$pasta_profile"');
    expect(startPodman).toContain("umask 077");
    expect(startPodman).toContain('socket_path="$runtime_dir/podman/podman.sock"');
    expect(startPodman).toContain('default_rootless_network_cmd = "pasta"');
    expect(startPodman).toContain("rootlessNetworkCmd");
    expect(startPodman).toContain("CONTAINERS_CONF");
    expect(startPodman).toContain('podman system service --time=0 "unix://$socket_path"');
    expect(startPodman).toContain("E2E_PODMAN_SOCKET");
    expect(scripts).not.toMatch(/\bdocker\s+(?:build|info|login|pull|run)\b/u);
    expect(scripts).not.toContain("podman-docker");
  });

  it("runs the real pinned OpenShell activation proof without synthetic fixtures", () => {
    const proof = namedStep(
      "Prove pinned OpenShell activation and registered-agent Podman CPU lifecycle",
    );
    const diagnostics = namedStep("Capture failed Podman lifecycle diagnostics");
    const cleanup = namedStep("Clean up rootless Podman runtime");
    const scripts = proofJob()
      .steps?.map((step) => step.run ?? "")
      .join("\n");

    expect(proof.run).toBe(
      "npx vitest run --project e2e-live test/e2e/live/podman-cpu-lifecycle.test.ts",
    );
    expect(scripts).not.toContain("podman create");
    expect(scripts).not.toContain("openshell-sandbox-$sandbox_name");
    expect(scripts).not.toContain("openshell.sandbox-name");
    expect(diagnostics.if).toBe("failure()");
    expect(diagnostics.run).toContain('podman --url "$endpoint" inspect');
    expect(diagnostics.run).toContain(
      "npx --no-install tsx test/e2e/live/podman-cpu-lifecycle-artifacts.ts",
    );
    expect(diagnostics.run).toContain("managed-container-summary.json");
    expect(diagnostics.run).not.toContain("podman-ps.txt");
    expect(diagnostics.run).not.toContain("-inspect.json");
    expect(diagnostics.run).not.toMatch(/podman\s+--url\s+"\$endpoint"\s+logs\b/u);
    expect(diagnostics.run).not.toContain("container-$container_id.log");
    expect(diagnostics.run).toContain("podman-secrets.txt");
    expect(cleanup.if).toBe("always()");
    expect(cleanup.run).toContain("--filter label=openshell.managed=true");
    expect(cleanup.run).toContain('podman --url "$endpoint" rm --force');
    expect(cleanup.run).toContain('podman --url "$endpoint" volume rm --force');
    expect(cleanup.run).toContain('podman --url "$endpoint" secret rm');
    expect(cleanup.run).toContain('podman --url "$endpoint" network rm openshell-docker');
  });
});
