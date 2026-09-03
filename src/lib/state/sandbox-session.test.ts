// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  getActiveSandboxSessions,
  parseSshProcesses,
  type SessionDetectionDeps,
} from "./sandbox-session";

describe("parseSshProcesses", () => {
  it("returns empty array for empty input", () => {
    expect(parseSshProcesses("", "my-sandbox")).toEqual([]);
    expect(parseSshProcesses(null, "my-sandbox")).toEqual([]);
  });

  it("returns empty array for empty sandbox name", () => {
    expect(parseSshProcesses("12345 ssh openshell-test.default", "")).toEqual([]);
  });

  it("detects SSH process targeting sandbox", () => {
    const output = `12345 ssh -F /tmp/config openshell-my-sandbox.default
67890 ssh -F /tmp/config openshell-other-sandbox.default`;
    const sessions = parseSshProcesses(output, "my-sandbox");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({
      sandboxName: "my-sandbox",
      pid: 12345,
      sshHost: "openshell-my-sandbox.default",
    });
  });

  // Newer OpenShell routes every sandbox through one fixed `sandbox` alias and
  // names the target only on its proxy command, so the SSH host carries no
  // sandbox reference at all (#9316).
  const PROXY = (id: string) =>
    `ssh -o ProxyCommand=/usr/local/bin/openshell ssh-proxy --gateway 'https://127.0.0.1:8080' --sandbox-id ${id} --token t --gateway-name nemoclaw -o StrictHostKeyChecking=no`;
  const SANDBOX_ID = "de7eab7a-002f-41e9-acad-5fd4749e07bb";
  const interactiveLine = `12345 ${PROXY(SANDBOX_ID)} -tt -o RequestTTY=force -o SetEnv=TERM=xterm-256color sandbox`;
  const forwardLine = `12300 ${PROXY(SANDBOX_ID)} -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18789:127.0.0.1:18789 sandbox`;

  it("detects a proxied interactive session by sandbox ID (#9316)", () => {
    expect(parseSshProcesses(interactiveLine, "my-sandbox", SANDBOX_ID)).toEqual([
      {
        sandboxName: "my-sandbox",
        pid: 12345,
        sshHost: "openshell-my-sandbox.default",
      },
    ]);
  });

  it("does not count the dashboard forward as a session (#9316)", () => {
    // The forward runs through the same proxy and sandbox ID; only the
    // interactive session requests a TTY. Counting it would report a session
    // on every Ready sandbox.
    expect(parseSshProcesses(forwardLine, "my-sandbox", SANDBOX_ID)).toEqual([]);
    expect(
      parseSshProcesses(`${forwardLine}\n${interactiveLine}`, "my-sandbox", SANDBOX_ID),
    ).toHaveLength(1);
  });

  it("does not attribute a proxied session without a known sandbox ID (#9316)", () => {
    // The command line carries no sandbox name, so guessing would attribute one
    // sandbox's session to another.
    expect(parseSshProcesses(interactiveLine, "my-sandbox")).toEqual([]);
    expect(parseSshProcesses(interactiveLine, "my-sandbox", "")).toEqual([]);
  });

  it("does not match another sandbox's ID (#9316)", () => {
    expect(
      parseSshProcesses(interactiveLine, "other-sandbox", "aaaaaaaa-0000-0000-0000-000000000000"),
    ).toEqual([]);
  });

  it("detects a legacy SSH process during the upgrade window", () => {
    const output = `12345 ssh -F /tmp/config openshell-my-sandbox
67890 ssh -F /tmp/config openshell-other-sandbox`;
    expect(parseSshProcesses(output, "my-sandbox")).toEqual([
      {
        sandboxName: "my-sandbox",
        pid: 12345,
        sshHost: "openshell-my-sandbox",
      },
    ]);
  });

  it("detects multiple SSH sessions to the same sandbox", () => {
    const output = `111 ssh -F /tmp/a.conf openshell-dev.default
222 ssh -F /tmp/b.conf openshell-dev.default
333 ssh -F /tmp/c.conf openshell-prod.default`;
    const sessions = parseSshProcesses(output, "dev");
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.pid)).toEqual([111, 222]);
  });

  it("ignores unrelated SSH processes", () => {
    const output = `100 ssh user@remote-host
200 ssh -F config openshell-my-sandbox.default
300 /usr/bin/ssh-agent`;
    const sessions = parseSshProcesses(output, "my-sandbox");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].pid).toBe(200);
  });

  it("does not match partial sandbox name prefixes", () => {
    // openshell-my-sandbox-extended.default should NOT match
    // openshell-my-sandbox.default
    const output = `100 ssh -F /tmp/cfg openshell-my-sandbox-extended.default`;
    const sessions = parseSshProcesses(output, "my-sandbox");
    // Word-boundary matching ensures `openshell-my-sandbox.default` does not
    // match inside `openshell-my-sandbox-extended.default`.
    expect(sessions).toHaveLength(0);
  });

  it("does not match partial legacy sandbox name prefixes", () => {
    const output = `100 ssh -F /tmp/cfg openshell-my-sandbox-extended`;
    expect(parseSshProcesses(output, "my-sandbox")).toHaveLength(0);
  });

  it("matches sandbox name at end of line", () => {
    const output = `100 ssh -F /tmp/cfg openshell-my-sandbox.default`;
    const sessions = parseSshProcesses(output, "my-sandbox");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].pid).toBe(100);
  });

  it("matches sandbox name followed by whitespace", () => {
    const output = `100 ssh -F /tmp/cfg -o StrictHostKeyChecking=no openshell-dev.default -t bash`;
    const sessions = parseSshProcesses(output, "dev");
    expect(sessions).toHaveLength(1);
  });
});

