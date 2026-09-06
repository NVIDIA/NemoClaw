// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { sshExec } from "./skill-remote";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const spawn = vi.mocked(spawnSync);

describe("skill SSH transport", () => {
  beforeEach(() => {
    spawn.mockReset();
    spawn.mockReturnValue({ status: 0, stderr: "", stdout: "" } as never);
  });

  it("pins a new OpenShell host key only into the operation-scoped file", () => {
    sshExec(
      {
        configFile: "/tmp/ssh-config",
        knownHostsFile: "/tmp/skill-known-hosts",
        sandboxName: "alpha",
      },
      ":",
      { acceptNewHostKey: true },
    );

    expect(spawn.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        "StrictHostKeyChecking=accept-new",
        "UserKnownHostsFile=/tmp/skill-known-hosts",
      ]),
    );
  });

  it("requires the pinned host key for the native lifecycle command", () => {
    sshExec(
      {
        configFile: "/tmp/ssh-config",
        knownHostsFile: "/tmp/skill-known-hosts",
        sandboxName: "alpha",
      },
      "native-command",
    );

    expect(spawn.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        "StrictHostKeyChecking=yes",
        "UserKnownHostsFile=/tmp/skill-known-hosts",
      ]),
    );
  });
});
