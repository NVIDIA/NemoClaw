// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Args, Flags } from "@oclif/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as portableAgentLifecycle from "../onboard/experimental/portable-agent-lifecycle";
import * as receiptAuthority from "../onboard/experimental/hermes-portable-receipt";
import * as portableHostAuthority from "../state/portable-uninstall-retirement";
import {
  isMcpLifecycleLockHeld,
  withMcpLifecycleLock,
} from "../state/mcp-lifecycle-lock-acquisition";
import * as mcpLifecycleLock from "../state/mcp-lifecycle-lock-acquisition";
import { getMcpLifecycleLockPath } from "../state/mcp-lifecycle-lock-storage";
import { log } from "./logger";
import { type CommandExitResult, NemoClawCommand } from "./nemoclaw-oclif-command";

class TestCommand extends NemoClawCommand {
  static id = "test";

  public async run(): Promise<void> {
    // Test-only command wrapper.
  }

  public apply(result: CommandExitResult): void {
    this.applyExitResult(result);
  }

  public fail(lines: readonly string[], code?: number): void {
    this.failWithLines(lines, code);
  }

  public json(value: unknown): void {
    this.logJson(value);
  }
}

class ParsingTestCommand extends NemoClawCommand {
  static id = "parsing-test";
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(ParsingTestCommand);
  }
}

class ShieldsSentinelCommand extends NemoClawCommand {
  static id = "shields-sentinel-test";
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(ShieldsSentinelCommand);
    throw Object.assign(new Error("Config remains unlocked — already printed"), {
      name: "DeferredShieldsExit",
      exitCode: 1,
    });
  }
}

class DriftSentinelCommand extends NemoClawCommand {
  static id = "drift-sentinel-test";
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(DriftSentinelCommand);
    throw Object.assign(new Error("Locked shields state has filesystem drift"), {
      name: "DeferredShieldsExit",
      exitCode: 2,
    });
  }
}

class PlainFailureCommand extends NemoClawCommand {
  static id = "plain-failure-test";
  static flags = {};

  public async run(): Promise<void> {
    await this.parse(PlainFailureCommand);
    throw Object.assign(new Error("real failure"), { exitCode: 7 });
  }
}

class RawUnsupportedSandboxCommand extends NemoClawCommand {
  static id = "sandbox:agent";
  static ran = false;

  public async run(): Promise<void> {
    RawUnsupportedSandboxCommand.ran = true;
  }
}

class RawSandboxDoctorCommand extends NemoClawCommand {
  static id = "sandbox:doctor";
  static ran = false;

  public async run(): Promise<void> {
    RawSandboxDoctorCommand.ran = true;
  }
}

class ParsedUnsupportedSandboxCommand extends NemoClawCommand {
  static id = "sandbox:destroy";
  static args = { sandboxName: Args.string({ required: true }) };
  static flags = {};
  static ran = false;

  public async run(): Promise<void> {
    await this.parse(ParsedUnsupportedSandboxCommand);
    ParsedUnsupportedSandboxCommand.ran = true;
  }
}

class ParsedSupportedSandboxCommand extends NemoClawCommand {
  static id = "sandbox:status";
  static args = { sandboxName: Args.string({ required: true }) };
  static flags = {};
  static operation: () => Promise<void> = async () => undefined;

  public async run(): Promise<void> {
    await this.parse(ParsedSupportedSandboxCommand);
    await ParsedSupportedSandboxCommand.operation();
  }
}

class GlobalUnsupportedMutationCommand extends NemoClawCommand {
  static id = "tunnel:start";
  static flags = { ...NemoClawCommand.baseFlags };
  static ran = false;

  public async run(): Promise<void> {
    await this.parse(GlobalUnsupportedMutationCommand);
    GlobalUnsupportedMutationCommand.ran = true;
  }
}

class GlobalUseMutationCommand extends NemoClawCommand {
  static id = "use";
  static args = { sandboxName: Args.string({ required: true }) };
  static flags = {};
  static ran = false;

  public async run(): Promise<void> {
    await this.parse(GlobalUseMutationCommand);
    GlobalUseMutationCommand.ran = true;
  }
}

