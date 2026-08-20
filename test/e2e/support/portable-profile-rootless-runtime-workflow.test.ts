// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readYaml, type Workflow } from "../../helpers/e2e-workflow-contract";

describe("portable profile rootless runtime workflow", () => {
  // source-shape-contract: compatibility -- Actionlint and the workflow must share Ubuntu 26.04 while the workflow compiles the candidate catalogue, pins Podman 5.7, and corrects the pasta AppArmor policy before live E2E
  it("keeps actionlint and live E2E on Ubuntu 26.04 and Podman 5.7 (#9006)", () => {
    const actionlint = readYaml<{ "self-hosted-runner"?: { labels?: string[] } }>(
      ".github/actionlint.yaml",
    );
    const workflow = readYaml<Workflow>(".github/workflows/portable-profile-e2e.yaml");
    const job = workflow.jobs["rootless-linux"];
    const steps = job?.steps ?? [];
    const provision = steps.find(
      (step) => step.name === "Provision restricted rootless Linux runtime",
    )?.run;
    const policy = steps.find(
      (step) => step.name === "Apply Ubuntu pasta signal policy correction",
    )?.run;
    const dependencyInstallIndex = steps.findIndex(
      (step) => step.name === "Install root dependencies",
    );
    const catalogueCompileIndex = steps.findIndex((step) => step.run === "npm run catalog:compile");
    const provisionIndex = steps.findIndex(
      (step) => step.name === "Provision restricted rootless Linux runtime",
    );
    const policyIndex = steps.findIndex(
      (step) => step.name === "Apply Ubuntu pasta signal policy correction",
    );
    const liveTestIndex = steps.findIndex(
      (step) => step.name === "Exercise portable profile in the rootless environment",
    );
    const packageInstallIndex = provision?.indexOf("sudo apt-get install") ?? -1;
    const packageVersionIndex = provision?.indexOf("dpkg-query --show") ?? -1;
    const runtimeVersionIndex = provision?.indexOf("podman --version") ?? -1;
    const actionlintLabels = actionlint["self-hosted-runner"]?.labels;

    expect(job?.["runs-on"]).toBe("ubuntu-26.04");
    expect(Array.isArray(actionlintLabels)).toBe(true);
    expect(actionlintLabels).toContain("ubuntu-26.04");
    expect(job?.env?.PODMAN_APT_VERSION).toBe("5.7.0+ds2-3build1");
    expect(dependencyInstallIndex).toBeGreaterThanOrEqual(0);
    expect(catalogueCompileIndex).toBeGreaterThan(dependencyInstallIndex);
    expect(provisionIndex).toBeGreaterThan(catalogueCompileIndex);
    expect(policyIndex).toBeGreaterThan(provisionIndex);
    expect(liveTestIndex).toBeGreaterThan(policyIndex);
    expect(packageInstallIndex).toBeGreaterThanOrEqual(0);
    expect(provision).toContain("apparmor");
    expect(provision).toContain('"podman=$PODMAN_APT_VERSION"');
    expect(packageVersionIndex).toBeGreaterThan(packageInstallIndex);
    expect(runtimeVersionIndex).toBeGreaterThan(packageVersionIndex);
    expect(provision).toContain('test "$package_version" = "$PODMAN_APT_VERSION"');
    expect(provision).toContain('test "$version" = "podman version 5.7.0"');
    expect(policy).toContain("/etc/apparmor.d/usr.bin.pasta");
    expect(policy).toContain("signal (receive) peer=podman,");
    expect(policy).toContain('test -f "$pasta_profile"');
    expect(policy).toContain(
      `test "$(grep -Fc 'include <abstractions/pasta>' "$pasta_profile")" -eq 1`,
    );
    expect(policy).toContain('if ! grep -Eq "$signal_rule" "$pasta_profile"; then');
    expect(policy).toContain('test "$(grep -Ec "$signal_rule" "$pasta_profile")" -eq 1');
    expect(policy).toContain('apparmor_parser -r "$pasta_profile"');
  });
});
