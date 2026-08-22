// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
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

  // source-shape-contract: compatibility -- portable-launch must reject package, executable, client, or service version drift before nested BuildKit starts
  it("pins the Portable launch runtime and rejects runtime identity drift (#9006)", () => {
    const workflow = readYaml<Workflow>(".github/workflows/portable-profile-e2e.yaml");
    const job = workflow.jobs["portable-launch"];
    const steps = job?.steps ?? [];
    const provisionIndex = steps.findIndex(
      (step) => step.name === "Provision restricted rootless Linux runtime",
    );
    const policyIndex = steps.findIndex(
      (step) => step.name === "Apply Ubuntu pasta signal policy correction",
    );
    const buildkitIndex = steps.findIndex(
      (step) => step.name === "Prove nested BuildKit on the portable Podman socket",
    );
    const provision = steps[provisionIndex]?.run ?? "";
    const policy = steps[policyIndex]?.run ?? "";
    const receiptStart = provision.indexOf('receipt="${RUNNER_TEMP}/');
    const identityStart = provision.indexOf('package_version="$(dpkg-query');
    const identityEnd = provision.indexOf('\nruntime_dir="', identityStart);
    const identityCheck = provision.slice(identityStart, identityEnd);
    const serviceIdentityStart = provision.indexOf('service_version="$(docker --host');
    const serviceIdentityCheck = provision.slice(serviceIdentityStart);
    const accepted = {
      packageVersion: "5.7.0+ds2-3build1",
      runtimePath: "/usr/bin/podman",
      runtimeVersion: "podman version 5.7.0",
    };
    const runIdentityCheck = (identity: typeof accepted) =>
      spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
dpkg-query() { printf '%s' "$FAKE_PACKAGE_VERSION"; }
podman() { printf '%s\\n' "$FAKE_RUNTIME_VERSION"; }
readlink() { printf '%s\\n' "$FAKE_RUNTIME_PATH"; }
${identityCheck}`,
        ],
        {
          encoding: "utf8",
          env: {
            FAKE_PACKAGE_VERSION: identity.packageVersion,
            FAKE_RUNTIME_PATH: identity.runtimePath,
            FAKE_RUNTIME_VERSION: identity.runtimeVersion,
            PATH: process.env.PATH ?? "",
            PODMAN_APT_VERSION: accepted.packageVersion,
          },
          killSignal: "SIGKILL",
          timeout: 5_000,
        },
      );
    const runServiceIdentityCheck = (serviceVersion: string) =>
      spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
docker() { printf '%s\\n' "$FAKE_SERVICE_VERSION"; }
${serviceIdentityCheck}`,
        ],
        {
          encoding: "utf8",
          env: {
            DOCKER_HOST: "unix:///test/podman.sock",
            FAKE_SERVICE_VERSION: serviceVersion,
            PATH: process.env.PATH ?? "",
          },
          killSignal: "SIGKILL",
          timeout: 5_000,
        },
      );

    expect(job?.["runs-on"]).toBe("ubuntu-26.04");
    expect(job?.env?.PODMAN_APT_VERSION).toBe(accepted.packageVersion);
    expect([
      provisionIndex,
      policyIndex,
      buildkitIndex,
      receiptStart,
      identityStart,
      identityEnd,
      serviceIdentityStart,
    ]).not.toContain(-1);
    expect(policyIndex).toBeGreaterThan(provisionIndex);
    expect(buildkitIndex).toBeGreaterThan(policyIndex);
    expect(receiptStart).toBeLessThan(identityStart);
    expect(provision).toContain("apparmor");
    expect(provision).toContain('"podman=$PODMAN_APT_VERSION"');
    expect(provision).toContain('runtime_path="$(readlink -f "$(command -v podman)")"');
    expect(provision).toContain('service_version="$(docker --host "$DOCKER_HOST" version');
    expect(provision).toContain("Portable Podman service version mismatch:");
    expect(policy).toContain("/etc/apparmor.d/usr.bin.pasta");
    expect(policy).toContain("signal (receive) peer=podman,");
    expect(policy).toContain('apparmor_parser -r "$pasta_profile"');
    expect(runIdentityCheck(accepted).status).toBe(0);
    expect(runServiceIdentityCheck("5.7.0").status).toBe(0);

    [
      { ...accepted, packageVersion: "4.9.3+ds1-1ubuntu0.2" },
      { ...accepted, runtimePath: "/usr/local/bin/podman" },
      { ...accepted, runtimeVersion: "podman version 5.8.4" },
    ].forEach((identity) => {
      const rejected = runIdentityCheck(identity);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("Portable Podman runtime identity mismatch:");
    });
    const rejectedService = runServiceIdentityCheck("5.8.4");
    expect(rejectedService.status).not.toBe(0);
    expect(rejectedService.stderr).toContain(
      "Portable Podman service version mismatch: expected 5.7.0; observed: 5.8.4",
    );
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
