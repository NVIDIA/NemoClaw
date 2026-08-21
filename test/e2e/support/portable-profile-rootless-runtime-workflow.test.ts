// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { readRepoText, readYaml, type Workflow } from "../../helpers/e2e-workflow-contract";

type PortableProfileWorkflow = Workflow & {
  on: {
    pull_request: { paths: string[]; types: string[] };
  };
};

describe("portable profile rootless runtime workflow", () => {
  // source-shape-contract: compatibility -- The workflow and live fixture must keep the accepted OS, Podman, AppArmor, and HTTP local-registry authorities aligned before live E2E
  it("keeps live E2E on the accepted rootless runtime and local registry authority (#9006)", () => {
    const actionlint = readYaml<{ "self-hosted-runner"?: { labels?: string[] } }>(
      ".github/actionlint.yaml",
    );
    const workflow = readYaml<Workflow>(".github/workflows/portable-profile-e2e.yaml");
    const liveTest = fs.readFileSync(
      "test/e2e/live/portable-profile-rootless-linux.test.ts",
      "utf-8",
    );
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
    expect(liveTest).toContain('path.join(os.userInfo().homedir, ".nemoclaw-portable-e2e-")');
    expect(liveTest).not.toMatch(
      /mkdtempSync\(\s*path\.join\(os\.tmpdir\(\),\s*["']nemoclaw-portable-e2e-/,
    );
    expect(liveTest).toContain("preparePortableExperimentalHost(process.env, { home });");
    expect(liveTest).toContain("assert.equal(prepared?.authority.configHome, configHome);");
    expect(liveTest).toContain('location = "localhost:5000"\\ninsecure = true');
    expect(liveTest).toContain("DOCKER_NETWORK_IPAM_INSPECT_FORMAT");
    expect(liveTest).toContain("parseDockerNetworkIpamEntries(");
    expect(liveTest).not.toContain("{{range .Subnets}}");
  });

  // source-shape-contract: security -- topology changes must select an exact-commit rootless proof, and the live receipt must distinguish ordinary full-ID removal from the netavark-rejected retired state
  it("selects exact-commit rootless evidence for Portable recovery changes (#9707)", () => {
    const workflow = readYaml<PortableProfileWorkflow>(
      ".github/workflows/portable-profile-e2e.yaml",
    );
    const job = workflow.jobs["rootless-linux"];
    const checkout = job?.steps?.find((step) => step.name === "Checkout");
    const upload = job?.steps?.find(
      (step) => step.name === "Upload portable profile E2E artifacts",
    );
    const liveSource = readRepoText("test/e2e/live/portable-profile-rootless-linux.test.ts");
    const revisionExpression = "${{ github.event.pull_request.head.sha || github.sha }}";

    expect(workflow.on.pull_request.types).toEqual(["opened", "synchronize", "reopened"]);
    expect(workflow.on.pull_request.paths).toEqual(
      expect.arrayContaining([
        "src/lib/onboard/experimental/portable-host-preparation.ts",
        "src/lib/onboard/experimental/portable-profile.ts",
        "src/lib/onboard/experimental/portable-retired-subnet-recovery.test.ts",
        "test/e2e/live/portable-profile-rootless-linux.test.ts",
        "test/e2e/support/portable-profile-rootless-runtime-workflow.test.ts",
      ]),
    );
    expect(job?.env?.E2E_SOURCE_REVISION).toBe(revisionExpression);
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(checkout?.with?.ref).toBe(revisionExpression);
    expect(upload?.if).toBe("always()");
    expect(upload?.with?.name).toContain(revisionExpression);
    expect(workflow.jobs["portable-launch"]?.if).toBe("${{ github.ref == 'refs/heads/main' }}");
    expect(liveSource).toContain('run("git", ["rev-parse", "HEAD"])');
    expect(liveSource).toContain('"network", "rm", disposableNetworkId');
    expect(liveSource).not.toContain('"network", "rm", "--force"');
    expect(liveSource).toContain("retiredUpgradeEndToEnd: false");
    expect(liveSource).toContain("networkDnsServersPresent: false");
    expect(liveSource).toContain("leaseRangePresent: false");
  });
});
