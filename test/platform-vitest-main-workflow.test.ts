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
const MACOS_REQUIREMENTS_PATH = "ci/platform-vitest-macos-requirements.lock";
const workflow = readYaml<Workflow>(WORKFLOW_PATH);

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
  // source-shape-contract: compatibility -- macOS must use the same modern shell/tool semantics as the Linux sandbox fixtures
  it("provisions the pinned macOS test runtime before running the full suite", () => {
    const stepNames = job("macos-vitest").steps?.map((entry) => entry.name) ?? [];
    const checkout = step("macos-vitest", "Checkout");
    const setupPython = step("macos-vitest", "Setup Python");
    const install = step("macos-vitest", "Install macOS test dependencies");
    const run = install.run ?? "";

    expect(job("macos-vitest")["timeout-minutes"]).toBe(60);
    expect(checkout.with).toMatchObject({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(stepNames.indexOf("Setup Python")).toBeLessThan(
      stepNames.indexOf("Install macOS test dependencies"),
    );
    expect(stepNames.indexOf("Install macOS test dependencies")).toBeLessThan(
      stepNames.indexOf("Run full Vitest suite on macOS"),
    );
    expect(setupPython.uses).toBe("actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1");
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
    const checkout = step("wsl-vitest", "Checkout");
    const install = step("wsl-vitest", "Install Ubuntu dependencies").run ?? "";
    const fullSuite = step("wsl-vitest", "Run full Vitest suite in WSL").run ?? "";
    const rootSuite = step("wsl-vitest", "Run root-required Vitest contracts in WSL").run ?? "";

    expect(job("wsl-vitest")["timeout-minutes"]).toBe(60);
    expect(checkout.with).toMatchObject({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(stepNames.indexOf("Install Ubuntu dependencies")).toBeLessThan(
      stepNames.indexOf("Run full Vitest suite in WSL"),
    );
    expect(install).toMatch(/apt-get install[^\n]*\bpython3-venv\b/u);
    expect(install).toMatch(/apt-get install[^\n]*\bripgrep\b/u);
    expect(install).not.toMatch(/\bsudo\b|sudoers|NOPASSWD/u);
    expect(fullSuite).toContain("--user $env:WSL_TEST_USER");
    expect(fullSuite).toContain("NEMOCLAW_EXEC_TIMEOUT=60000");
    expect(fullSuite).toContain("NEMOCLAW_TEST_TIMEOUT=60000");
    expect(fullSuite).not.toMatch(/\bsudo\b|sudoers|NOPASSWD/u);
    expect(rootSuite).toContain("--user root");
    expect([...rootSuite.matchAll(/-t '([^']+)'/gu)].map((match) => match[1])).toEqual([
      "keeps the locked Hermes entry sticky-protected|lets a sandbox-group peer create state",
      "requires both fixed files to match|reclaims a root-owned collapsed config|leaves a root-owned recovery baseline untouched",
    ]);
  });
});
