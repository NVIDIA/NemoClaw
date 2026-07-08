// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import * as openshellResolve from "../../adapters/openshell/resolve";
import * as sandboxSession from "../../state/sandbox-session";
import {
  confirmSandboxRebuildIfNeeded,
  countActiveSandboxSessionsForRebuild,
} from "./rebuild-preflight-confirmation";
import { isSingleAgentRebuildSupported } from "./rebuild-preflight-guards";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rebuild confirmation", () => {
  it("accepts trimmed case-insensitive affirmative input", async () => {
    const prompt = vi.fn(async () => " YES ");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(confirmSandboxRebuildIfNeeded(false, 0, prompt)).resolves.toBe(true);

    expect(prompt).toHaveBeenCalledWith("  Proceed? [y/N]: ");
    expect(log).not.toHaveBeenCalledWith("  Cancelled.");
  });

  it("prints active-session risk before asking for confirmation", async () => {
    const prompt = vi.fn(async () => "n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(confirmSandboxRebuildIfNeeded(false, 2, prompt)).resolves.toBe(false);

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Active SSH sessions detected (2 connections)");
    expect(output).toContain("terminate all active sessions with a Broken pipe error");
    expect(output.indexOf("Active SSH sessions detected")).toBeLessThan(
      output.indexOf("Cancelled."),
    );
  });

  it("omits the active-session warning when detection yields no sessions", async () => {
    const prompt = vi.fn(async () => "n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(confirmSandboxRebuildIfNeeded(false, 0, prompt)).resolves.toBe(false);

    const output = log.mock.calls.flat().join("\n");
    expect(output).not.toContain("Active SSH");
    expect(output).toContain("Cancelled.");
  });

  it("does not prompt when confirmation is skipped", async () => {
    const prompt = vi.fn(async () => "n");
    await expect(confirmSandboxRebuildIfNeeded(true, 3, prompt)).resolves.toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe("rebuild preflight guards", () => {
  it("rejects a multi-agent sandbox before later rebuild work", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const bail = (message: string): never => {
      throw new Error(message);
    };

    expect(() =>
      isSingleAgentRebuildSupported(
        { name: "alpha", agents: [{ name: "openclaw" }, { name: "hermes" }] } as never,
        bail,
      ),
    ).toThrow("Multi-agent sandbox rebuild is not yet supported");

    const output = error.mock.calls.flat().join("\n");
    expect(output).toContain("Multi-agent sandbox rebuild is not yet supported");
    expect(output).toContain("Back up state manually");
  });

  it("treats an unavailable OpenShell session detector as zero active sessions", () => {
    vi.spyOn(openshellResolve, "resolveOpenshell").mockReturnValue(null);
    expect(countActiveSandboxSessionsForRebuild("alpha")).toBe(0);
  });

  it("treats a session detector failure as zero active sessions", () => {
    vi.spyOn(openshellResolve, "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
    vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockImplementation(() => {
      throw new Error("session detector unavailable");
    });

    expect(countActiveSandboxSessionsForRebuild("alpha")).toBe(0);
  });
});
