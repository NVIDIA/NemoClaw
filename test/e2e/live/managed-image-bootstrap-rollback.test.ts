// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  managedImageProtectedSandboxName,
  PROTECTED_MANAGED_IMAGE_AGENTS,
  parseProtectedManagedImageContracts,
} from "../../../scripts/checks/managed-image-protected-runtime-contract.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { REPO_ROOT } from "./gpu-e2e-helpers.ts";

const TIMEOUT_MS = 70 * 60_000;

function imageContracts() {
  const contractPath = process.env.NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT;
  if (!contractPath || !path.isAbsolute(contractPath)) {
    throw new Error("NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT must be an absolute path");
  }
  return parseProtectedManagedImageContracts(JSON.parse(fs.readFileSync(contractPath, "utf8")));
}

test("all-agent managed bootstrap failures roll back without owned runtime or harness orphans", {
  timeout: TIMEOUT_MS,
  meta: {
    e2ePhases: [
      "load exact protected image contracts",
      "inject failure and prove rollback for every agent",
      "prove owned harness networks are absent",
    ],
  },
}, async ({ artifacts, host, progress }) => {
  const contracts = imageContracts();
  await artifacts.target.declare({
    id: "managed-image-bootstrap-rollback",
    boundary:
      "same-job localhost registry digest + all managed agents + real Docker/OpenShell managed-bootstrap rollback",
    agents: PROTECTED_MANAGED_IMAGE_AGENTS,
    failureBoundary:
      "The injected failure occurs only after the real adapter observes bootstrap completion; the production rollback path must remove the failed exact PR-image sandbox before test-owned cleanup.",
    registryBoundary:
      "The workflow owns the isolated localhost registry and proves its removal in an always-running cleanup step.",
  });

  const docker = await host.command("docker", ["info"], {
    artifactName: "docker-info",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 30_000,
  });
  expect(docker.exitCode, resultText(docker)).toBe(0);

  progress.phase("inject failure and prove rollback for every agent");
  for (const contract of contracts) {
    const sandboxName = managedImageProtectedSandboxName(contract.agent, "rollback");
    const result = await host.command(
      "npx",
      [
        "--no-install",
        "tsx",
        "scripts/checks/run-managed-image-openshell-e2e.ts",
        "--agent",
        contract.agent,
        "--image",
        contract.reference,
        "--sandbox",
        sandboxName,
        "--inject-bootstrap-completion-failure",
      ],
      {
        artifactName: `managed-image-${contract.agent}-bootstrap-rollback`,
        cwd: REPO_ROOT,
        env: {
          ...buildAvailabilityProbeEnv(),
          NEMOCLAW_NON_INTERACTIVE: "1",
        },
        timeoutMs: 15 * 60_000,
      },
    );
    expect(result.exitCode, resultText(result)).toBe(0);
    expect(result.stdout).toContain(
      `removed the failed exact ${contract.agent} sandbox before harness cleanup`,
    );
    expect(result.stdout).toContain(
      `left no sandbox, container, network, or harness state orphan for ${contract.agent}`,
    );

    const containers = await host.command(
      "docker",
      [
        "ps",
        "-aq",
        "--filter",
        "label=openshell.ai/managed-by=openshell",
        "--filter",
        `label=openshell.ai/sandbox-name=${sandboxName}`,
      ],
      {
        artifactName: `managed-image-${contract.agent}-remaining-containers`,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(containers.exitCode, resultText(containers)).toBe(0);
    expect(containers.stdout.trim()).toBe("");
  }

  progress.phase("prove owned harness networks are absent");
  const networks = await host.command(
    "bash",
    ["-lc", "docker network ls --format '{{.Name}}' | grep '^nemoclaw-managed-pr-' || true"],
    {
      artifactName: "managed-image-remaining-harness-networks",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(networks.exitCode, resultText(networks)).toBe(0);
  expect(networks.stdout.trim()).toBe("");
});
