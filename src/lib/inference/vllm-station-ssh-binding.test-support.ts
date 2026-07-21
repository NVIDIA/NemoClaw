// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type DualStationSshBinding,
  encodeDualStationSshBindingHandoff,
  type QualifiedStationSshIdentity,
  stationKnownHostsDigest,
  writeDualStationSshBinding,
} from "./vllm-station-ssh-binding";

export interface DualStationSshBindingFixture {
  binding: DualStationSshBinding;
  dockerCliFile: string;
  identity: QualifiedStationSshIdentity;
  resumeStatePath: string;
  token: string;
  cleanup(): void;
}

export function createDualStationSshBindingFixture(
  peerTarget = "nvidia@station-b",
): DualStationSshBindingFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-station-ssh-test-"));
  fs.chmodSync(root, 0o700);
  const dockerCliFile = path.join(root, "docker-cli");
  fs.writeFileSync(dockerCliFile, "#!/bin/bash\nexit 0\n", { mode: 0o700 });
  fs.chmodSync(dockerCliFile, 0o700);
  const knownHostsLines = ["192.168.50.20 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGZpeHR1cmU="];
  const hostKeyDigest = stationKnownHostsDigest(`${knownHostsLines.join("\n")}\n`);
  const resumeStatePath = path.join(root, "pair.json");
  const identity: QualifiedStationSshIdentity = {
    requestedTarget: peerTarget,
    sshTarget: peerTarget,
    resolvedHost: "192.168.50.20",
    sshUser: peerTarget.includes("@") ? peerTarget.split("@", 1)[0] : "nvidia",
    port: 22,
    lookupHost: "192.168.50.20",
    hostKeyDigest,
    knownHostsLines,
  };
  const binding = writeDualStationSshBinding(resumeStatePath, identity, { dockerCliFile });
  return {
    binding,
    dockerCliFile,
    identity,
    resumeStatePath,
    token: encodeDualStationSshBindingHandoff(binding),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
