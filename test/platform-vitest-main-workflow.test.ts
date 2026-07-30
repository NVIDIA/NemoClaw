// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readRepoText,
  readYaml,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from "./helpers/e2e-workflow-contract";

const WORKFLOW_PATH = ".github/workflows/platform-vitest-main.yaml";
const WSL_E2E_WORKFLOW_PATH = ".github/workflows/wsl-e2e.yaml";
const WSL_HELPER_PATH = "tools/wsl/ci-helper.ps1";
const MACOS_REQUIREMENTS_PATH = "ci/platform-vitest-macos-requirements.lock";
const workflow = readYaml<Workflow>(WORKFLOW_PATH);
const wslE2eWorkflow = readYaml<Workflow>(WSL_E2E_WORKFLOW_PATH);
const wslHelperSource = readRepoText(WSL_HELPER_PATH);

function job(name: string): WorkflowJob {
  const candidate = workflow.jobs[name];
  expect(candidate, `missing ${name} job`).toBeDefined();
  return candidate;
}

function step(jobName: string, name: string): WorkflowStep {
  const candidate = job(jobName).steps?.find((entry) => entry.name === name);
  expect(candidate, `missing ${jobName} step ${name}`).toBeDefined();
  return candidate!;
}

describe("platform Vitest main workflow", () => {
  // source-shape-contract: security -- The trusted helper installs only checksum-verified official Node.js archives
  it("pins and verifies the Node.js archive in the trusted WSL helper", () => {
    const installSteps = [{ run: wslHelperSource }];

    for (const installStep of installSteps) {
      expect(installStep, "missing WSL Node.js install step").toBeDefined();
      const run = installStep?.run ?? "";
      expect(run).toContain('node_version="22.23.1"');
      expect(run).toMatch(
        /x86_64\)[\s\S]*?node_arch="x64"[\s\S]*?node_sha256="9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578"[\s\S]*?;;/u,
      );
      expect(run).toMatch(
        /aarch64 \| arm64\)[\s\S]*?node_arch="arm64"[\s\S]*?node_sha256="0294e8b915ab75f92c7513d2fcb830ae06e10684e6c603e99a87dbf8835389c1"[\s\S]*?;;/u,
      );
      expect(run).toContain(
        'node_url="https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-${node_arch}.tar.xz"',
      );
      expect(run).toContain('temp_dir="$(mktemp -d)"');
      expect(run).toContain(`trap 'rm -rf "$temp_dir"' EXIT`);
      expect(run).toContain("--proto '=https'");
      expect(run).toContain("--connect-timeout 15");
      expect(run).toContain("--max-time 180");
      expect(run).toContain("--retry 3");
      expect(run).toContain("--retry-max-time 240");
      expect(run).toContain("sha256sum --check --status");
      expect(run.indexOf("sha256sum --check --status")).toBeLessThan(run.indexOf("tar --extract"));
      expect(run).toContain('test "$(node --version)" = "v${node_version}"');
      expect(run).toContain("Unsupported Node.js architecture");
      expect(run).not.toContain("deb.nodesource.com");
      expect(run).not.toMatch(/\bcurl\b[^\n]*\|\s*bash\b/u);
    }
    expect(step("wsl-vitest", "Install Node.js 22 in WSL").run).toContain("Install-WslNode");
    expect(
      wslE2eWorkflow.jobs["wsl-e2e"]?.steps?.find(
        (entry) => entry.name === "Install Node.js 22 in WSL",
      )?.run,
    ).toContain("Install-WslNode");
  });

  // source-shape-contract: security -- Sparse immutable helper checkouts must precede candidate code before root-capable WSL execution
  it("loads the WSL helper from trusted revisions before candidate execution (#6958)", () => {
    expect(
      (workflow as Workflow & { on?: Record<string, unknown> }).on,
      "platform main-watch workflow must not execute candidate code on pull requests",
    ).not.toHaveProperty("pull_request");

    const cases = [
      {
        helperRef: "${{ github.workflow_sha }}",
        job: job("wsl-vitest"),
      },
      {
        helperRef:
          "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.workflow_sha }}",
        job: wslE2eWorkflow.jobs["wsl-e2e"],
      },
    ];

    for (const workflowCase of cases) {
      expect(workflowCase.job, "missing WSL job").toBeDefined();
      const steps = workflowCase.job?.steps ?? [];
      const trustedCheckout = steps.find(
        (entry) => entry.name === "Check out the trusted WSL helper",
      );
      const candidateCheckout = steps.find((entry) => entry.name === "Check out candidate source");
      expect(trustedCheckout?.with).toMatchObject({
        ref: workflowCase.helperRef,
        path: "trusted-wsl-ci",
        "persist-credentials": false,
        "sparse-checkout": `${WSL_HELPER_PATH}\n`,
        "sparse-checkout-cone-mode": false,
      });
      expect(candidateCheckout?.with).toMatchObject({
        path: "source",
        "persist-credentials": false,
      });
      expect(steps.map((entry) => entry.name)).not.toContain("Detect trusted WSL helper");
      expect(steps.map((entry) => entry.name)).not.toContain(
        "Explain deferred trusted WSL helper rollout",
      );
      expect(
        steps.some((entry) => (entry.if ?? "").includes("steps.helper.outputs.present")),
        "missing trusted helper must fail instead of skipping candidate validation",
      ).toBe(false);
      expect(steps.indexOf(trustedCheckout!)).toBeLessThan(steps.indexOf(candidateCheckout!));

      for (const entry of steps.filter((candidate) =>
        /(?:Ensure|Install|Invoke|Sync)-Wsl/u.test(candidate.run ?? ""),
      )) {
        expect(entry.run, `${entry.name} must load the trusted helper`).toContain(
          '. "$env:TRUSTED_WSL_HELPER"',
        );
      }
    }

    expect(readRepoText(WORKFLOW_PATH)).not.toMatch(/WriteAllText|wslpath|wsl\s+--install/u);
    expect(readRepoText(WSL_E2E_WORKFLOW_PATH)).not.toMatch(
      /WriteAllText|wslpath|wsl\s+--install/u,
    );
  });

  // source-shape-contract: compatibility -- macOS must use the same modern shell/tool semantics as the Linux sandbox fixtures
  it("provisions the pinned macOS test runtime before running the full suite", () => {
    const stepNames = job("macos-vitest").steps?.map((entry) => entry.name) ?? [];
    const checkout = step("macos-vitest", "Checkout");
    const setupPython = step("macos-vitest", "Setup Python");
    const install = step("macos-vitest", "Install macOS test dependencies");
    const installOpenShell = step("macos-vitest", "Install pinned OpenShell");
    const run = install.run ?? "";

    expect(job("macos-vitest")["timeout-minutes"]).toBe(30);
    expect(job("macos-vitest").strategy).toMatchObject({
      "fail-fast": false,
      matrix: { shard: [1, 2, 3, 4] },
    });
    expect(checkout.with).toMatchObject({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(stepNames.indexOf("Setup Python")).toBeLessThan(
      stepNames.indexOf("Install macOS test dependencies"),
    );
    expect(stepNames.indexOf("Install macOS test dependencies")).toBeLessThan(
      stepNames.indexOf("Install pinned OpenShell"),
    );
    expect(stepNames.indexOf("Install pinned OpenShell")).toBeLessThan(
      stepNames.indexOf("Run full Vitest suite on macOS"),
    );
    expect(setupPython.uses).toBe("actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97");
    expect(setupPython.with).toMatchObject({
      "python-version": "3.14",
      cache: "pip",
      "cache-dependency-path": MACOS_REQUIREMENTS_PATH,
    });
    for (const dependency of ["bash", "coreutils", "fd", "gawk", "ripgrep"]) {
      expect(run).toMatch(new RegExp(`brew install[^\\n]*\\b${dependency}\\b`, "u"));
    }
    expect(run).toContain("$(brew --prefix bash)/bin");
    expect(run).toContain("$(brew --prefix coreutils)/libexec/gnubin");
    expect(run).toContain("$(brew --prefix gawk)/libexec/gnubin");
    expect(run).toContain("--only-binary=:all:");
    expect(run).toContain("--require-hashes");
    expect(run).toContain(`--requirement ${MACOS_REQUIREMENTS_PATH}`);
    expect(installOpenShell.env).toMatchObject({
      NEMOCLAW_NON_INTERACTIVE: "1",
    });
    expect(installOpenShell.run).toBe(
      "env -u GH_TOKEN -u GITHUB_TOKEN bash scripts/install-openshell.sh",
    );
    expect(step("macos-vitest", "Run full Vitest suite on macOS").run).toContain(
      '--shard="${{ matrix.shard }}/4"',
    );

    const requirements = readRepoText(MACOS_REQUIREMENTS_PATH);
    expect(requirements).toContain("pyyaml==6.0.3");
    expect(requirements).toContain(
      "sha256:34d5fcd24b8445fadc33f9cf348c1047101756fd760b4dacb5c3e99755703310",
    );
    expect(requirements).toContain("setuptools==82.0.1");
    expect(requirements).toContain(
      "sha256:a59e362652f08dcd477c78bb6e7bd9d80a7995bc73ce773050228a348ce2e5bb",
    );
  });

  // source-shape-contract: security -- ordinary tests stay non-root while the five UID-0 contracts remain isolated
  it("keeps the WSL suite unprivileged with explicit root-only contracts", () => {
    const stepNames = job("wsl-vitest").steps?.map((entry) => entry.name) ?? [];
    const checkout = step("wsl-vitest", "Check out candidate source");
    const install = step("wsl-vitest", "Install Ubuntu dependencies").run ?? "";
    const fullSuite = step("wsl-vitest", "Run full Vitest suite in WSL").run ?? "";
    const rootSuite = step("wsl-vitest", "Run root-required Vitest contracts in WSL").run ?? "";

    expect(job("wsl-vitest")["timeout-minutes"]).toBe(90);
    expect(job("wsl-vitest").strategy).toMatchObject({
      "fail-fast": false,
      matrix: { shard: [1, 2, 3, 4] },
    });
    expect(checkout.with).toMatchObject({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(stepNames.indexOf("Install Ubuntu dependencies")).toBeLessThan(
      stepNames.indexOf("Run full Vitest suite in WSL"),
    );
    expect(install).toContain("Install-WslUbuntuDependencies");
    expect(install).toContain("'python3-venv'");
    expect(install).toContain("'ripgrep'");
    expect(wslHelperSource).toContain("apt-get install -y $packageList");
    expect(install).not.toMatch(/\bsudo\b|sudoers|NOPASSWD/u);
    expect(fullSuite).toContain("-User $env:WSL_TEST_USER");
    expect(fullSuite).toContain("NEMOCLAW_EXEC_TIMEOUT=60000");
    expect(fullSuite).toContain("NEMOCLAW_TEST_TIMEOUT=60000");
    expect(fullSuite).toContain("--shard='${{ matrix.shard }}/4'");
    expect(fullSuite).not.toMatch(/\bsudo\b|sudoers|NOPASSWD/u);
    expect(rootSuite).toContain("-User root");
    expect(step("wsl-vitest", "Run root-required Vitest contracts in WSL").if).toBe(
      "${{ matrix.shard == 1 }}",
    );
    expect([...rootSuite.matchAll(/-t '([^']+)'/gu)].map((match) => match[1])).toEqual([
      "keeps the locked Hermes entry sticky-protected|lets a sandbox-group peer create state",
      "requires both fixed files to match|reclaims a root-owned collapsed config|leaves a root-owned recovery baseline untouched",
    ]);
  });
});
