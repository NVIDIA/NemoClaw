// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildListCommandDeps: vi.fn(),
  buildStatusCommandDeps: vi.fn(),
  getSandboxInventory: vi.fn(),
  getStatusReport: vi.fn(),
  renderSandboxInventoryText: vi.fn(),
  runBackupAllAction: vi.fn(),
  runGarbageCollectImagesAction: vi.fn(),
  runInferenceGet: vi.fn(),
  runInferenceSet: vi.fn(),
  runOnboardAction: vi.fn(),
  runSetupAction: vi.fn(),
  runSetupSparkAction: vi.fn(),
  runUpgradeSandboxesAction: vi.fn(),
  showStatusCommand: vi.fn(),
}));

vi.mock("../lib/inventory", () => ({
  getSandboxInventory: mocks.getSandboxInventory,
  getStatusReport: mocks.getStatusReport,
  renderSandboxInventoryText: mocks.renderSandboxInventoryText,
  showStatusCommand: mocks.showStatusCommand,
}));

vi.mock("../lib/list-command-deps", () => ({
  buildListCommandDeps: mocks.buildListCommandDeps,
}));

vi.mock("../lib/status-command-deps", () => ({
  buildStatusCommandDeps: mocks.buildStatusCommandDeps,
}));

vi.mock("../lib/actions/global", () => ({
  runBackupAllAction: mocks.runBackupAllAction,
  runGarbageCollectImagesAction: mocks.runGarbageCollectImagesAction,
  runOnboardAction: mocks.runOnboardAction,
  runSetupAction: mocks.runSetupAction,
  runSetupSparkAction: mocks.runSetupSparkAction,
  runUpgradeSandboxesAction: mocks.runUpgradeSandboxesAction,
}));

vi.mock("../lib/actions/inference-set", () => ({
  InferenceSetError: class InferenceSetError extends Error {
    exitCode: number;

    constructor(message: string, exitCode = 1) {
      super(message);
      this.exitCode = exitCode;
    }
  },
  runInferenceSet: mocks.runInferenceSet,
}));

vi.mock("../lib/actions/inference-get", () => ({
  InferenceGetError: class InferenceGetError extends Error {
    exitCode: number;

    constructor(message: string, exitCode = 1) {
      super(message);
      this.exitCode = exitCode;
    }
  },
  runInferenceGet: mocks.runInferenceGet,
}));

import { InferenceGetError } from "../lib/actions/inference-get";
import { InferenceSetError } from "../lib/actions/inference-set";
import InferenceGetCommand from "./inference/get";
import InferenceSetCommand from "./inference/set";
import ListCommand from "./list";
import BackupAllCommand from "./backup-all";
import GarbageCollectImagesCommand from "./gc";
import UpgradeSandboxesCommand from "./upgrade-sandboxes";
import OnboardCliCommand from "./onboard";
import SetupCliCommand from "./setup";
import SetupSparkCliCommand from "./setup-spark";
import StatusCommand from "./status";

const rootDir = process.cwd();

