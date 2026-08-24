// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { strictVllmSshTransportArgs } from "./vllm-ssh-transport-policy";

describe("strict vLLM SSH transport policy", () => {
  it("returns the exact noninteractive transport boundary (#9519)", () => {
    expect(strictVllmSshTransportArgs()).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "VerifyHostKeyDNS=no",
      "-o",
      "NoHostAuthenticationForLocalhost=no",
      "-o",
      "NumberOfPasswordPrompts=0",
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "KbdInteractiveAuthentication=no",
      "-o",
      "PreferredAuthentications=publickey",
      "-o",
      "ConnectTimeout=5",
      "-o",
      "ConnectionAttempts=1",
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=1",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ForwardX11=no",
      "-o",
      "ForwardX11Trusted=no",
      "-o",
      "Tunnel=no",
      "-o",
      "UpdateHostKeys=no",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-o",
      "PermitLocalCommand=no",
      "-o",
      "RemoteCommand=none",
      "-o",
      "ProxyCommand=none",
      "-o",
      "ProxyJump=none",
      "-o",
      "KnownHostsCommand=none",
      "-o",
      "LogLevel=ERROR",
    ]);
  });
});
