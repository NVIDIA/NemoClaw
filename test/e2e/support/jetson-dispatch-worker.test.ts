// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadSshJetsonWorkerConfig,
  ProcessFailure,
  SshJetsonDispatchWorker,
} from "../../../tools/e2e/jetson-dispatch-worker.mts";

const dispatcherRunbook = fs.readFileSync(
  path.join(process.cwd(), "test/e2e/docs/jetson-colossus-dispatch.md"),
  "utf8",
);
const cleanupProgram = fs.readFileSync(
  path.join(process.cwd(), "tools/e2e/jetson-dispatch-cleanup.sh"),
  "utf8",
);
const temporaryDirectories: string[] = [];
const BASELINE = {
  nodePath: "/usr/bin/node",
  nodeVersion: "v22.19.0",
  npmPath: "/usr/bin/npm",
  npmVersion: "10.9.3",
  ollamaPath: "/usr/local/bin/ollama",
  ollamaModelsSha256: "a".repeat(64),
  openshellPath: "/usr/local/bin/openshell",
};

function baselineOutput(overrides: Partial<typeof BASELINE> = {}): string {
  const baseline = { ...BASELINE, ...overrides };
  return `${Object.entries(baseline)
    .map(([key, value]) => `${key}\t${value}`)
    .join("\n")}\n`;
}

const BASELINE_OUTPUT = baselineOutput();

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function deploymentFiles() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-jetson-worker-"));
  temporaryDirectories.push(directory);
  const identityFile = path.join(directory, "id_ed25519");
  const knownHostsFile = path.join(directory, "known_hosts");
  const cleanupExecutable = path.join(directory, "cleanup-jetson");
  fs.writeFileSync(identityFile, "test-key", { mode: 0o600 });
  fs.writeFileSync(knownHostsFile, "test-host-key", { mode: 0o600 });
  fs.writeFileSync(cleanupExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { cleanupExecutable, identityFile, knownHostsFile, stateDirectory: directory };
}

function environment(files = deploymentFiles()): NodeJS.ProcessEnv {
  return {
    JETSON_DISPATCH_SSH_DESTINATION: "nvidia@192.168.55.1",
    JETSON_DISPATCH_SSH_IDENTITY_FILE: files.identityFile,
    JETSON_DISPATCH_SSH_KNOWN_HOSTS_FILE: files.knownHostsFile,
    JETSON_DISPATCH_CLEANUP_EXECUTABLE: files.cleanupExecutable,
    JETSON_DISPATCH_TEST_TIMEOUT_SECONDS: "2700",
  };
}

function loadConfig(files = deploymentFiles()) {
  return loadSshJetsonWorkerConfig({ stateDirectory: files.stateDirectory }, environment(files));
}

