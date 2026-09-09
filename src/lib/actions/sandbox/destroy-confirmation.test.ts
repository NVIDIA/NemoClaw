// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import * as openshellResolve from "../../adapters/openshell/resolve";
import * as credentialStore from "../../credentials/store";
import * as sandboxSession from "../../state/sandbox-session";
import { confirmSandboxDestroy } from "./destroy-confirmation";

afterEach(() => {
  vi.restoreAllMocks();
});

function stubActiveSessions(pids: number[]): void {
  vi.spyOn(openshellResolve, "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
  vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
    detected: true,
    sessions: pids.map((pid) => ({ sandboxName: "test-sb", pid, sshHost: "test-sb.default" })),
  });
}

describe("destroy confirmation", () => {
  it("warns about active sessions when --yes skips the prompt (#9855)", async () => {
    stubActiveSessions([4242]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const prompt = vi.spyOn(credentialStore, "prompt");

    await expect(confirmSandboxDestroy("test-sb", { yes: true })).resolves.toBe(true);

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Active SSH session detected (1 connection, PID 4242)");
    expect(output).toContain("terminate the active session with a Broken pipe error");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("uses the recorded OpenShell target for active-session detection (#10514)", async () => {
    const createSessionDeps = vi.spyOn(sandboxSession, "createSystemDeps");
    stubActiveSessions([]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runtimeSelection = {
      gatewayName: "nemoclaw-9090",
      workspace: "default",
      localTlsDir: "/authority/tls",
    };

    await expect(
      confirmSandboxDestroy("test-sb", { yes: true }, runtimeSelection),
    ).resolves.toBe(true);

    expect(createSessionDeps).toHaveBeenCalledWith("/usr/bin/openshell", {
      runtimeSelection,
    });
  });

  it("warns about active sessions when --force skips the prompt (#9855)", async () => {
    stubActiveSessions([4242, 4243]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(confirmSandboxDestroy("test-sb", { force: true })).resolves.toBe(true);

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Active SSH sessions detected (2 connections, PIDs 4242, 4243)");
    expect(output).toContain("terminate all active sessions with a Broken pipe error");
  });

  it("stays silent on a pre-confirmed destroy with no active sessions (#9855)", async () => {
    vi.spyOn(openshellResolve, "resolveOpenshell").mockReturnValue("/usr/bin/openshell");
    vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
      detected: true,
      sessions: [],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(confirmSandboxDestroy("test-sb", { yes: true })).resolves.toBe(true);

    expect(log).not.toHaveBeenCalled();
  });

  it("prints the active-session warning before the interactive prompt", async () => {
    stubActiveSessions([4242]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(credentialStore, "prompt").mockResolvedValue("n");

    await expect(confirmSandboxDestroy("test-sb", {})).resolves.toBe(false);

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Active SSH session detected (1 connection, PID 4242)");
    expect(output.indexOf("Active SSH session detected")).toBeLessThan(
      output.indexOf("This cannot be undone."),
    );
  });

  it("treats an unavailable session detector as zero active sessions", async () => {
    vi.spyOn(openshellResolve, "resolveOpenshell").mockReturnValue(null);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(confirmSandboxDestroy("test-sb", { yes: true })).resolves.toBe(true);

    expect(log.mock.calls.flat().join("\n")).not.toContain("Active SSH");
  });
});
