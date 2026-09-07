// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  validateE2eWorkflow,
  validateHostDependencyAction,
} from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow as readE2eWorkflow } from "../../helpers/e2e-workflow-contract.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ACTION_PATH = path.join(
  REPO_ROOT,
  ".github",
  "actions",
  "host-dependency-setup",
  "action.yaml",
);
const SCRIPT_PATH = path.join(REPO_ROOT, ".github", "scripts", "host-dependency-setup.sh");
const ACTION_USES =
  "NVIDIA/NemoClaw/.github/actions/host-dependency-setup@4def1501b34ce586f83b91af50a66b5d22b31d75";

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
}

interface Workflow {
  jobs: Record<string, { steps: WorkflowStep[] }>;
}

function readWorkflow(): Workflow {
  return readE2eWorkflow() as unknown as Workflow;
}

function throwMissingStep(stepName: string): never {
  throw new Error(`${stepName} step is missing`);
}

function requireStepIndex(steps: WorkflowStep[], stepName: string): number {
  const index = steps.findIndex((step) => step.name === stepName);
  return index >= 0 ? index : throwMissingStep(stepName);
}

function validateActionMutation(options: {
  mutateAction?: (source: string) => string;
  mutateScript?: (source: string) => string;
}): string[] {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-dependency-action-"));
  const actionPath = path.join(directory, "action.yaml");
  const scriptPath = path.join(directory, "host-dependency-setup.sh");
  try {
    const actionSource = fs.readFileSync(ACTION_PATH, "utf8");
    fs.writeFileSync(actionPath, options.mutateAction?.(actionSource) ?? actionSource);
    const scriptSource = fs.readFileSync(SCRIPT_PATH, "utf8");
    fs.writeFileSync(scriptPath, options.mutateScript?.(scriptSource) ?? scriptSource);
    return validateHostDependencyAction(actionPath, scriptPath);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
}

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source);
  fs.chmodSync(filePath, 0o755);
}

