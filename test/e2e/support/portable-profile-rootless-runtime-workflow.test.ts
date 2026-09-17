// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { matchesGlob } from "node:path";

import { describe, expect, it } from "vitest";

import { readRepoText, readYaml, type Workflow } from "../../helpers/e2e-workflow-contract";

type PortableProfileWorkflow = Workflow & {
  on: {
    pull_request: { paths: string[]; types: string[] };
    push: { branches: string[]; paths: string[] };
    workflow_dispatch: null;
  };
};

type SandboxPolicy = {
  filesystem_policy?: { read_only?: string[] };
  process?: { run_as_user?: string; run_as_group?: string };
};

describe("portable profile rootless runtime workflow", () => {
  // source-shape-contract: security -- The rootless-linux install must skip redundant advisory requests on automated runs while manual dispatches retain an explicit audit without a reviewed prerequisite
  it("routes rootless job dependency auditing by workflow trigger (#11028)", () => {
    const workflow = readYaml<PortableProfileWorkflow>(
      ".github/workflows/portable-profile-e2e.yaml",
    );
    const install = workflow.jobs["rootless-linux"]?.steps?.find(
      (step) => step.name === "Install root dependencies",
    );
    const auditedInstall = workflow.jobs["rootless-linux"]?.steps?.find(
      (step) => step.name === "Install root dependencies with audit",
    );

    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(install).toMatchObject({
      if: "github.event_name != 'workflow_dispatch'",
      run: "npm ci --ignore-scripts --no-audit --no-fund",
    });
    expect(auditedInstall).toMatchObject({
      if: "github.event_name == 'workflow_dispatch'",
      run: "npm ci --ignore-scripts --audit --no-fund",
    });
  });

  // source-shape-contract: compatibility -- The workflow and live fixture must keep the accepted OS, Podman, AppArmor, and HTTP local-registry authorities aligned before live E2E
  it("keeps live E2E on the accepted rootless runtime and local registry authority (#9006)", () => {
    const actionlint = readYaml<{ "self-hosted-runner"?: { labels?: string[] } }>(
      ".github/actionlint.yaml",
    );
    const workflow = readYaml<PortableProfileWorkflow>(
      ".github/workflows/portable-profile-e2e.yaml",
    );
    const liveTest = fs.readFileSync(
      "test/e2e/live/portable-profile-rootless-linux.test.ts",
      "utf-8",
    );
    const hermesPolicy = readYaml<SandboxPolicy>(
      "test/e2e/live/hermes-portable-lifecycle-policy.yaml",
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
    const auditedDependencyInstallIndex = steps.findIndex(
      (step) => step.name === "Install root dependencies with audit",
    );
    const catalogueCompileIndex = steps.findIndex((step) => step.run === "npm run catalog:compile");
    const provisionIndex = steps.findIndex(
      (step) => step.name === "Provision restricted rootless Linux runtime",
    );
    const policyIndex = steps.findIndex(
      (step) => step.name === "Apply Ubuntu pasta signal policy correction",
    );
    const hermesBaseIndex = steps.findIndex(
      (step) => step.name === "Build the exact Hermes base for portable validation",
    );
    const hermesBaseBuild = steps[hermesBaseIndex]?.run;
    const liveTestIndex = steps.findIndex(
      (step) => step.name === "Exercise portable profile in the rootless environment",
    );
    const liveStep = steps[liveTestIndex];
    const packageInstallIndex = provision?.indexOf("sudo apt-get install") ?? -1;
    const packageVersionIndex = provision?.indexOf("dpkg-query --show") ?? -1;
    const runtimeVersionIndex = provision?.indexOf("podman --version") ?? -1;
    const actionlintLabels = actionlint["self-hosted-runner"]?.labels;

    expect(job?.["runs-on"]).toBe("ubuntu-26.04");
    expect(workflow.on.pull_request.paths).toEqual(
      expect.arrayContaining([
        "agents/hermes/Dockerfile",
        "agents/hermes/Dockerfile.base",
        "agents/hermes/dashboard-external-host.patch",
        "agents/hermes/start.sh",
        "src/lib/actions/sandbox/forward-recovery.ts",
        "src/lib/actions/sandbox/probe/hermes-portable-forward-adapter-recovery.ts",
        "src/lib/actions/sandbox/start.ts",
        "src/lib/adapters/openshell/command-execution.ts",
        "src/lib/adapters/openshell/forward-cli.ts",
        "src/lib/adapters/openshell/forward.ts",
        "src/lib/onboard/experimental/hermes-portable-build-context-files.ts",
        "src/lib/onboard/experimental/hermes-portable-build-context.ts",
        "src/lib/onboard/experimental/hermes-portable-contract.ts",
        "src/lib/onboard/experimental/hermes-portable-lifecycle.ts",
        "src/lib/onboard/runtime-provider/docker.ts",
      ]),
    );
    expect(Array.isArray(actionlintLabels)).toBe(true);
    expect(actionlintLabels).toContain("ubuntu-26.04");
    expect(job?.env?.PODMAN_APT_VERSION).toBe("5.7.0+ds2-3build1");
    expect(dependencyInstallIndex).toBeGreaterThanOrEqual(0);
    expect(auditedDependencyInstallIndex).toBeGreaterThan(dependencyInstallIndex);
    expect(catalogueCompileIndex).toBeGreaterThan(auditedDependencyInstallIndex);
    expect(provisionIndex).toBeGreaterThan(catalogueCompileIndex);
    expect(policyIndex).toBeGreaterThan(provisionIndex);
    expect(hermesBaseIndex).toBeGreaterThan(policyIndex);
    expect(liveTestIndex).toBeGreaterThan(hermesBaseIndex);
    expect(job?.["timeout-minutes"]).toBe(45);
    expect(steps[hermesBaseIndex]?.env?.XDG_DATA_HOME).toBe(
      "${{ runner.temp }}/nemoclaw-hermes-base-storage",
    );
    expect(liveStep?.env?.E2E_HERMES_BASE_STORAGE_HOME).toBe(
      "${{ runner.temp }}/nemoclaw-hermes-base-storage",
    );
    expect(hermesBaseBuild).toContain("--file agents/hermes/Dockerfile.base");
    expect(hermesBaseBuild).toContain("--tag localhost/nemoclaw-hermes-base:portable-e2e");
    expect(liveStep?.env?.NEMOCLAW_HERMES_E2E_BASE_IMAGE).toBe(
      "localhost/nemoclaw-hermes-base:portable-e2e",
    );
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
    expect(liveTest).toContain(
      'import { OPENSHELL_V0116_QUALIFICATION } from "../fixtures/openshell-v0116-qualification.ts";',
    );
    expect(liveTest).toContain(
      "getDockerSupervisorImage: () => OPENSHELL_V0116_QUALIFICATION.supervisorImage",
    );
    expect(liveTest).not.toContain("OPENSHELL_V0106_QUALIFICATION");
    expect(liveTest).toContain("createHermesPortableBuildContextPlan(");
    expect(liveTest).toContain("baseImageRef: process.env.NEMOCLAW_HERMES_E2E_BASE_IMAGE");
    expect(liveTest).toContain("process.env.E2E_HERMES_BASE_STORAGE_HOME");
    expect(liveTest).toContain('"test/e2e/live/hermes-portable-lifecycle-policy.yaml"');
    expect(liveTest).toContain('".hermes-policy.yaml"');
    expect(liveTest).toContain('flag: "wx"');
    expect(liveTest).toContain("mode: 0o600");
    expect(liveTest).toContain("await streamSandboxCreate(");
    expect(liveTest).toContain("waitForReadyTermination: true");
    expect(hermesPolicy.filesystem_policy?.read_only).toContain("/opt/hermes");
    expect(hermesPolicy.process).toEqual({
      run_as_user: "sandbox",
      run_as_group: "sandbox",
    });
    expect(liveTest).toContain('buildId: "hermes-rootless-e2e"');
    expect(liveTest).toContain("hermesContextPlan.retire(hermesContextInput)");
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

    // Evaluate selection rather than requiring a particular spelling of the filters.
    const selects = (event: "pull_request" | "push", changedPath: string) =>
      workflow.on[event].paths.some((pattern) => matchesGlob(changedPath, pattern));
    expect.soft(selects("pull_request", "src/lib/actions/sandbox/launch.ts")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/actions/sandbox/connect.ts")).toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/onboard/experimental/hermes-portable-receipt.ts"))
      .toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/state/portable-uninstall-retirement.ts"))
      .toBe(true);
    expect.soft(selects("pull_request", "agents/hermes/manifest.yaml")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/actions/sandbox/start.ts")).toBe(true);
    expect.soft(selects("pull_request", "docs/get-started/quickstart.mdx")).toBe(false);
    expect.soft(selects("pull_request", "src/lib/messaging/telegram.ts")).toBe(false);
    expect.soft(selects("push", "src/lib/actions/sandbox/launch.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/actions/sandbox/connect.ts")).toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/experimental/hermes-portable-receipt.ts"))
      .toBe(true);
    expect.soft(selects("push", "src/lib/state/portable-uninstall-retirement.ts")).toBe(true);
    expect.soft(selects("push", "agents/hermes/manifest.yaml")).toBe(true);
    expect.soft(selects("push", "src/lib/actions/sandbox/start.ts")).toBe(true);
    expect.soft(selects("push", "docs/get-started/quickstart.mdx")).toBe(false);
    expect.soft(selects("push", "src/lib/messaging/telegram.ts")).toBe(false);

    expect
      .soft(selects("pull_request", "src/lib/actions/sandbox/launch-readiness/health.ts"))
      .toBe(true);
    expect.soft(selects("pull_request", "src/lib/actions/sandbox/gateway-state.ts")).toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/onboard/portable-retirement-authority.ts"))
      .toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/actions/uninstall/hermes-portable-uninstall.ts"))
      .toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/actions/uninstall/portable-runtime-cleanup.ts"))
      .toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/state/hermes-portable-uninstall/authority.ts"))
      .toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/state/onboard/portable-runtime-authority.ts"))
      .toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/state/registry/lifecycle-generation.ts"))
      .toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/state/registry/lifecycle-generation-cas.ts"))
      .toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/onboard/experimental/portable-demo-lifecycle.ts"))
      .toBe(true);
    expect
      .soft(
        selects(
          "pull_request",
          "src/lib/onboard/experimental/portable-runtime-receipt-readiness.ts",
        ),
      )
      .toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/adapters/openshell/forward-runtime.ts"))
      .toBe(true);
    expect.soft(selects("push", "src/lib/actions/sandbox/launch-readiness/health.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/actions/sandbox/gateway-state.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/onboard/portable-retirement-authority.ts")).toBe(true);
    expect
      .soft(selects("push", "src/lib/actions/uninstall/hermes-portable-uninstall.ts"))
      .toBe(true);
    expect
      .soft(selects("push", "src/lib/actions/uninstall/portable-runtime-cleanup.ts"))
      .toBe(true);
    expect.soft(selects("push", "src/lib/state/hermes-portable-uninstall/authority.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/state/onboard/portable-runtime-authority.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/state/registry/lifecycle-generation.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/state/registry/lifecycle-generation-cas.ts")).toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/experimental/portable-demo-lifecycle.ts"))
      .toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/experimental/portable-runtime-receipt-readiness.ts"))
      .toBe(true);
    expect.soft(selects("push", "src/lib/adapters/openshell/forward-runtime.ts")).toBe(true);

    expect
      .soft(selects("pull_request", "src/lib/onboard/experimental/hermes-portable-container.ts"))
      .toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/onboard/experimental/hermes-portable-onboarding.ts"))
      .toBe(true);
    expect
      .soft(
        selects("pull_request", "src/lib/onboard/experimental/hermes-portable-podman-authority.ts"),
      )
      .toBe(true);
    expect.soft(selects("pull_request", "src/lib/actions/sandbox/exec.ts")).toBe(true);
    expect
      .soft(
        selects(
          "pull_request",
          "src/lib/onboard/experimental/hermes-portable-operating-authority.ts",
        ),
      )
      .toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/onboard/experimental/hermes-portable-policy-state.ts"))
      .toBe(true);
    expect.soft(selects("pull_request", "src/lib/actions/sandbox/stop.ts")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/actions/sandbox/lifecycle/lock.ts")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/cli/nemoclaw-oclif-command.ts")).toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/onboard/experimental/portable-agent-lifecycle.ts"))
      .toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/onboard/experimental/portable-lifecycle-lock.ts"))
      .toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/state/mcp-lifecycle-lock-acquisition.ts"))
      .toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/state/mcp-lifecycle-lock/decisions.ts"))
      .toBe(true);
    expect.soft(selects("pull_request", "src/lib/state/launch-readiness-lease.ts")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/state/registry.ts")).toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/experimental/hermes-portable-container.ts"))
      .toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/experimental/hermes-portable-onboarding.ts"))
      .toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/experimental/hermes-portable-podman-authority.ts"))
      .toBe(true);
    expect.soft(selects("push", "src/lib/actions/sandbox/exec.ts")).toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/experimental/hermes-portable-operating-authority.ts"))
      .toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/experimental/hermes-portable-policy-state.ts"))
      .toBe(true);
    expect.soft(selects("push", "src/lib/actions/sandbox/stop.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/actions/sandbox/lifecycle/lock.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/cli/nemoclaw-oclif-command.ts")).toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/experimental/portable-agent-lifecycle.ts"))
      .toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/experimental/portable-lifecycle-lock.ts"))
      .toBe(true);
    expect.soft(selects("push", "src/lib/state/mcp-lifecycle-lock-acquisition.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/state/mcp-lifecycle-lock/decisions.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/state/launch-readiness-lease.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/state/registry.ts")).toBe(true);
    expect.soft(selects("push", "agents/hermes/Dockerfile")).toBe(true);
    expect.soft(selects("push", "agents/hermes/start.sh")).toBe(true);
    expect.soft(selects("push", "agents/hermes/dashboard-external-host.patch")).toBe(true);
    expect
      .soft(selects("push", "test/e2e/support/portable-profile-rootless-runtime-workflow.test.ts"))
      .toBe(true);

    expect.soft(selects("pull_request", "src/lib/state/registry/route-reservation.ts")).toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/state/registry/pending-create-identity.ts"))
      .toBe(true);
    expect.soft(selects("pull_request", "src/lib/state/registry/persistence.ts")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/state/registry/lock.ts")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/state/registry/types.ts")).toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/onboard/experimental/portable-runtime-readiness.ts"))
      .toBe(true);
    expect
      .soft(
        selects(
          "pull_request",
          "src/lib/onboard/experimental/portable-cpu-delegation-preflight.ts",
        ),
      )
      .toBe(true);
    expect.soft(selects("pull_request", "src/lib/onboard/docker-driver-platform.ts")).toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/onboard/experimental/docker-network-authority.ts"))
      .toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/onboard/runtime-provider/podman-lifecycle.ts"))
      .toBe(true);
    expect.soft(selects("pull_request", "src/lib/adapters/podman/index.ts")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/adapters/podman/socket-authority.ts")).toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/adapters/podman/executable-authority.ts"))
      .toBe(true);
    expect.soft(selects("push", "src/lib/state/registry/route-reservation.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/state/registry/pending-create-identity.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/state/registry/persistence.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/state/registry/lock.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/state/registry/types.ts")).toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/experimental/portable-runtime-readiness.ts"))
      .toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/experimental/portable-cpu-delegation-preflight.ts"))
      .toBe(true);
    expect.soft(selects("push", "src/lib/onboard/docker-driver-platform.ts")).toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/experimental/docker-network-authority.ts"))
      .toBe(true);
    expect.soft(selects("push", "src/lib/onboard/runtime-provider/podman-lifecycle.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/adapters/podman/index.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/adapters/podman/socket-authority.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/adapters/podman/executable-authority.ts")).toBe(true);

    expect.soft(selects("pull_request", "src/lib/actions/sandbox/destroy.ts")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/actions/sandbox/destroy-execution.ts")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/actions/sandbox/destroy-presence.ts")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/domain/sandbox/destroy.ts")).toBe(true);
    expect
      .soft(
        selects(
          "pull_request",
          "src/lib/actions/sandbox/probe/hermes-portable-inference-recovery.ts",
        ),
      )
      .toBe(true);
    expect
      .soft(
        selects("pull_request", "src/lib/onboard/experimental/hermes-portable-ollama-inference.ts"),
      )
      .toBe(true);
    expect
      .soft(
        selects("pull_request", "src/lib/onboard/experimental/hermes-portable-ollama-authority.ts"),
      )
      .toBe(true);
    expect
      .soft(
        selects(
          "pull_request",
          "src/lib/onboard/experimental/hermes-portable-ollama-gateway-transaction.ts",
        ),
      )
      .toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/onboard/runtime-provider/host-local-inference.ts"))
      .toBe(true);
    expect
      .soft(
        selects(
          "pull_request",
          "src/lib/onboard/runtime-provider/host-local-inference-lifecycle.ts",
        ),
      )
      .toBe(true);
    expect
      .soft(
        selects("pull_request", "src/lib/onboard/runtime-provider/host-local-inference-routing.ts"),
      )
      .toBe(true);
    expect.soft(selects("pull_request", "src/lib/onboard/runtime-provider/podman.ts")).toBe(true);
    expect
      .soft(
        selects("pull_request", "src/lib/onboard/runtime-provider/podman-host-local-inference.ts"),
      )
      .toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/onboard/runtime-provider/podman-preflight.ts"))
      .toBe(true);
    expect
      .soft(
        selects("pull_request", "src/lib/onboard/runtime-provider/persisted-engine-authority.ts"),
      )
      .toBe(true);
    expect.soft(selects("pull_request", "src/lib/onboard/docker-driver-gateway-env.ts")).toBe(true);
    expect
      .soft(selects("pull_request", "src/lib/onboard/docker-driver-gateway-local-tls.ts"))
      .toBe(true);
    expect.soft(selects("pull_request", "src/lib/onboard/build-context-stage.ts")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/onboard/sandbox-prebuild.ts")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/sandbox/build-context.ts")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/sandbox/create-stream.ts")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/adapters/openshell/resolve-shared.ts")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/adapters/openshell/timeouts.ts")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/agent/defs.ts")).toBe(true);
    expect.soft(selects("pull_request", "src/lib/core/retry.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/actions/sandbox/destroy.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/actions/sandbox/destroy-execution.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/actions/sandbox/destroy-presence.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/domain/sandbox/destroy.ts")).toBe(true);
    expect
      .soft(selects("push", "src/lib/actions/sandbox/probe/hermes-portable-inference-recovery.ts"))
      .toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/experimental/hermes-portable-ollama-inference.ts"))
      .toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/experimental/hermes-portable-ollama-authority.ts"))
      .toBe(true);
    expect
      .soft(
        selects(
          "push",
          "src/lib/onboard/experimental/hermes-portable-ollama-gateway-transaction.ts",
        ),
      )
      .toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/runtime-provider/host-local-inference.ts"))
      .toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/runtime-provider/host-local-inference-lifecycle.ts"))
      .toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/runtime-provider/host-local-inference-routing.ts"))
      .toBe(true);
    expect.soft(selects("push", "src/lib/onboard/runtime-provider/podman.ts")).toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/runtime-provider/podman-host-local-inference.ts"))
      .toBe(true);
    expect.soft(selects("push", "src/lib/onboard/runtime-provider/podman-preflight.ts")).toBe(true);
    expect
      .soft(selects("push", "src/lib/onboard/runtime-provider/persisted-engine-authority.ts"))
      .toBe(true);
    expect.soft(selects("push", "src/lib/onboard/docker-driver-gateway-env.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/onboard/docker-driver-gateway-local-tls.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/onboard/build-context-stage.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/onboard/sandbox-prebuild.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/sandbox/build-context.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/sandbox/create-stream.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/adapters/openshell/resolve-shared.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/adapters/openshell/timeouts.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/agent/defs.ts")).toBe(true);
    expect.soft(selects("push", "src/lib/core/retry.ts")).toBe(true);

    expect(workflow.on.pull_request.types).toEqual(["opened", "synchronize", "reopened"]);
    expect(workflow.on.push.paths).toContain("tools/e2e/full-e2e-timeout-contract.mts");
    expect(workflow.on.pull_request.paths).not.toContain("tools/e2e/full-e2e-timeout-contract.mts");
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
    expect(workflow.jobs["portable-launch"]?.["timeout-minutes"]).toBe(135);
    expect(liveSource).toContain('run("git", ["rev-parse", "HEAD"])');
    expect(liveSource).toContain('"network", "rm", disposableNetworkId');
    expect(liveSource).not.toContain('"network", "rm", "--force"');
    expect(liveSource).toContain("retiredUpgradeEndToEnd: false");
    expect(liveSource).toContain("networkDnsServersPresent: false");
    expect(liveSource).toContain("leaseRangePresent: false");
  });
});
