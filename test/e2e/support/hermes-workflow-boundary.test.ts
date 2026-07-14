// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateHermesGpuStartupWorkflowBoundary } from "../../../tools/e2e/hermes-gpu-startup-workflow-boundary.mts";
import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";
import { readRepoText, readWorkflow } from "../../helpers/e2e-workflow-contract";

const WF = ".github/workflows/e2e.yaml";
const FX = "tools/e2e/hermes-gpu-docker-runtime-fixture.sh";
const GPU = "hermes-gpu-startup";
const KEY = "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";
type Doc = ReturnType<typeof YAML.parse>;

function tmp<T>(use: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hermes-"));
  try {
    return use(dir);
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

function tempFile<T>(content: string, use: (file: string) => T): T {
  return tmp((dir) => {
    const file = path.join(dir, "input");
    fs.writeFileSync(file, content);
    return use(file);
  });
}

function wfErrors(
  mutate: (workflow: Doc) => void,
  validate: (file: string) => string[] = validateHermesGpuStartupWorkflowBoundary,
): string[] {
  const workflow = readWorkflow();
  mutate(workflow);
  return tempFile(YAML.stringify(workflow), validate);
}

function step(job: Doc, name: string): Doc {
  return job.steps.find((candidate: { name?: string }) => candidate.name === name);
}

function restoreHarness(tmp: string, content: string, fail: boolean) {
  const state = path.join(tmp, "hermes-gpu-fallback-docker-runtime.123.1.fallback.ABC123");
  const daemon = path.join(tmp, "daemon.json");
  const bin = path.join(tmp, "bin");
  const sudoLog = path.join(tmp, "sudo.log");
  const { uid, gid } = os.userInfo();
  fs.mkdirSync(state, { mode: 0o700 });
  fs.mkdirSync(bin);
  fs.writeFileSync(daemon, '{"default-runtime":"runc"}\n', { mode: 0o600 });
  const files = {
    "capture.complete": "",
    "daemon.json.metadata": `640 ${uid} ${gid}\n`,
    "daemon.json.original": content,
    "default-runtime.modified": "",
    "default-runtime.original": "nvidia\n",
  };
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(state, name), value, { mode: 0o600 });
  }
  const scripts = {
    docker: `#!/bin/sh
if [ "$1" = info ] && [ "\${2:-}" = --format ]; then echo nvidia; fi
exit 0
`,
    stat: `#!/bin/bash
/usr/bin/stat -c "$2" "$3" 2>/dev/null && exit
exec /usr/bin/stat -f "$(printf %s "$2" | sed s/%a/%Lp/g)" "$3"
`,
    sudo: `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_SUDO_LOG"
if [ "\${FAIL_INSTALL:-0}" = 1 ] && [ "\${1:-}" = install ]; then exit 42; fi
exec "$@"
`,
    systemctl: "#!/bin/sh\n:\n",
  };
  for (const [name, script] of Object.entries(scripts)) {
    fs.writeFileSync(path.join(bin, name), script, { mode: 0o700 });
  }
  return { bin, daemon, fail, gid, state, sudoLog, tmp, uid };
}

function restore(harness: ReturnType<typeof restoreHarness>) {
  return spawnSync("bash", [FX, "restore", harness.state, harness.daemon], {
    encoding: "utf8",
    env: {
      ...process.env,
      NEMOCLAW_E2E_FIXTURE_DAEMON_JSON: harness.daemon,
      NEMOCLAW_E2E_FIXTURE_STATE_ROOT: harness.tmp,
      FAIL_INSTALL: harness.fail ? "1" : "0",
      FAKE_SUDO_LOG: harness.sudoLog,
      PATH: `${harness.bin}:${process.env.PATH ?? ""}`,
    },
  });
}

