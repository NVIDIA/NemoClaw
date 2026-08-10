// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadSshJetsonWorkerConfig } from "../../../tools/e2e/jetson-dispatch-worker.mts";

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
  it("loads fixed SSH, host-key, timeout, and reset configuration (#8142)", () => {
    expect(loadSshJetsonWorkerConfig(environment())).toMatchObject({
      destination: "nvidia@192.168.55.1",
      testTimeoutSeconds: 2700,
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