describe("E2E host dependency action boundary (#6961)", () => {
  it.each([
    {
      jobName: "live",
      stepName: "Install Deep Agents Code TUI host dependencies",
      packages: "expect",
    },
    {
      jobName: "cloud-onboard",
      stepName: "Install cloud-onboard DCode TUI host dependencies",
      packages: "expect",
    },
  ])("rejects package allowlist drift in $jobName", ({ jobName, stepName, packages }) => {
    const workflow = readWorkflow();
    const install = workflow.jobs[jobName]?.steps.find((step) => step.name === stepName)!;
    install.with = { ...(install.with ?? {}), packages: `${packages} curl` };
    expect(validateE2eWorkflow(workflow)).toContain(
      `${jobName} host dependency install must map only '${packages}'`,
    );
  });

  it("rejects host dependency setup that abandons the pinned action", () => {
    const workflow = readWorkflow();
    const install = workflow.jobs.live?.steps.find(
      (step) => step.name === "Install Deep Agents Code TUI host dependencies",
    )!;
    install.with = undefined;
    install.uses =
      "NVIDIA/NemoClaw/.github/actions/host-dependency-setup@0000000000000000000000000000000000000000";
    expect(validateE2eWorkflow(workflow)).toContain(
      `live host dependency setup must invoke only ${ACTION_USES}`,
    );
  });

  it("rejects host dependency setup that tolerates failure with continue-on-error", () => {
    const workflow = readWorkflow();
    const install = workflow.jobs.live?.steps.find(
      (step) => step.name === "Install Deep Agents Code TUI host dependencies",
    )!;
    install["continue-on-error"] = true;
    expect(validateE2eWorkflow(workflow)).toContain("live host dependency setup must fail closed");
  });

  it.each(["", "   ", "expect\ncurl", "curl"])(
    "executes the host helper with validated packages and bounded retries [%s] (#6961)",
    (invalidPackages) => {
      expect(fs.statSync(SCRIPT_PATH).mode & 0o111).not.toBe(0);
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-host-dependency-script-"));
      const fakeBin = path.join(directory, "bin");
      const callsPath = path.join(directory, "sudo-calls");
      fs.mkdirSync(fakeBin);
      writeExecutable(path.join(fakeBin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
      writeExecutable(
        path.join(fakeBin, "sudo"),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "\${SUDO_CALLS}"
if [[ "$1 $2" == "apt-get update" ]]; then
  attempt="$(grep -c '^apt-get update$' "\${SUDO_CALLS}")"
  if [[ "\${attempt}" -lt "\${APT_UPDATE_SUCCESS_ATTEMPT}" ]]; then
    exit 1
  fi
  exit 0
fi
if [[ "$1 $2" == "apt-get install" ]]; then
  exit 0
fi
exit 64
`,
      );

      const runSetup = (packages: string, successAttempt = 1, args: string[] = []) => {
        fs.rmSync(callsPath, { force: true });
        return spawnSync(SCRIPT_PATH, args, {
          encoding: "utf8",
          env: {
            ...process.env,
            APT_UPDATE_SUCCESS_ATTEMPT: String(successAttempt),
            HOST_DEPENDENCY_PACKAGES: packages,
            PATH: `${fakeBin}:${process.env.PATH}`,
            SUDO_CALLS: callsPath,
          },
        });
      };

      try {
        const unexpectedArgument = runSetup("expect", 1, ["unexpected"]);
        expect(unexpectedArgument.status).toBe(1);
        expect(unexpectedArgument.stderr).toContain("does not accept arguments");
        expect(fs.existsSync(callsPath)).toBe(false);

        const rejected = runSetup(invalidPackages);
        expect(rejected.status).toBe(1);
        expect(fs.existsSync(callsPath)).toBe(false);

        const retried = runSetup("expect iptables", 3);
        expect(retried.status, retried.stderr).toBe(0);
        expect(fs.readFileSync(callsPath, "utf8").trim().split("\n")).toEqual([
          "apt-get update",
          "apt-get update",
          "apt-get update",
          "apt-get install -y --no-install-recommends expect iptables",
        ]);

        const exhausted = runSetup("expect", 4);
        expect(exhausted.status).toBe(1);
        expect(fs.readFileSync(callsPath, "utf8").trim().split("\n")).toEqual([
          "apt-get update",
          "apt-get update",
          "apt-get update",
        ]);
        expect(`${exhausted.stdout}${exhausted.stderr}`).toContain(
          "apt-get update failed after 3 attempts",
        );
      } finally {
        fs.rmSync(directory, { force: true, recursive: true });
      }
    },
  );

  it("keeps cloud-onboard host dependencies before workspace preparation", () => {
    const workflow = readWorkflow();
    const steps = workflow.jobs["cloud-onboard"].steps;
    const installIndex = requireStepIndex(
      steps,
      "Install cloud-onboard DCode TUI host dependencies",
    );
    const install = steps.splice(installIndex, 1)[0]!;
    const prepareIndex = requireStepIndex(steps, "Prepare E2E workspace");
    steps.splice(prepareIndex + 1, 0, install);
    expect(validateE2eWorkflow(workflow)).toContain(
      "cloud-onboard DCode TUI host dependencies must precede workspace prep",
    );
  });

  it("keeps Docker absent for the native Podman cloud-onboard test", () => {
    const workflow = readWorkflow();
    const steps = workflow.jobs["cloud-onboard"].steps;
    const hide =
      steps[requireStepIndex(steps, "Hide Docker CLI from native Podman public install")]!;
    const restore =
      steps[requireStepIndex(steps, "Restore Docker CLI after native Podman public install")]!;
    hide.run = hide.run?.replace(
      "if command -v docker >/dev/null 2>&1",
      "if command -v docker-does-not-exist >/dev/null 2>&1",
    );
    hide.run = hide.run?.replace(
      "NEMOCLAW_E2E_DISABLED_DOCKER_CLI=%s",
      "NEMOCLAW_E2E_DISABLED_DOCKER_CLI_MISSING=%s",
    );
    restore.run = restore.run?.replace(
      'sudo mv -- "${disabled_path}" "${restore_path}"',
      'sudo mv -- "${disabled_path}" "${restore_path}.wrong"',
    );

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "step 'Hide Docker CLI from native Podman public install' run script must include if command -v docker >/dev/null 2>&1",
        "step 'Hide Docker CLI from native Podman public install' run script must include NEMOCLAW_E2E_DISABLED_DOCKER_CLI=%s",
        'step \'Restore Docker CLI after native Podman public install\' run script must include sudo mv -- "${disabled_path}" "${restore_path}"',
      ]),
    );
  });

  it("records Docker CLI recovery state before moving the executable", () => {
    const workflow = readWorkflow();
    const steps = workflow.jobs["cloud-onboard"].steps;
    const hide =
      steps[requireStepIndex(steps, "Hide Docker CLI from native Podman public install")]!;
    const moveDockerCli = 'sudo mv -- "${docker_cli}" "${disabled_path}"';
    hide.run = `${moveDockerCli}\n${hide.run ?? ""}`;

    expect(validateE2eWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "step 'Hide Docker CLI from native Podman public install' run script must include NEMOCLAW_E2E_DISABLED_DOCKER_CLI=%s before sudo mv -- \"${docker_cli}\" \"${disabled_path}\"",
        "step 'Hide Docker CLI from native Podman public install' run script must include NEMOCLAW_E2E_DOCKER_CLI_RESTORE_PATH=%s before sudo mv -- \"${docker_cli}\" \"${disabled_path}\"",
      ]),
    );
  });
});