function snapshotFile(file: string) {
  const fd = fs.openSync(file, "r");
  try {
    return { stat: fs.fstatSync(fd), text: fs.readFileSync(fd, "utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

function withRestore(
  fail: boolean,
  check: (result: ReturnType<typeof restore>, harness: ReturnType<typeof restoreHarness>) => void,
): void {
  tmp((tmp) => {
    const harness = restoreHarness(tmp, '{"default-runtime":"nvidia"}\n', fail);
    const result = restore(harness);
    expect(fs.existsSync(harness.state)).toBe(false);
    check(result, harness);
  });
}

describe("Hermes GPU boundary", () => {
  it("accepts baseline", () => {
    expect(validateHermesGpuStartupWorkflowBoundary()).toEqual([]);
  });

  it("rejects broad drift", () => {
    const errors = wfErrors((workflow) => {
      workflow.jobs["hermes-e2e"].env.NEMOCLAW_MODEL = "minimaxai/minimax-m2.7";
      const job = workflow.jobs[GPU];
      job["runs-on"] = "ubuntu-latest";
      job.if = "${{ always() }}";
      job.strategy["max-parallel"] = 2;
      job.strategy.matrix.scenario = ["native"];
      job.env.UNRELATED_SECRET = KEY;
      const run = step(job, "Run Hermes GPU startup live Vitest test");
      run.env = { NVIDIA_INFERENCE_API_KEY: KEY };
      run.run = "npx vitest run --project e2e-live test/e2e/live/hermes-e2e.test.ts";
      step(job, "Upload Hermes GPU startup artifacts").with.path = "wrong";
    }, validateE2eWorkflowBoundary);

    expect(errors.join("\n")).toMatch(
      /GPU runner.*generate-matrix.*serialize.*secrets.*hosted Hermes.*artifact path.*hosted-compatible/s,
    );
  });

  it.each([
    ["hash", (fixture: string) => `${fixture}\n# drift`, "trusted SHA-256"],
    ["mode", (fixture: string) => fixture.replace("install -m 0600", "install -m 0644"), "0644"],
    [
      "path",
      (fixture: string) =>
        fixture.replace(
          "expected_daemon_json=/etc/docker/daemon.json",
          "expected_daemon_json=/tmp/pr.json",
        ),
      "privileged state",
    ],
    [
      "metadata",
      (fixture: string) =>
        fixture.replace('sudo chown "$original_uid:$original_gid"', "true # no chown"),
      "mode, UID, GID",
    ],
    [
      "cleanup",
      (fixture: string) =>
        fixture.replace('rm -rf -- "$state_dir" || restore_failed=1', "true # no cleanup"),
      "before restore failure",
    ],
  ])("rejects fixture %s drift", (_name, mutate, expected) => {
    const errors = tempFile(mutate(readRepoText(FX)), (file) =>
      validateHermesGpuStartupWorkflowBoundary(WF, file),
    );
    expect(errors.join("\n")).toContain(expected);
  });

  it("preserves an invalid restore path", () => {
    tmp((tmp) => {
      const root = path.join(tmp, "root");
      const victim = path.join(tmp, "victim");
      fs.mkdirSync(root);
      fs.mkdirSync(victim);
      const result = spawnSync("bash", [FX, "restore", victim, path.join(tmp, "daemon.json")], {
        encoding: "utf8",
        env: { ...process.env, NEMOCLAW_E2E_FIXTURE_STATE_ROOT: root },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Refusing Docker restore");
      expect(fs.existsSync(victim)).toBe(true);
    });
  });

  it("rejects trusted-boundary drift", () => {
    const errors = wfErrors((workflow) => {
      const job = workflow.jobs[GPU];
      const checkout = step(job, "Checkout trusted Hermes GPU runtime fixture");
      const install = step(job, "Install trusted Hermes GPU runtime fixture");
      checkout.with.ref = "${{ inputs.checkout_sha }}";
      install.env.TRUSTED_FIXTURE_SHA256 = "0".repeat(64);
      step(job, "Run Hermes GPU startup live Vitest test").run = `bash ${FX}`;
      step(job, "Recover Docker daemon after Hermes GPU fallback fixture").run =
        `done < <(bash ${FX})`;
      step(job, "Remove trusted Hermes GPU runtime fixture").if = "${{ success() }}";
      job.steps.reverse();
    });
    expect(errors.join("\n")).toMatch(
      /root-owned.*trusted runtime.*trusted recovery.*always step/s,
    );
  });

  it("restores daemon content, metadata, ownership, and runtime", () => {
    withRestore(false, (result, harness) => {
      const snapshot = snapshotFile(harness.daemon);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("nvidia\n");
      expect(snapshot.text).toBe('{"default-runtime":"nvidia"}\n');
      expect([snapshot.stat.mode & 0o777, snapshot.stat.uid, snapshot.stat.gid]).toEqual([
        0o640,
        harness.uid,
        harness.gid,
      ]);
      expect(fs.readFileSync(harness.sudoLog, "utf8")).toContain(
        `chown ${harness.uid}:${harness.gid} ${harness.daemon}`,
      );
    });
  });

  it("cleans private state after daemon restoration fails", () => {
    withRestore(true, (result, harness) => {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Failed to prove restoration of the Docker daemon");
      expect(fs.readFileSync(harness.sudoLog, "utf8")).toContain("install -m 640");
    });
  });
});