describe("getActiveSandboxSessions", () => {
  it("returns detected=false when no deps available", () => {
    const deps: SessionDetectionDeps = {
      getSshProcesses: () => null,
    };
    const result = getActiveSandboxSessions("dev", deps);
    expect(result.detected).toBe(false);
    expect(result.sessions).toEqual([]);
  });

  it("returns detected=false for empty sandbox name", () => {
    const deps: SessionDetectionDeps = {
      getSshProcesses: () => "some output",
    };
    const result = getActiveSandboxSessions("", deps);
    expect(result.detected).toBe(false);
  });

  it("detects sessions from pgrep output", () => {
    const deps: SessionDetectionDeps = {
      getSshProcesses: () => "12345 ssh -F /tmp/cfg openshell-my-sandbox.default\n",
    };
    const result = getActiveSandboxSessions("my-sandbox", deps);
    expect(result.detected).toBe(true);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].pid).toBe(12345);
  });

  it("resolves a durable ID for a proxied interactive session (#9316)", () => {
    const sandboxId = "de7eab7a-002f-41e9-acad-5fd4749e07bb";
    const resolveSandboxId = vi.fn(() => sandboxId);
    const deps: SessionDetectionDeps = {
      getSshProcesses: () =>
        `12345 ssh -o ProxyCommand=/usr/local/bin/openshell ssh-proxy --sandbox-id ${sandboxId} --token t -tt -o RequestTTY=force sandbox`,
      resolveSandboxId,
    };

    const result = getActiveSandboxSessions("my-sandbox", deps);

    expect(resolveSandboxId).toHaveBeenCalledExactlyOnceWith("my-sandbox");
    expect(result).toEqual({
      detected: true,
      sessions: [
        {
          sandboxName: "my-sandbox",
          pid: 12345,
          sshHost: "openshell-my-sandbox.default",
        },
      ],
    });
  });

  it("does not resolve a durable ID for a host-alias session (#9316)", () => {
    const resolveSandboxId = vi.fn(() => "unused-id");
    const deps: SessionDetectionDeps = {
      getSshProcesses: () => "12345 ssh -F /tmp/cfg openshell-my-sandbox.default\n",
      resolveSandboxId,
    };

    const result = getActiveSandboxSessions("my-sandbox", deps);

    expect(resolveSandboxId).not.toHaveBeenCalled();
    expect(result.sessions).toHaveLength(1);
  });

  it("returns detected=false when SSH process discovery is unavailable", () => {
    const deps: SessionDetectionDeps = {
      getSshProcesses: () => null,
    };
    const result = getActiveSandboxSessions("my-sandbox", deps);
    expect(result.detected).toBe(false);
    expect(result.sessions).toEqual([]);
  });

  it("returns discovered SSH sessions", () => {
    const deps: SessionDetectionDeps = {
      getSshProcesses: () => "200 ssh -F /tmp/cfg openshell-dev.default\n",
    };
    const result = getActiveSandboxSessions("dev", deps);
    expect(result.detected).toBe(true);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].pid).toBe(200);
  });
});
