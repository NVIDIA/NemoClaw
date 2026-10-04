// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type {
  OpenShellSandboxBufferedCommandCompletion,
  OpenShellSandboxBufferedCommandExecutor,
} from "../adapters/openshell/sandbox-command";
import type { AgentDefinition } from "./defs";
import {
  checkTerminalAgentVersion,
  formatTerminalAgentVersionFailure,
} from "./terminal-version-drift";

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "langchain-deepagents-code",
    displayName: "LangChain Deep Agents Code",
    versionCommand: "dcode --version",
    expectedVersion: "0.1.13",
    versionScheme: "semver",
    ...overrides,
  } as unknown as AgentDefinition;
}

function executorWith(
  completion: OpenShellSandboxBufferedCommandCompletion,
): OpenShellSandboxBufferedCommandExecutor & { runBuffered: ReturnType<typeof vi.fn> } {
  return { runBuffered: vi.fn(async () => completion) };
}

function completed(stdout: string): OpenShellSandboxBufferedCommandCompletion {
  return { outcome: { kind: "completed", exitCode: 0 }, stdout, stderr: "" };
}

describe("checkTerminalAgentVersion (#6193)", () => {
  it("reports stale when the installed version is below expected_version", async () => {
    const executor = executorWith(completed("LangChain Deep Agents Code v0.1.12"));
    const result = await checkTerminalAgentVersion("dcode-sb", makeAgent(), executor);
    expect(result).toEqual({
      status: "stale",
      installedVersion: "0.1.12",
      expectedVersion: "0.1.13",
      schemeMismatch: false,
    });
    // Probes through the injected OpenShell runner (not a direct SSH spawn),
    // bounded by a timeout so a hung version command can't wedge onboarding.
    expect(executor.runBuffered).toHaveBeenCalledWith({
      sandboxName: "dcode-sb",
      target: { kind: "selected" },
      command: ["sh", "-lc", "dcode --version"],
      timeoutMilliseconds: expect.any(Number),
    });
  });

  it("reports current when the installed version meets expected_version", async () => {
    const executor = executorWith(completed("dcode v0.1.13"));
    await expect(checkTerminalAgentVersion("dcode-sb", makeAgent(), executor)).resolves.toEqual({
      status: "current",
      installedVersion: "0.1.13",
      expectedVersion: "0.1.13",
      schemeMismatch: false,
    });
  });

  it("uses Bash for Pi's exact resource-limit login profile", async () => {
    const executor = executorWith(completed("pi 0.84.1"));

    await expect(
      checkTerminalAgentVersion(
        "pi-sb",
        makeAgent({
          name: "pi",
          displayName: "Pi",
          versionCommand: "pi --version",
          expectedVersion: "0.84.1",
        }),
        executor,
      ),
    ).resolves.toMatchObject({ status: "current", installedVersion: "0.84.1" });
    expect(executor.runBuffered).toHaveBeenCalledWith({
      sandboxName: "pi-sb",
      target: { kind: "selected" },
      command: ["/bin/bash", "-lc", "pi --version"],
      timeoutMilliseconds: expect.any(Number),
    });
  });

  it("reports current when the installed version exceeds expected_version", async () => {
    const executor = executorWith(completed("dcode v0.2.0"));
    await expect(
      checkTerminalAgentVersion("dcode-sb", makeAgent(), executor),
    ).resolves.toMatchObject({
      status: "current",
      installedVersion: "0.2.0",
    });
  });

  it("does not probe when the manifest declares no expected_version", async () => {
    const executor = executorWith(completed("dcode v0.1.12"));
    const agent = makeAgent({ expectedVersion: null } as Partial<AgentDefinition>);
    await expect(checkTerminalAgentVersion("dcode-sb", agent, executor)).resolves.toEqual({
      status: "not-required",
      installedVersion: null,
      expectedVersion: null,
    });
    expect(executor.runBuffered).not.toHaveBeenCalled();
  });

  it("reports unverified when the probe output has no parseable version", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const executor = executorWith(completed("command not found"));
    await expect(checkTerminalAgentVersion("dcode-sb", makeAgent(), executor)).resolves.toEqual({
      status: "unverified",
      installedVersion: null,
      expectedVersion: "0.1.13",
      reason: "unparseable-output",
    });
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("unparseable-output"));
    debugSpy.mockRestore();
  });

  it("does not attribute an unrelated version when the executable reports no version", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const executor = executorWith(completed("Python 3.12.0\ndcode command failed"));
    await expect(checkTerminalAgentVersion("dcode-sb", makeAgent(), executor)).resolves.toEqual({
      status: "unverified",
      installedVersion: null,
      expectedVersion: "0.1.13",
      reason: "unparseable-output",
    });
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("unparseable-output"));
    debugSpy.mockRestore();
  });

  it("reports unverified when the probe produces no output", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const executor = executorWith(completed(""));
    await expect(checkTerminalAgentVersion("dcode-sb", makeAgent(), executor)).resolves.toEqual({
      status: "unverified",
      installedVersion: null,
      expectedVersion: "0.1.13",
      reason: "probe-failed",
    });
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("probe-failed"));
    debugSpy.mockRestore();
  });

  it("contains runner exceptions as an unverified result", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const executor = {
      runBuffered: vi.fn(async () => {
        throw new Error("probe transport failed");
      }),
    };
    await expect(checkTerminalAgentVersion("dcode-sb", makeAgent(), executor)).resolves.toEqual({
      status: "unverified",
      installedVersion: null,
      expectedVersion: "0.1.13",
      reason: "probe-failed",
    });
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("probe-failed"));
    debugSpy.mockRestore();
  });

  it("contains typed transport failures as an unverified result", async () => {
    const executor = executorWith({
      outcome: { kind: "failed", error: { kind: "timeout", message: "timed out" } },
      stdout: "dcode v0.1.12",
      stderr: "",
    });
    const result = await checkTerminalAgentVersion("dcode-sb", makeAgent(), executor);
    expect(result).toMatchObject({ status: "unverified", reason: "probe-failed" });
  });

  it("reads version evidence from buffered stdout", async () => {
    const executor = executorWith(completed("dcode v0.1.12"));
    const result = await checkTerminalAgentVersion("dcode-sb", makeAgent(), executor);
    expect(result).toMatchObject({ status: "stale", installedVersion: "0.1.12" });
  });

  it.each(["dcode 0.1.12, built with SDK 9.8.7", "built on 2026.7.1, dcode 0.1.12"])(
    "uses the CLI version when probe output contains other versions: %s",
    async (output) => {
      const result = await checkTerminalAgentVersion(
        "dcode-sb",
        makeAgent(),
        executorWith(completed(output)),
      );
      expect(result).toMatchObject({ status: "stale", installedVersion: "0.1.12" });
    },
  );

  it("formats a stale-version failure with installed and required versions", () => {
    const line = formatTerminalAgentVersionFailure(makeAgent(), {
      status: "stale",
      installedVersion: "0.1.12",
      expectedVersion: "0.1.13",
      schemeMismatch: false,
    });
    expect(line).toContain("LangChain Deep Agents Code");
    expect(line).toContain("0.1.12");
    expect(line).toContain("0.1.13");
    expect(line).toContain("below required minimum");
  });

  it("describes incomparable version schemes without claiming one is below the other", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await checkTerminalAgentVersion(
        "dcode-sb",
        makeAgent({ expectedVersion: "0.17.0", versionScheme: "semver" }),
        executorWith(completed("dcode 2026.5.27")),
      );
      expect(result).toEqual({
        status: "stale",
        installedVersion: "2026.5.27",
        expectedVersion: "0.17.0",
        schemeMismatch: true,
      });
      const line = formatTerminalAgentVersionFailure(makeAgent(), {
        status: "stale",
        installedVersion: "2026.5.27",
        expectedVersion: "0.17.0",
        schemeMismatch: true,
      });
      expect(line).toContain("different version scheme");
      expect(line).not.toContain("below");
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