describe("global oclif command adapters", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildListCommandDeps.mockReturnValue({ getLiveInference: vi.fn() });
    mocks.buildStatusCommandDeps.mockReturnValue({ statusDeps: true });
    mocks.getSandboxInventory.mockResolvedValue({ sandboxes: [] });
    mocks.getStatusReport.mockReturnValue({ sandboxes: [] });
    mocks.runInferenceSet.mockResolvedValue({
      sandboxName: "alpha",
      provider: "nvidia-prod",
      model: "nvidia/model-a",
      primaryModelRef: "inference/nvidia/model-a",
      providerKey: "inference",
      configChanged: true,
      sessionUpdated: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs list through inventory helpers", async () => {
    await ListCommand.run([], rootDir);

    expect(mocks.buildListCommandDeps).toHaveBeenCalledWith();
    expect(mocks.getSandboxInventory).toHaveBeenCalledWith({
      getLiveInference: expect.any(Function),
    });
    expect(mocks.renderSandboxInventoryText).toHaveBeenCalledWith(
      { sandboxes: [] },
      expect.any(Function),
      null,
    );
  });

  it("keeps list --json stdout clean while inventory recovery prints progress", async () => {
    const report = {
      schemaVersion: 1,
      defaultSandbox: null,
      recovery: { recoveredFromSession: false, recoveredFromGateway: 0 },
      lastOnboardedSandbox: null,
      sandboxes: [],
    };
    mocks.getSandboxInventory.mockImplementationOnce(async () => {
      process.stdout.write("  Starting OpenShell gateway\n");
      return report;
    });

    const out: string[] = [];
    const err: string[] = [];
    const origOut = process.stdout.write;
    const origErr = process.stderr.write;
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      out.push(typeof chunk === "string" ? chunk : String(chunk));
      const cb = rest.find((arg) => typeof arg === "function") as undefined | (() => void);
      if (cb) cb();
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      err.push(typeof chunk === "string" ? chunk : String(chunk));
      const cb = rest.find((arg) => typeof arg === "function") as undefined | (() => void);
      if (cb) cb();
      return true;
    }) as typeof process.stderr.write;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await ListCommand.run(["--json"], rootDir);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }

    const stdout = out.join("");
    expect(stdout).not.toContain("Starting OpenShell gateway");
    expect(stdout).toBe("");
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual(report);
    expect(err.join("")).toContain("Starting OpenShell gateway");
  });

  it("runs status through status helpers", async () => {
    await StatusCommand.run([], rootDir);

    expect(mocks.buildStatusCommandDeps).toHaveBeenCalledWith(rootDir);
    expect(mocks.showStatusCommand).toHaveBeenCalledWith({ statusDeps: true });
  });

  it("maps status JSON output into oclif JSON handling", async () => {
    const report = {
      schemaVersion: 1,
      defaultSandbox: "alpha",
      liveInference: null,
      gatewayHealth: null,
      sandboxes: [],
      services: [],
    };
    mocks.getStatusReport.mockReturnValueOnce(report);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await StatusCommand.run(["--json"], rootDir);
      expect(mocks.buildStatusCommandDeps).toHaveBeenCalledWith(rootDir);
      expect(mocks.getStatusReport).toHaveBeenCalledWith({ statusDeps: true });
      expect(mocks.showStatusCommand).not.toHaveBeenCalled();
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual(report);
    } finally {
      log.mockRestore();
    }
  });

  it("maps maintenance flags to typed action options", async () => {
    await BackupAllCommand.run([], rootDir);
    await UpgradeSandboxesCommand.run(["--check", "--yes"], rootDir);
    await GarbageCollectImagesCommand.run(["--dry-run", "--force"], rootDir);

    expect(mocks.runBackupAllAction).toHaveBeenCalledWith();
    expect(mocks.runUpgradeSandboxesAction).toHaveBeenCalledWith({
      auto: false,
      check: true,
      yes: true,
    });
    expect(mocks.runGarbageCollectImagesAction).toHaveBeenCalledWith({
      dryRun: true,
      force: true,
      yes: false,
    });
  });

  it("maps onboard-family flags into the compatibility action arguments", async () => {
    await OnboardCliCommand.run(["--name", "alpha", "--resume"], rootDir);
    await SetupCliCommand.run(["--fresh"], rootDir);
    await SetupSparkCliCommand.run(["--control-ui-port", "18080"], rootDir);

    expect(mocks.runOnboardAction).toHaveBeenCalledWith(["--resume", "--name", "alpha"]);
    expect(mocks.runSetupAction).toHaveBeenCalledWith(["--fresh"]);
    expect(mocks.runSetupSparkAction).toHaveBeenCalledWith(["--control-ui-port", "18080"]);
  });

  it("maps inference set flags into the inference action", async () => {
    await InferenceSetCommand.run(
      [
        "--provider",
        "nvidia-prod",
        "--model",
        "nvidia/nemotron-3-super-120b-a12b",
        "--sandbox",
        "alpha",
        "--no-verify",
      ],
      rootDir,
    );

    expect(mocks.runInferenceSet).toHaveBeenCalledWith({
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      sandboxName: "alpha",
      noVerify: true,
    });
  });

  it("maps inference get JSON output into oclif JSON handling", async () => {
    mocks.runInferenceGet.mockResolvedValueOnce({
      provider: "nvidia-prod",
      model: "nvidia/model-a",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await InferenceGetCommand.run(["--json"], rootDir);
      expect(mocks.runInferenceGet).toHaveBeenCalledWith({ quiet: true });
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      });
    } finally {
      log.mockRestore();
    }
  });

  it("records inference action failures without throwing oclif ExitError", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      mocks.runInferenceGet.mockRejectedValueOnce(new InferenceGetError("route missing", 3));
      mocks.runInferenceSet.mockRejectedValueOnce(new InferenceSetError("route rejected", 4));

      await expect(InferenceGetCommand.run([], rootDir)).resolves.toBeUndefined();
      expect(process.exitCode).toBe(3);
      expect(error).toHaveBeenCalledWith("route missing");

      await expect(
        InferenceSetCommand.run(
          ["--provider", "nvidia-prod", "--model", "nvidia/model-a"],
          rootDir,
        ),
      ).resolves.toBeUndefined();
      expect(process.exitCode).toBe(4);
      expect(error).toHaveBeenCalledWith("route rejected");
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
