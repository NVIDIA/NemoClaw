// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readYaml, type Workflow, type WorkflowStep } from "../../helpers/e2e-workflow-contract";

function rootlessLinuxStep(name: string): WorkflowStep {
  const workflow = readYaml<Workflow>(".github/workflows/portable-profile-e2e.yaml");
  const step = workflow.jobs["rootless-linux"]?.steps?.find((candidate) => candidate.name === name);
  expect(step).toBeDefined();
  return step!;
}

describe("portable profile rootless runtime workflow", () => {
  it("uses Ubuntu's Podman package with its installed OCI runtime", () => {
    const provision = rootlessLinuxStep("Provision restricted rootless Linux runtime").run ?? "";
    const packageInstallIndex = provision.indexOf("sudo apt-get install");
    const packagePodmanIndex = provision.indexOf('package_podman="/usr/bin/podman"');
    const pathExportIndex = provision.indexOf('export PATH="$runtime_bin:$PATH"');
    const jobPathIndex = provision.indexOf('printf \'%s\\n\' "$runtime_bin" >> "$GITHUB_PATH"');
    const versionIndex = provision.indexOf("podman --version");

    expect(packageInstallIndex).toBeGreaterThanOrEqual(0);
    expect(provision).toMatch(/sudo apt-get install --yes .*\bpodman\b/);
    expect(packagePodmanIndex).toBeGreaterThan(packageInstallIndex);
    expect(provision).toContain('ln -s "$package_podman" "$runtime_bin/podman"');
    expect(pathExportIndex).toBeGreaterThan(packagePodmanIndex);
    expect(jobPathIndex).toBeGreaterThan(pathExportIndex);
    expect(versionIndex).toBeGreaterThan(jobPathIndex);
    expect(provision).toContain('test "$(readlink -f "$(command -v podman)")" = "$package_podman"');
  });
});