describe("Colossus SSH worker deployment boundary", () => {
  it("pins dispatcher deployment to one reviewed commit before service startup (#8142)", () => {
    const verification = 'test "$(sudo git -C /opt/nemoclaw-jetson-dispatch rev-parse HEAD)" =';
    expect(dispatcherRunbook).toContain(
      'fetch --depth=1 --no-tags origin \\\n  "$REVIEWED_COMMIT_SHA"',
    );
    expect(dispatcherRunbook).toContain("checkout --detach FETCH_HEAD");
    expect(dispatcherRunbook).toContain(verification);
    expect(dispatcherRunbook.indexOf(verification)).toBeLessThan(
      dispatcherRunbook.indexOf("## Configure the Dispatcher Service"),
    );
    expect(dispatcherRunbook).not.toContain("git clone --branch main");
  });

  it("loads fixed SSH, host-key, timeout, and cleanup configuration (#8142)", () => {
    const files = deploymentFiles();
    expect(loadConfig(files)).toEqual({
      cleanupExecutable: files.cleanupExecutable,
      destination: "nvidia@192.168.55.1",
      identityFile: files.identityFile,
      knownHostsFile: files.knownHostsFile,
      stateDirectory: files.stateDirectory,
      testTimeoutSeconds: 2700,
    });
  });

  it("collects a bounded artifact archive before the remote workspace is removed (#8142)", async () => {
    const files = deploymentFiles();
    const jobId = "b".repeat(64);
    const baselinePath = path.join(files.stateDirectory, `${jobId}.baseline.json`);
    fs.writeFileSync(baselinePath, `${JSON.stringify({ ...BASELINE, nodeVersion: "v22.0.0" })}\n`, {
      mode: 0o600,
    });
    const artifactArchiveBase64 = Buffer.from("remote archive").toString("base64");
    const processRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: BASELINE_OUTPUT, stderr: "" })
      .mockResolvedValueOnce({
        stdout:
          "model\tNVIDIA Jetson AGX Thor Developer Kit\njetpackVersion\t7.2.2\njetsonLinuxRelease\tR38\nkernel\t6.8.12-tegra\n",
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "test passed\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: artifactArchiveBase64, stderr: "" });
    const worker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);

    await expect(
      worker.run(
        {
          schemaVersion: 1,
          target: "jetson-nvmap-gpu",
          candidateSha: "a".repeat(40),
          workflowRunId: "123",
          workflowRunAttempt: 1,
        },
        { jobId, signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      artifactArchiveBase64,
      log: expect.stringContaining("test passed"),
    });
    expect(processRunner.mock.calls[0]![0].input).toContain(
      "major < 22 || (major === 22 && minor < 19)",
    );
    expect(processRunner.mock.calls[0]![0].input).toContain("npm_major >= 10");
    expect(processRunner.mock.calls[2]![0].input).toContain(
      "major < 22 || (major === 22 && minor < 19)",
    );
    expect(processRunner.mock.calls[2]![0].input).toContain("npm_major >= 10");
    expect(JSON.parse(fs.readFileSync(baselinePath, "utf8"))).toEqual(BASELINE);
    expect(processRunner.mock.calls[2]![0].input).not.toContain("trap cleanup EXIT");
    expect(processRunner.mock.calls[3]![0].input).not.toContain("trap cleanup EXIT");
    expect(processRunner.mock.calls[3]![0].input).toContain("base64 --wrap=0");
  });

  it("preserves test-failure logs when artifact collection fails (#8142)", async () => {
    const files = deploymentFiles();
    const processRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: BASELINE_OUTPUT, stderr: "" })
      .mockResolvedValueOnce({
        stdout:
          "model\tNVIDIA Jetson AGX Thor Developer Kit\njetpackVersion\t7.2.2\njetsonLinuxRelease\tR38\nkernel\t6.8.12-tegra\n",
        stderr: "",
      })
      .mockRejectedValueOnce(
        new ProcessFailure("Jetson test failed", {
          stdout: "failed test output\n",
          stderr: "failed test error\n",
        }),
      )
      .mockRejectedValueOnce(new Error("artifact collection unavailable"));
    const worker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);

    await expect(
      worker.run(
        {
          schemaVersion: 1,
          target: "jetson-nvmap-gpu",
          candidateSha: "a".repeat(40),
          workflowRunId: "123",
          workflowRunAttempt: 1,
        },
        { jobId: "b".repeat(64), signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      message: "Jetson test failed; artifact collection failed: artifact collection unavailable",
      log: expect.stringContaining("failed test output"),
    });
  });

  it("preserves successful test logs when artifact collection fails (#8142)", async () => {
    const files = deploymentFiles();
    const processRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: BASELINE_OUTPUT, stderr: "" })
      .mockResolvedValueOnce({
        stdout:
          "model\tNVIDIA Jetson AGX Thor Developer Kit\njetpackVersion\t7.2.2\njetsonLinuxRelease\tR38\nkernel\t6.8.12-tegra\n",
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "successful test output\n", stderr: "" })
      .mockRejectedValueOnce(new Error("artifact collection unavailable"));
    const worker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);

    await expect(
      worker.run(
        {
          schemaVersion: 1,
          target: "jetson-nvmap-gpu",
          candidateSha: "a".repeat(40),
          workflowRunId: "123",
          workflowRunAttempt: 1,
        },
        { jobId: "b".repeat(64), signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      message: "artifact collection unavailable",
      log: expect.stringContaining("successful test output"),
    });
  });

  it.each([
    "nvidia@192.168.55.2",
    "nvidia@192.168.55.1 -o StrictHostKeyChecking=no",
    "nvidia@host;uname",
    "root@",
    "-oProxyCommand=unsafe",
  ])("rejects an SSH destination that is not the fixed Jetson user and host: %s (#8142)", (destination) => {
    const files = deploymentFiles();
    expect(() =>
      loadSshJetsonWorkerConfig(
        { stateDirectory: files.stateDirectory },
        {
          ...environment(files),
          JETSON_DISPATCH_SSH_DESTINATION: destination,
        },
      ),
    ).toThrow("JETSON_DISPATCH_SSH_DESTINATION must be nvidia@192.168.55.1");
  });

  it("rejects a writable SSH identity file (#8142)", () => {
    const files = deploymentFiles();
    fs.chmodSync(files.identityFile, 0o666);
    expect(() => loadConfig(files)).toThrow("must not be group- or world-writable");
  });

  it("rejects a group-readable SSH identity file (#8142)", () => {
    const files = deploymentFiles();
    fs.chmodSync(files.identityFile, 0o640);
    expect(() => loadConfig(files)).toThrow("must be readable only by its owner");
  });

  it("rejects a symbolic-link cleanup executable (#8142)", () => {
    const files = deploymentFiles();
    const link = path.join(path.dirname(files.cleanupExecutable), "cleanup-link");
    fs.symlinkSync(files.cleanupExecutable, link);
    expect(() =>
      loadSshJetsonWorkerConfig(
        { stateDirectory: files.stateDirectory },
        {
          ...environment(files),
          JETSON_DISPATCH_CLEANUP_EXECUTABLE: link,
        },
      ),
    ).toThrow("must be a regular file");
  });

  it("invokes the fixed cleanup executable without request-controlled arguments (#8142)", async () => {
    const files = deploymentFiles();
    const jobId = "b".repeat(64);
    const baselinePath = path.join(files.stateDirectory, `${jobId}.baseline.json`);
    fs.writeFileSync(baselinePath, `${JSON.stringify(BASELINE)}\n`, { mode: 0o600 });
    const processRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: BASELINE_OUTPUT, stderr: "" });
    const worker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);

    await expect(
      worker.cleanup({ jobId, signal: new AbortController().signal }),
    ).resolves.toBeUndefined();

    expect(processRunner.mock.calls[0]![0]).toMatchObject({
      args: [],
      executable: files.cleanupExecutable,
    });
    expect(processRunner.mock.calls[0]![0].input).toBeUndefined();
    expect(processRunner.mock.calls[1]![0]).toMatchObject({
      executable: "ssh",
      input: expect.stringContaining('workspace="/var/tmp/nemoclaw-jetson-e2e/$job_id"'),
    });
    expect(processRunner.mock.calls[1]![0].input).toContain("docker info --format");
    expect(processRunner.mock.calls[1]![0].input).toContain("test -c /dev/nvmap");
    expect(processRunner.mock.calls[1]![0].input).toContain("ollama list");
    expect(processRunner.mock.calls[1]![0].args).toEqual(
      expect.arrayContaining(["nvidia@192.168.55.1", "--", jobId]),
    );
    expect(fs.existsSync(baselinePath)).toBe(true);
  });

  it("verifies cleanup after a pre-candidate failure without a baseline record (#8142)", async () => {
    const files = deploymentFiles();
    const jobId = "b".repeat(64);
    const processRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: BASELINE_OUTPUT, stderr: "" });
    const worker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);

    await expect(
      worker.cleanup({ jobId, signal: new AbortController().signal }),
    ).resolves.toBeUndefined();

    expect(processRunner).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(files.stateDirectory, `${jobId}.baseline.json`))).toBe(false);
  });

  it.each([
    ["Node.js", { nodeVersion: "v22.20.0" }],
    ["npm", { npmVersion: "11.0.0" }],
    ["Ollama executable", { ollamaPath: "/tmp/ollama" }],
    ["Ollama models", { ollamaModelsSha256: "c".repeat(64) }],
    ["OpenShell executable", { openshellPath: "/tmp/openshell" }],
  ])("rejects cleanup when the protected %s baseline changes (#8142)", async (_name, change) => {
    const files = deploymentFiles();
    const jobId = "b".repeat(64);
    const baselinePath = path.join(files.stateDirectory, `${jobId}.baseline.json`);
    fs.writeFileSync(baselinePath, `${JSON.stringify(BASELINE)}\n`, { mode: 0o600 });
    const processRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: baselineOutput(change), stderr: "" });
    const worker = new SshJetsonDispatchWorker(loadConfig(files), processRunner);

    await expect(worker.cleanup({ jobId, signal: new AbortController().signal })).rejects.toThrow(
      "Jetson protected tool or Ollama model baseline differs after cleanup",
    );
    expect(fs.existsSync(baselinePath)).toBe(true);
  });

  it("keeps cleanup targets fixed and preserves the Jetson baseline (#8142)", () => {
    expect(cleanupProgram).toContain("sandbox_name=e2e-jetson-nvmap");
    expect(cleanupProgram).toContain("gateway_name=nemoclaw");
    expect(cleanupProgram).toContain("destination=nvidia@192.168.55.1");
    expect(cleanupProgram).toContain('if [ "$#" -ne 0 ]');
    expect(cleanupProgram).toContain('IFS= read -r job_id <"$lock_file"');
    expect(cleanupProgram).toContain('require_plain_directory_if_present "$service_directory"');
    expect(cleanupProgram).toContain('rm -rf -- "$workspace"');
    expect(cleanupProgram).toContain("ollama-auth-proxy.pid");
    expect(cleanupProgram).toContain('process_uid="$(awk');
    expect(cleanupProgram).toContain('grep -Fqx "HOME=$job_home"');
    expect(cleanupProgram).toContain('kill "$pid"');
    expect(cleanupProgram).toContain("label=openshell.ai/sandbox-name=$sandbox_name");
    expect(cleanupProgram).not.toMatch(/pkill|pgrep|docker (?:system|container|volume) prune/u);
    expect(cleanupProgram).not.toContain('rm -rf -- "$workspace_root"');
    expect(cleanupProgram).not.toContain("ollama serve");
    expect(cleanupProgram).not.toMatch(/apt(?:-get)?|boardctl|reboot|shutdown|nvidia-l4t/u);
    expect(cleanupProgram).not.toMatch(/npm uninstall|uninstall\.sh|rm .*openshell|rm .*ollama/u);
  });

  it("requires every protected Jetson prerequisite before dispatch (#8142)", () => {
    expect(dispatcherRunbook).toContain(
      "command -v bash curl docker git node npm ollama openshell timeout",
    );
    expect(dispatcherRunbook).toContain(
      "if (major < 22 || (major === 22 && minor < 19)) process.exit(1)",
    );
    expect(dispatcherRunbook).toContain('test "${npm_version%%.*}" -ge 10');
    expect(dispatcherRunbook).toContain("ollama list");
  });

  it("keeps recovery credentials until idle teardown verification succeeds (#8142)", () => {
    const stopTunnel = dispatcherRunbook.indexOf(
      "sudo systemctl disable --now nemoclaw-jetson-tunnel.service",
    );
    const waitForLock = dispatcherRunbook.indexOf(
      "timeout 3600 bash -c 'while [ -e \"$1\" ]; do sleep 5; done'",
    );
    const verifyCleanup = dispatcherRunbook.indexOf(
      'if (status.state !== "completed" || status.cleanup !== "succeeded") process.exit(1)',
    );
    const stopDispatcher = dispatcherRunbook.indexOf(
      "sudo systemctl disable --now nemoclaw-jetson-dispatch.service",
    );
    const removeSshKey = dispatcherRunbook.indexOf(
      "Remove the dedicated Jetson public key and the Colossus SSH private key.",
    );

    expect(dispatcherRunbook).toContain("TimeoutStopSec=360");
    expect(stopTunnel).toBeGreaterThan(-1);
    expect(waitForLock).toBeGreaterThan(stopTunnel);
    expect(verifyCleanup).toBeGreaterThan(waitForLock);
    expect(stopDispatcher).toBeGreaterThan(verifyCleanup);
    expect(removeSshKey).toBeGreaterThan(stopDispatcher);
  });
});
