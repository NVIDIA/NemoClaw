// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configGet: vi.fn(),
  connectSandbox: vi.fn().mockResolvedValue(undefined),
  destroySandbox: vi.fn().mockResolvedValue(undefined),
  listSandboxChannels: vi.fn(),
  listSandboxPolicies: vi.fn(),
  rebuildSandbox: vi.fn().mockResolvedValue(undefined),
  runSandboxDoctor: vi.fn().mockResolvedValue(undefined),
  shieldsDown: vi.fn(),
  shieldsStatus: vi.fn(),
  shieldsUp: vi.fn(),
  showSandboxStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./sandbox-runtime-actions", () => ({
  connectSandbox: mocks.connectSandbox,
  destroySandbox: mocks.destroySandbox,
  rebuildSandbox: mocks.rebuildSandbox,
  showSandboxStatus: mocks.showSandboxStatus,
}));

vi.mock("./policy-channel-actions", () => ({
  listSandboxChannels: mocks.listSandboxChannels,
  listSandboxPolicies: mocks.listSandboxPolicies,
}));

vi.mock("./sandbox-config", () => ({
  configGet: mocks.configGet,
}));

vi.mock("./sandbox-doctor-action", () => ({
  runSandboxDoctor: mocks.runSandboxDoctor,
}));

vi.mock("./shields", () => ({
  shieldsDown: mocks.shieldsDown,
  shieldsStatus: mocks.shieldsStatus,
  shieldsUp: mocks.shieldsUp,
}));

import ConnectCliCommand from "./connect-cli-command";
import DestroyCliCommand from "./destroy-cli-command";
import RebuildCliCommand from "./rebuild-cli-command";
import SandboxDoctorCliCommand from "./sandbox-doctor-cli-command";
import {
  SandboxChannelsListCommand,
  SandboxConfigGetCommand,
  SandboxPolicyListCommand,
  SandboxStatusCommand,
} from "./sandbox-inspection-cli-command";
import { ShieldsDownCommand, ShieldsStatusCommand, ShieldsUpCommand } from "./shields-cli-commands";

const rootDir = process.cwd();

describe("sandbox oclif command adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps connect and lifecycle flags to typed action options", async () => {
    await ConnectCliCommand.run(["alpha", "--probe-only"], rootDir);
    await DestroyCliCommand.run(["alpha", "--yes"], rootDir);
    await RebuildCliCommand.run(["alpha", "--force", "--verbose"], rootDir);

    expect(mocks.connectSandbox).toHaveBeenCalledWith("alpha", { probeOnly: true });
    expect(mocks.destroySandbox).toHaveBeenCalledWith("alpha", { force: false, yes: true });
    expect(mocks.rebuildSandbox).toHaveBeenCalledWith("alpha", {
      force: true,
      verbose: true,
      yes: false,
    });
  });

  it("maps inspection commands to their action helpers", async () => {
    await SandboxStatusCommand.run(["alpha"], rootDir);
    await SandboxPolicyListCommand.run(["alpha"], rootDir);
    await SandboxChannelsListCommand.run(["alpha"], rootDir);
    await SandboxConfigGetCommand.run(["alpha", "--key", "model", "--format", "yaml"], rootDir);

    expect(mocks.showSandboxStatus).toHaveBeenCalledWith("alpha");
    expect(mocks.listSandboxPolicies).toHaveBeenCalledWith("alpha");
    expect(mocks.listSandboxChannels).toHaveBeenCalledWith("alpha");
    expect(mocks.configGet).toHaveBeenCalledWith("alpha", { key: "model", format: "yaml" });
  });

  it("maps doctor and shields commands to action helpers", async () => {
    await SandboxDoctorCliCommand.run(["alpha", "--json"], rootDir);
    await ShieldsDownCommand.run(
      ["alpha", "--timeout", "5m", "--reason", "debugging", "--policy", "permissive"],
      rootDir,
    );
    await ShieldsUpCommand.run(["alpha"], rootDir);
    await ShieldsStatusCommand.run(["alpha"], rootDir);

    expect(mocks.runSandboxDoctor).toHaveBeenCalledWith("alpha", ["--json"]);
    expect(mocks.shieldsDown).toHaveBeenCalledWith("alpha", {
      timeout: "5m",
      reason: "debugging",
      policy: "permissive",
    });
    expect(mocks.shieldsUp).toHaveBeenCalledWith("alpha");
    expect(mocks.shieldsStatus).toHaveBeenCalledWith("alpha");
  });
});
