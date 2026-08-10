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
const temporaryDirectories: string[] = [];

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
  const resetExecutable = path.join(directory, "reset-jetson");
  fs.writeFileSync(identityFile, "test-key", { mode: 0o600 });
  fs.writeFileSync(knownHostsFile, "test-host-key", { mode: 0o600 });
  fs.writeFileSync(resetExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { identityFile, knownHostsFile, resetExecutable };
}

function environment(files = deploymentFiles()): NodeJS.ProcessEnv {
  return {
    JETSON_DISPATCH_SSH_DESTINATION: "nvidia@192.168.55.1",
    JETSON_DISPATCH_SSH_IDENTITY_FILE: files.identityFile,
    JETSON_DISPATCH_SSH_KNOWN_HOSTS_FILE: files.knownHostsFile,
    JETSON_DISPATCH_RESET_EXECUTABLE: files.resetExecutable,
    JETSON_DISPATCH_TEST_TIMEOUT_SECONDS: "2700",
  };
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

  it("loads fixed SSH, host-key, timeout, and reset configuration (#8142)", () => {
    const files = deploymentFiles();
    expect(loadSshJetsonWorkerConfig(environment(files))).toEqual({
      destination: "nvidia@192.168.55.1",
      identityFile: files.identityFile,
      knownHostsFile: files.knownHostsFile,
      resetExecutable: files.resetExecutable,
      testTimeoutSeconds: 2700,
    });
  });

  it("collects a bounded artifact archive before the remote workspace is removed (#8142)", async () => {
    const files = deploymentFiles();
    const artifactArchiveBase64 = Buffer.from("remote archive").toString("base64");
    const processRunner = vi
      .fn()
      .mockResolvedValueOnce({
        stdout:
          "model\tNVIDIA Jetson AGX Thor Developer Kit\njetpackVersion\t7.2.2\njetsonLinuxRelease\tR38\nkernel\t6.8.12-tegra\n",
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "test passed\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: artifactArchiveBase64, stderr: "" });
    const worker = new SshJetsonDispatchWorker(
      loadSshJetsonWorkerConfig(environment(files)),
      processRunner,
    );

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
    ).resolves.toMatchObject({
      artifactArchiveBase64,
      log: expect.stringContaining("test passed"),
    });
    expect(processRunner.mock.calls[1]![0].input).not.toContain("trap cleanup EXIT");
    expect(processRunner.mock.calls[2]![0].input).toContain("trap cleanup EXIT");
    expect(processRunner.mock.calls[2]![0].input).toContain("base64 --wrap=0");
  });

  it("preserves test-failure logs when artifact collection fails (#8142)", async () => {
    const files = deploymentFiles();
    const processRunner = vi
      .fn()
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
    const worker = new SshJetsonDispatchWorker(
      loadSshJetsonWorkerConfig(environment(files)),
      processRunner,
    );

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

  it.each([
    "nvidia@192.168.55.1 -o StrictHostKeyChecking=no",
    "nvidia@host;uname",
    "root@",
    "-oProxyCommand=unsafe",
  ])("rejects an SSH destination that is not one fixed user and host: %s (#8142)", (destination) => {
    expect(() =>
      loadSshJetsonWorkerConfig({
        ...environment(),
        JETSON_DISPATCH_SSH_DESTINATION: destination,
      }),
    ).toThrow("JETSON_DISPATCH_SSH_DESTINATION must be a fixed user and host");
  });

  it("rejects a writable SSH identity file (#8142)", () => {
    const files = deploymentFiles();
    fs.chmodSync(files.identityFile, 0o666);
    expect(() => loadSshJetsonWorkerConfig(environment(files))).toThrow(
      "must not be group- or world-writable",
    );
  });

  it("rejects a group-readable SSH identity file (#8142)", () => {
    const files = deploymentFiles();
    fs.chmodSync(files.identityFile, 0o640);
    expect(() => loadSshJetsonWorkerConfig(environment(files))).toThrow(
      "must be readable only by its owner",
    );
  });

  it("rejects a symbolic-link reset executable (#8142)", () => {
    const files = deploymentFiles();
    const link = path.join(path.dirname(files.resetExecutable), "reset-link");
    fs.symlinkSync(files.resetExecutable, link);
    expect(() =>
      loadSshJetsonWorkerConfig({
        ...environment(files),
        JETSON_DISPATCH_RESET_EXECUTABLE: link,
      }),
    ).toThrow("must be a regular file");
  });
});
