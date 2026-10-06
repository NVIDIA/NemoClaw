// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { readWorkflow, required, step } from "../../helpers/managed-image-publication-workflow";

it("runs the exact all-agent cohort on rootless Podman with Docker unavailable", () => {
  const workflow = readWorkflow("managed-images.yaml");
  const activation = required(
    workflow.jobs?.["pr-managed-podman-activation"],
    "managed-image workflow is missing its exact rootless Podman activation gate",
  );
  const steps = activation.steps ?? [];
  expect(activation["runs-on"]).toBe("ubuntu-26.04");
  expect(activation.permissions).toEqual({ contents: "read" });
  expect(activation.env).toMatchObject({
    CANDIDATE_SHA: "${{ github.event.pull_request.head.sha }}",
    NEMOCLAW_GATEWAY_RUNTIME: "podman",
    OPENSHELL_DRIVERS: "podman",
  });
  expect(JSON.stringify(activation)).not.toContain("secrets.");
  const diagnostics = step(activation, "Initialize managed Podman activation diagnostics");
  const upload = step(activation, "Upload managed Podman activation evidence");
  expect([
    steps.indexOf(diagnostics) < steps.indexOf(step(activation, "Set up Node.js")),
    diagnostics.run?.includes('>"$E2E_ARTIFACT_DIR/setup-context.txt"'),
    upload.if,
    upload.with?.["if-no-files-found"],
    step(activation, "Install rootless Podman runtime").run?.includes(
      '"podman=$PODMAN_APT_VERSION"',
    ),
  ]).toEqual([true, true, "always()", "error", true]);
  expect(step(activation, "Assemble exact all-agent activation catalog").run).toMatch(
    /openshell-sdk-install\.mts prepare[\s\S]*npm ci --ignore-scripts --no-audit --no-fund --@nvidia:registry=https:\/\/npm\.pkg\.github\.com[\s\S]*openshell-sdk-install\.mts check/u,
  );
  const disableDocker = step(activation, "Disable and guard Docker").run ?? "";
  expect(disableDocker).toMatch(
    /Docker CLI use is forbidden in managed Podman activation[\s\S]*export PATH="\$guarded_path"[\s\S]*pgrep -x dockerd[\s\S]*DOCKER_HOST=\\n[\s\S]*E2E_DOCKER_GUARD_BIN[\s\S]*docker-absence-before-candidate\.json/u,
  );
  const run = step(activation, "Run real all-agent managed runtime activation on Podman").run ?? "";
  expect(run).toContain('test "$(git rev-parse --verify HEAD)" = "$CANDIDATE_SHA"');
  expect(run).toContain("test/e2e/live/managed-image-activation-e2e.test.ts");
  const verifyDocker = step(activation, "Verify Docker stayed unavailable").run ?? "";
  expect(verifyDocker).toMatch(
    /dockerGuardCommands[\s\S]*docker-absence-after-candidate\.json[\s\S]*Docker invocation guard recorded candidate execution[\s\S]*docker_candidate[\s\S]*E2E_DOCKER_GUARD_BIN[\s\S]*dockerd became active during managed Podman activation/u,
  );
});