class ProbeOnlyConnectCommand extends NemoClawCommand {
  static id = "sandbox:connect";
  static args = { sandboxName: Args.string({ required: true }) };
  static flags = { "probe-only": Flags.boolean() };
  static observed = { host: false, lifecycle: false };
  static operation: (sandboxName: string) => void = () => undefined;

  public async run(): Promise<void> {
    const { args } = await this.parse(ProbeOnlyConnectCommand);
    const sandboxName = args.sandboxName!;
    ProbeOnlyConnectCommand.observed = {
      host: fs.existsSync(
        portableHostAuthority.portableHostFencePath(process.env.HOME || os.homedir()),
      ),
      lifecycle: isMcpLifecycleLockHeld(sandboxName),
    };
    ProbeOnlyConnectCommand.operation(sandboxName);
  }
}

function useHermesPortableAuthority(): void {
  vi.spyOn(receiptAuthority, "hasHermesPortableReceiptCandidate").mockReturnValue(true);
  vi.spyOn(
    receiptAuthority,
    "inspectPortableAgentReceiptAuthorityForClassification",
  ).mockReturnValue({
    kind: "hermes",
    snapshot: {
      receipt: {
        phase: "active",
        gatewayName: "nemoclaw",
        lifecycleGeneration: "generation-1",
        container: { sandboxId: "sandbox-id" },
      },
    } as never,
  });
}

function makeCommand(): TestCommand {
  return Object.create(TestCommand.prototype) as TestCommand;
}

