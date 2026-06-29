// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
};

type WorkflowJob = {
  env?: Record<string, string>;
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, string>;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const LAUNCHABLE = path.join(REPO_ROOT, "scripts", "brev-launchable-ci-cpu.sh");

function readWorkflow(relativePath: string): Workflow {
  return YAML.parse(fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8")) as Workflow;
}

function namedStep(workflow: Workflow, job: string, name: string): WorkflowStep {
  const step = workflow.jobs[job]?.steps?.find((candidate) => candidate.name === name);
  expect(step, `${job} must include step '${name}'`).toBeDefined();
  return step as WorkflowStep;
}

function runCommand(script: string, env: Record<string, string>) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-channel-workflow-"));
  const githubEnv = path.join(tempDir, "github-env");
  fs.writeFileSync(githubEnv, "", "utf8");
  try {
    return spawnSync("bash", ["-c", script], {
      cwd: tempDir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_ENV: githubEnv,
        ...env,
      },
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function resolveLaunchableVersion(options: { channel: string; explicit?: string }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-launchable-channel-"));
  const fakeBin = path.join(tempDir, "bin");
  fs.mkdirSync(fakeBin);
  const getent = path.join(fakeBin, "getent");
  fs.writeFileSync(
    getent,
    "#!/usr/bin/env bash\nprintf 'tester:x:501:20:tester:%s:/bin/bash\\n' \"$HOME\"\n",
    { encoding: "utf8", mode: 0o755 },
  );
  try {
    return spawnSync("bash", [LAUNCHABLE, "--print-openshell-version"], {
      encoding: "utf8",
      env: {
        HOME: tempDir,
        LAUNCH_LOG: path.join(tempDir, "launch.log"),
        LOGNAME: "tester",
        NEMOCLAW_OPENSHELL_CHANNEL: options.channel,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        SUDO_USER: "tester",
        USER: "tester",
        ...(options.explicit === undefined ? {} : { OPENSHELL_VERSION: options.explicit }),
      },
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("OpenShell channel workflow boundary", () => {
  it("rejects lane-local attempts to replace the selected channel", () => {
    const reusable = readWorkflow(".github/workflows/e2e-script.yaml");
    const envJsonExport = namedStep(reusable, "run", "Export script environment");
    const envJsonResult = runCommand(envJsonExport.run ?? "", {
      E2E_ENV_JSON: JSON.stringify({ NEMOCLAW_OPENSHELL_CHANNEL: "stable" }),
    });
    expect(envJsonResult.status).not.toBe(0);
    expect(`${envJsonResult.stdout}${envJsonResult.stderr}`).toContain(
      "Reserved env_json variable name: NEMOCLAW_OPENSHELL_CHANNEL",
    );

    const refExport = namedStep(reusable, "run", "Export checked-out ref environment");
    const refResult = runCommand(refExport.run ?? "", {
      E2E_CHECKED_OUT_REF_ENV: "NEMOCLAW_OPENSHELL_CHANNEL",
    });
    expect(refResult.status).not.toBe(0);
    expect(`${refResult.stdout}${refResult.stderr}`).toContain(
      "Reserved checked_out_ref_env variable name: NEMOCLAW_OPENSHELL_CHANNEL",
    );
  });

  it.each([
    { channel: "dev", expected: "dev" },
    { channel: "stable", expected: "v0.0.72" },
    { channel: "auto", expected: "v0.0.72" },
    { channel: "dev", explicit: "v9.9.9", expected: "v9.9.9" },
  ])("resolves launchable channel $channel to $expected", ({ channel, explicit, expected }) => {
    const result = resolveLaunchableVersion({ channel, explicit });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  });

  it("rejects an invalid launchable channel", () => {
    const result = resolveLaunchableVersion({ channel: "artifact" });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "NEMOCLAW_OPENSHELL_CHANNEL must be one of: stable, dev, auto",
    );
  });
});
