// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
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

describe("checkTerminalAgentVersion (#6193)", () => {
  it("reports stale when the installed version is below expected_version", () => {
    const runner = vi.fn(() => "LangChain Deep Agents Code v0.1.12");
    const result = checkTerminalAgentVersion("dcode-sb", makeAgent(), runner);
    expect(result).toEqual({
      status: "stale",
      installedVersion: "0.1.12",
      expectedVersion: "0.1.13",
      schemeMismatch: false,
    });
    // Probes through the injected OpenShell runner (not a direct SSH spawn),
    // bounded by a timeout so a hung version command can't wedge onboarding.
    expect(runner).toHaveBeenCalledWith(
      ["sandbox", "exec", "-n", "dcode-sb", "--", "sh", "-lc", "dcode --version"],
      expect.objectContaining({ ignoreError: true, timeout: expect.any(Number) }),
    );
  });

  it("reports current when the installed version meets expected_version", () => {
    const runner = vi.fn(() => "dcode v0.1.13");
    expect(checkTerminalAgentVersion("dcode-sb", makeAgent(), runner)).toEqual({
      status: "current",
      installedVersion: "0.1.13",
      expectedVersion: "0.1.13",
      schemeMismatch: false,
    });
  });

  it("reports current when the installed version exceeds expected_version", () => {
    const runner = vi.fn(() => "dcode v0.2.0");
    expect(checkTerminalAgentVersion("dcode-sb", makeAgent(), runner)).toMatchObject({
      status: "current",
      installedVersion: "0.2.0",
    });
  });

  it("does not probe when the manifest declares no expected_version", () => {
    const runner = vi.fn(() => "dcode v0.1.12");
    const agent = makeAgent({ expectedVersion: null } as Partial<AgentDefinition>);
    expect(checkTerminalAgentVersion("dcode-sb", agent, runner)).toEqual({
      status: "not-required",
      installedVersion: null,
      expectedVersion: null,
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("reports unverified when the probe output has no parseable version", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const runner = vi.fn(() => "command not found");
    expect(checkTerminalAgentVersion("dcode-sb", makeAgent(), runner)).toEqual({
      status: "unverified",
      installedVersion: null,
      expectedVersion: "0.1.13",
      reason: "unparseable-output",
    });
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("unparseable-output"));
    debugSpy.mockRestore();
  });

  it("does not attribute an unrelated version when the executable reports no version", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const runner = vi.fn(() => "Python 3.12.0\ndcode command failed");
    expect(checkTerminalAgentVersion("dcode-sb", makeAgent(), runner)).toEqual({
      status: "unverified",
      installedVersion: null,
      expectedVersion: "0.1.13",
      reason: "unparseable-output",
    });
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("unparseable-output"));
    debugSpy.mockRestore();
  });

  it("reports unverified when the probe produces no output", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const runner = vi.fn(() => ({ output: null }));
    expect(checkTerminalAgentVersion("dcode-sb", makeAgent(), runner)).toEqual({
      status: "unverified",
      installedVersion: null,
      expectedVersion: "0.1.13",
      reason: "probe-failed",
    });
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("probe-failed"));
    debugSpy.mockRestore();
  });

  it("contains runner exceptions as an unverified result", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const runner = vi.fn(() => {
      throw new Error("probe transport failed");
    });
    expect(checkTerminalAgentVersion("dcode-sb", makeAgent(), runner)).toEqual({
      status: "unverified",
      installedVersion: null,
      expectedVersion: "0.1.13",
      reason: "probe-failed",
    });
    expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining("probe-failed"));
    debugSpy.mockRestore();
  });

  it("accepts the { output } runner result shape", () => {
    const runner = vi.fn(() => ({ output: "dcode v0.1.12" }));
    const result = checkTerminalAgentVersion("dcode-sb", makeAgent(), runner);
    expect(result).toMatchObject({ status: "stale", installedVersion: "0.1.12" });
  });

  it.each([
    "dcode 0.1.12, built with SDK 9.8.7",
    "built on 2026.7.1, dcode 0.1.12",
  ])("uses the CLI version when probe output contains other versions: %s", (output) => {
    const result = checkTerminalAgentVersion(
      "dcode-sb",
      makeAgent(),
      vi.fn(() => output),
    );
    expect(result).toMatchObject({ status: "stale", installedVersion: "0.1.12" });
  });

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

  it("describes incomparable version schemes without claiming one is below the other", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = checkTerminalAgentVersion(
        "dcode-sb",
        makeAgent({ expectedVersion: "0.17.0", versionScheme: "semver" }),
        vi.fn(() => "dcode 2026.5.27"),
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