describe("NemoClawCommand", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-oclif-command-"));
    vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", stateDir);
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    log.configure();
    process.exitCode = undefined;
    RawUnsupportedSandboxCommand.ran = false;
    RawSandboxDoctorCommand.ran = false;
    ParsedUnsupportedSandboxCommand.ran = false;
    ParsedSupportedSandboxCommand.operation = async () => undefined;
    GlobalUnsupportedMutationCommand.ran = false;
    GlobalUseMutationCommand.ran = false;
    ProbeOnlyConnectCommand.operation = () => undefined;
  });

  it("records status-like command results without throwing", () => {
    makeCommand().apply({ status: 7 });

    expect(process.exitCode).toBe(7);
  });

  it("prefers exitCode and prints failure messages", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    makeCommand().apply({ exitCode: 3, message: "boom", status: 7 });

    expect(process.exitCode).toBe(3);
    expect(error).toHaveBeenCalledWith("boom");
  });

  it("prints multi-line failures and records the requested code", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    makeCommand().fail(["line 1", "line 2"], 9);

    expect(process.exitCode).toBe(9);
    expect(error.mock.calls).toEqual([["line 1"], ["line 2"]]);
  });

  it("redacts sensitive JSON output before logging", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    makeCommand().json({ provider: "build", apiKey: "nvapi-" + "a".repeat(24) });

    expect(log).toHaveBeenCalledWith(
      JSON.stringify({ provider: "build", apiKey: "<REDACTED>" }, null, 2),
    );
  });

  it("applies host logging flags from oclif parser output", async () => {
    const configure = vi.spyOn(log, "configure").mockImplementation(() => undefined);

    await ParsingTestCommand.run(["--quiet"], process.cwd());
    await ParsingTestCommand.run(["--debug"], process.cwd());

    expect(configure).toHaveBeenCalledWith({ debug: false, quiet: true });
    expect(configure).toHaveBeenCalledWith({ debug: true, quiet: false });
  });

  it("keeps NEMOCLAW_LOG_LEVEL precedence unless a CLI flag overrides it", async () => {
    vi.stubEnv("NEMOCLAW_LOG_LEVEL", "error");
    vi.stubEnv("NEMOCLAW_DEBUG", "true");

    await ParsingTestCommand.run([], process.cwd());
    expect(log.level).toBe("error");

    await ParsingTestCommand.run(["--debug"], process.cwd());
    expect(log.level).toBe("debug");
  });

  it("translates a shields exit sentinel into an exit code without reprinting (#7382)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(ShieldsSentinelCommand.run([], process.cwd())).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(error).not.toHaveBeenCalled();
  });

  it("keeps the sentinel's non-default exit code", async () => {
    await expect(DriftSentinelCommand.run([], process.cwd())).resolves.toBeUndefined();

    expect(process.exitCode).toBe(2);
  });

  it("passes non-sentinel failures to the default oclif handler", async () => {
    await expect(PlainFailureCommand.run([], process.cwd())).rejects.toThrow("real failure");
  });

  it("rejects schema-5 unsupported parsed commands before the action body (#9203)", async () => {
    useHermesPortableAuthority();

    await expect(ParsedUnsupportedSandboxCommand.run(["alpha"], process.cwd())).rejects.toThrow(
      "not supported for an experimental Hermes portable sandbox",
    );
    expect(ParsedUnsupportedSandboxCommand.ran).toBe(false);
  });

  it("holds the Portable host fence outside the probe-only lifecycle fence (#10423)", async () => {
    vi.stubEnv("HOME", stateDir);
    vi.stubEnv("NEMOCLAW_TEST_BASE_HOME", stateDir);
    useHermesPortableAuthority();
    await ProbeOnlyConnectCommand.run(["alpha", "--probe-only"], process.cwd());

    expect(ProbeOnlyConnectCommand.observed).toEqual({ host: true, lifecycle: true });
    expect(
      fs.existsSync(portableHostAuthority.portableHostFencePath(process.env.HOME || os.homedir())),
    ).toBe(false);
  });

  it("does not create the Portable host fence when a probe has no Hermes receipt candidate (#10423)", async () => {
    vi.stubEnv("HOME", stateDir);
    vi.stubEnv("NEMOCLAW_TEST_BASE_HOME", stateDir);
    vi.spyOn(receiptAuthority, "hasHermesPortableReceiptCandidate").mockReturnValue(false);

    await ProbeOnlyConnectCommand.run(["alpha", "--probe-only"], process.cwd());

    expect(ProbeOnlyConnectCommand.observed).toEqual({ host: false, lifecycle: true });
  });

  it("routes interrupted successor recovery through the public probe fences (#10423)", async () => {
    vi.stubEnv("HOME", stateDir);
    vi.stubEnv("NEMOCLAW_TEST_BASE_HOME", stateDir);
    const ordinaryClassification = vi
      .spyOn(receiptAuthority, "inspectPortableAgentReceiptAuthorityForClassification")
      .mockImplementation(() => {
        throw new Error("incomplete or unknown publication evidence");
      });
    vi.spyOn(receiptAuthority, "hasHermesPortableReceiptCandidate").mockReturnValue(true);
    const requalify = vi
      .spyOn(portableAgentLifecycle, "requalifyPortableAgentSandboxAuthority")
      .mockImplementation((sandboxName) => {
        expect(
          fs.existsSync(
            portableHostAuthority.portableHostFencePath(process.env.HOME || os.homedir()),
          ),
        ).toBe(true);
        expect(isMcpLifecycleLockHeld(sandboxName)).toBe(true);
        return { kind: "already-current", snapshot: {} as never };
      });
    ProbeOnlyConnectCommand.operation = (sandboxName) => {
      portableAgentLifecycle.requalifyPortableAgentSandboxAuthority(sandboxName, {
        readRegistry: () => null,
      });
    };

    await ProbeOnlyConnectCommand.run(["alpha", "--probe-only"], process.cwd());

    expect(requalify).toHaveBeenCalledOnce();
    expect(ordinaryClassification).not.toHaveBeenCalled();
  });

  it("resolves a flag-first parsed sandbox before acquiring the lifecycle fence (#9203)", async () => {
    useHermesPortableAuthority();

    await expect(
      ParsedUnsupportedSandboxCommand.run(["--debug", "alpha"], process.cwd()),
    ).rejects.toThrow("not supported for an experimental Hermes portable sandbox");
    expect(ParsedUnsupportedSandboxCommand.ran).toBe(false);
  });

  it("holds the lifecycle fence through the ordinary action before schema-5 publication (#9203)", async () => {
    vi.spyOn(
      receiptAuthority,
      "inspectPortableAgentReceiptAuthorityForClassification",
    ).mockReturnValue({ kind: "none" });
    let releaseAction!: () => void;
    const actionWaiting = new Promise<void>((resolve) => {
      releaseAction = resolve;
    });
    let actionEntered!: () => void;
    const actionStarted = new Promise<void>((resolve) => {
      actionEntered = resolve;
    });
    ParsedSupportedSandboxCommand.operation = async () => {
      actionEntered();
      await actionWaiting;
    };
    let contenderEntered = false;
    const command = ParsedSupportedSandboxCommand.run(["alpha"], process.cwd());
    await actionStarted;
    const contender = withMcpLifecycleLock("alpha", () => {
      contenderEntered = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(contenderEntered).toBe(false);
    releaseAction();
    await command;
    await contender;
    expect(contenderEntered).toBe(true);
  });

  it("classifies schema-5 publication that wins the lifecycle fence before dispatch (#9203)", async () => {
    const inspect = vi
      .spyOn(receiptAuthority, "inspectPortableAgentReceiptAuthorityForClassification")
      .mockReturnValue({ kind: "none" });
    let releasePublisher!: () => void;
    const publisherWaiting = new Promise<void>((resolve) => {
      releasePublisher = resolve;
    });
    let publisherEntered!: () => void;
    const publisherStarted = new Promise<void>((resolve) => {
      publisherEntered = resolve;
    });
    const publisher = withMcpLifecycleLock("alpha", async () => {
      inspect.mockReturnValue({
        kind: "hermes",
        snapshot: { receipt: { phase: "active" } } as never,
      });
      publisherEntered();
      await publisherWaiting;
    });
    await publisherStarted;
    const command = ParsedUnsupportedSandboxCommand.run(["alpha"], process.cwd());
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(ParsedUnsupportedSandboxCommand.ran).toBe(false);
    releasePublisher();
    await publisher;
    await expect(command).rejects.toThrow(
      "not supported for an experimental Hermes portable sandbox",
    );
    expect(ParsedUnsupportedSandboxCommand.ran).toBe(false);
  });

  it("rejects schema-5 unsupported raw-argv commands before the action body (#9203)", async () => {
    useHermesPortableAuthority();

    await expect(
      RawUnsupportedSandboxCommand.run(["alpha", "--json"], process.cwd()),
    ).rejects.toThrow("not supported for an experimental Hermes portable sandbox");
    expect(RawUnsupportedSandboxCommand.ran).toBe(false);
  });

  it("does not treat raw payload help as a schema-5 admission bypass (#9203)", async () => {
    useHermesPortableAuthority();

    await expect(
      RawUnsupportedSandboxCommand.run(["alpha", "--help"], process.cwd()),
    ).rejects.toThrow("not supported for an experimental Hermes portable sandbox");
    expect(RawUnsupportedSandboxCommand.ran).toBe(false);
  });

  it("reclassifies raw commands after waiting for schema-5 publication (#9203)", async () => {
    const inspect = vi
      .spyOn(receiptAuthority, "inspectPortableAgentReceiptAuthorityForClassification")
      .mockReturnValue({ kind: "none" });
    let releasePublisher!: () => void;
    const publisherWaiting = new Promise<void>((resolve) => {
      releasePublisher = resolve;
    });
    let publisherEntered!: () => void;
    const publisherStarted = new Promise<void>((resolve) => {
      publisherEntered = resolve;
    });
    const publisher = withMcpLifecycleLock("alpha", async () => {
      inspect.mockReturnValue({
        kind: "hermes",
        snapshot: { receipt: { phase: "active" } } as never,
      });
      publisherEntered();
      await publisherWaiting;
    });
    await publisherStarted;
    const command = RawUnsupportedSandboxCommand.run(["alpha", "--", "--help"], process.cwd());
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(RawUnsupportedSandboxCommand.ran).toBe(false);
    releasePublisher();
    await publisher;
    await expect(command).rejects.toThrow(
      "not supported for an experimental Hermes portable sandbox",
    );
    expect(RawUnsupportedSandboxCommand.ran).toBe(false);
  });

  it("rejects schema-5 doctor --fix with option-specific guidance (#9203)", async () => {
    useHermesPortableAuthority();

    await expect(RawSandboxDoctorCommand.run(["alpha", "--fix"], process.cwd())).rejects.toThrow(
      "The --fix option is not supported for an experimental Hermes portable sandbox",
    );
    expect(RawSandboxDoctorCommand.ran).toBe(false);
  });

  it("holds the host fence and rejects global mutations before effects (#9203)", async () => {
    const events: string[] = [];
    vi.spyOn(portableHostAuthority, "withCurrentPortableHostFence").mockImplementation(
      async (operation) => {
        events.push("fence");
        return await operation();
      },
    );
    vi.spyOn(portableHostAuthority, "assertNoHermesPortableHostAuthority").mockImplementation(
      () => {
        events.push("classify");
        throw new Error("schema-5 host authority exists");
      },
    );

    await expect(GlobalUnsupportedMutationCommand.run([], process.cwd())).rejects.toThrow(
      "schema-5 host authority exists",
    );
    expect(events).toEqual(["fence", "classify"]);
    expect(GlobalUnsupportedMutationCommand.ran).toBe(false);
  });

  it("preserves side-effect-free help for host mutation commands (#9203)", async () => {
    const fence = vi.spyOn(portableHostAuthority, "withCurrentPortableHostFence");

    await expect(GlobalUnsupportedMutationCommand.run(["--help"], process.cwd())).rejects.toThrow(
      "Parsing --help",
    );

    expect(fence).not.toHaveBeenCalled();
    expect(GlobalUnsupportedMutationCommand.ran).toBe(false);
  });

  it("does not treat a positional --help value after -- as host help (#9203)", async () => {
    const fence = vi
      .spyOn(portableHostAuthority, "withCurrentPortableHostFence")
      .mockImplementation(async (operation) => await operation());
    const classify = vi
      .spyOn(portableHostAuthority, "assertNoHermesPortableHostAuthority")
      .mockImplementation(() => {
        throw new Error("schema-5 host authority exists");
      });

    await expect(GlobalUseMutationCommand.run(["--", "--help"], process.cwd())).rejects.toThrow(
      "schema-5 host authority exists",
    );

    expect(fence).toHaveBeenCalledOnce();
    expect(classify).toHaveBeenCalledWith(expect.any(String), "use");
    expect(GlobalUseMutationCommand.ran).toBe(false);
  });

  it("recovers sandbox:destroy through the abandoned-timer deadline fence (#10066)", async () => {
    vi.spyOn(receiptAuthority, "inspectPortableAgentReceiptAuthority").mockReturnValue({
      kind: "none",
    });
    fs.writeFileSync(
      path.join(stateDir, "shields-timer-alpha.json"),
      JSON.stringify({
        pid: 2_147_483_647,
        sandboxName: "alpha",
        snapshotPath: path.join(stateDir, "snapshot.yaml"),
        restoreAt: new Date(Date.now() - 1_000).toISOString(),
        processToken: "d".repeat(32),
      }),
    );
    const realLock = mcpLifecycleLock.withMcpLifecycleLock.bind(mcpLifecycleLock);
    const lock = vi
      .spyOn(mcpLifecycleLock, "withMcpLifecycleLock")
      .mockImplementation((sandboxName, operation, options) =>
        realLock(sandboxName, operation, {
          ...options,
          pollIntervalMs: 1,
          timeoutMs: 5_000,
          corruptLockGraceMs: 1,
        }),
      );

    await expect(
      ParsedUnsupportedSandboxCommand.run(["alpha"], process.cwd()),
    ).resolves.toBeUndefined();

    expect(lock).toHaveBeenCalledWith(
      "alpha",
      expect.any(Function),
      expect.objectContaining({ recoverAbandonedExpiredTimer: true }),
    );
    expect(ParsedUnsupportedSandboxCommand.ran).toBe(true);
    const lockPath = getMcpLifecycleLockPath("alpha", stateDir);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(`${lockPath}.containment`)).toBe(false);
    expect(fs.existsSync(`${lockPath}.deadline`)).toBe(false);
  });
});
