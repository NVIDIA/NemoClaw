// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  parseForwardList,
  parseSshProcesses,
  hasActiveForwards,
  getForwardsForSandbox,
  classifySessionState,
  getActiveSandboxSessions,
  type ForwardEntry,
  type SessionClassification,
  type SessionDetectionDeps,
} from "./sandbox-session-state";

describe("parseForwardList", () => {
  it("returns empty array for empty/null input", () => {
    expect(parseForwardList("")).toEqual([]);
    expect(parseForwardList(null)).toEqual([]);
    expect(parseForwardList(undefined)).toEqual([]);
  });

  it("skips header row", () => {
    const output = "SANDBOX  BIND  PORT  PID  STATUS\n";
    expect(parseForwardList(output)).toEqual([]);
  });

  it("parses single forward entry", () => {
    const output = `SANDBOX  BIND  PORT  PID  STATUS
my-sandbox  127.0.0.1  18789  12345  running`;
    const entries = parseForwardList(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      sandboxName: "my-sandbox",
      bind: "127.0.0.1",
      port: "18789",
      pid: 12345,
      status: "running",
    });
  });

  it("parses multiple forward entries", () => {
    const output = `SANDBOX  BIND  PORT  PID  STATUS
sandbox-1  127.0.0.1  18789  100  running
sandbox-2  127.0.0.1  18790  200  running
sandbox-1  127.0.0.1  11434  101  stopped`;
    const entries = parseForwardList(output);
    expect(entries).toHaveLength(3);
    expect(entries[0].sandboxName).toBe("sandbox-1");
    expect(entries[1].sandboxName).toBe("sandbox-2");
    expect(entries[2].status).toBe("stopped");
  });

  it("handles missing PID gracefully", () => {
    const output = "my-sandbox  127.0.0.1  18789  -  running";
    const entries = parseForwardList(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].pid).toBeNull();
  });

  it("handles lines with insufficient columns", () => {
    const output = "incomplete line\nmy-sandbox  127.0.0.1  18789  999  running";
    const entries = parseForwardList(output);
    expect(entries).toHaveLength(1);
    expect(entries[0].sandboxName).toBe("my-sandbox");
  });
});

describe("parseSshProcesses", () => {
  it("returns empty array for empty input", () => {
    expect(parseSshProcesses("", "my-sandbox")).toEqual([]);
    expect(parseSshProcesses(null, "my-sandbox")).toEqual([]);
  });

  it("returns empty array for empty sandbox name", () => {
    expect(parseSshProcesses("12345 ssh openshell-test", "")).toEqual([]);
  });

  it("detects SSH process targeting sandbox", () => {
    const output = `12345 ssh -F /tmp/config openshell-my-sandbox
67890 ssh -F /tmp/config openshell-other-sandbox`;
    const sessions = parseSshProcesses(output, "my-sandbox");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({
      sandboxName: "my-sandbox",
      pid: 12345,
      sshHost: "openshell-my-sandbox",
    });
  });

  it("detects multiple SSH sessions to the same sandbox", () => {
    const output = `111 ssh -F /tmp/a.conf openshell-dev
222 ssh -F /tmp/b.conf openshell-dev
333 ssh -F /tmp/c.conf openshell-prod`;
    const sessions = parseSshProcesses(output, "dev");
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.pid)).toEqual([111, 222]);
  });

  it("ignores unrelated SSH processes", () => {
    const output = `100 ssh user@remote-host
200 ssh -F config openshell-my-sandbox
300 /usr/bin/ssh-agent`;
    const sessions = parseSshProcesses(output, "my-sandbox");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].pid).toBe(200);
  });

  it("does not match partial sandbox name prefixes", () => {
    // openshell-my-sandbox-extended should NOT match openshell-my-sandbox
    const output = `100 ssh -F /tmp/cfg openshell-my-sandbox-extended`;
    const sessions = parseSshProcesses(output, "my-sandbox");
    // Word-boundary matching ensures `openshell-my-sandbox` does not match
    // inside `openshell-my-sandbox-extended`.
    expect(sessions).toHaveLength(0);
  });

  it("matches sandbox name at end of line", () => {
    const output = `100 ssh -F /tmp/cfg openshell-my-sandbox`;
    const sessions = parseSshProcesses(output, "my-sandbox");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].pid).toBe(100);
  });

  it("matches sandbox name followed by whitespace", () => {
    const output = `100 ssh -F /tmp/cfg -o StrictHostKeyChecking=no openshell-dev -t bash`;
    const sessions = parseSshProcesses(output, "dev");
    expect(sessions).toHaveLength(1);
  });
});

describe("hasActiveForwards", () => {
  const entries: ForwardEntry[] = [
    { sandboxName: "dev", bind: "127.0.0.1", port: "18789", pid: 100, status: "running" },
    { sandboxName: "prod", bind: "127.0.0.1", port: "18790", pid: 200, status: "stopped" },
  ];

  it("returns true when sandbox has running forwards", () => {
    expect(hasActiveForwards(entries, "dev")).toBe(true);
  });

  it("returns false when sandbox has only stopped forwards", () => {
    expect(hasActiveForwards(entries, "prod")).toBe(false);
  });

  it("returns false for unknown sandbox", () => {
    expect(hasActiveForwards(entries, "unknown")).toBe(false);
  });
});

describe("getForwardsForSandbox", () => {
  const entries: ForwardEntry[] = [
    { sandboxName: "dev", bind: "127.0.0.1", port: "18789", pid: 100, status: "running" },
    { sandboxName: "dev", bind: "127.0.0.1", port: "11434", pid: 101, status: "running" },
    { sandboxName: "prod", bind: "127.0.0.1", port: "18790", pid: 200, status: "running" },
  ];

  it("filters entries for specific sandbox", () => {
    const result = getForwardsForSandbox(entries, "dev");
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.sandboxName === "dev")).toBe(true);
  });

  it("returns empty for unknown sandbox", () => {
    expect(getForwardsForSandbox(entries, "unknown")).toEqual([]);
  });
});

describe("classifySessionState", () => {
  it("detects active sessions from SSH processes", () => {
    const forwards: ForwardEntry[] = [];
    const sessions = [{ sandboxName: "dev", pid: 100, sshHost: "openshell-dev" }];
    const result = classifySessionState(forwards, sessions, "dev");
    expect(result.hasActiveSessions).toBe(true);
    expect(result.sessionCount).toBe(1);
    expect(result.forwardCount).toBe(0);
    expect(result.sources).toContain("ssh");
  });

  it("forward-only does not count as active SSH session", () => {
    const forwards: ForwardEntry[] = [
      { sandboxName: "dev", bind: "127.0.0.1", port: "18789", pid: 100, status: "running" },
    ];
    const sessions: { sandboxName: string; pid: number; sshHost: string }[] = [];
    const result = classifySessionState(forwards, sessions, "dev");
    expect(result.hasActiveSessions).toBe(false);
    expect(result.forwardCount).toBe(1);
    expect(result.sources).toContain("forward");
    expect(result.sources).not.toContain("ssh");
  });

  it("reports both sources when present", () => {
    const forwards: ForwardEntry[] = [
      { sandboxName: "dev", bind: "127.0.0.1", port: "18789", pid: 100, status: "running" },
    ];
    const sessions = [{ sandboxName: "dev", pid: 200, sshHost: "openshell-dev" }];
    const result = classifySessionState(forwards, sessions, "dev");
    expect(result.hasActiveSessions).toBe(true);
    expect(result.sessionCount).toBe(1);
    expect(result.forwardCount).toBe(1);
    expect(result.sources).toContain("forward");
    expect(result.sources).toContain("ssh");
  });

  it("ignores sessions for other sandboxes", () => {
    const forwards: ForwardEntry[] = [];
    const sessions = [{ sandboxName: "prod", pid: 100, sshHost: "openshell-prod" }];
    const result = classifySessionState(forwards, sessions, "dev");
    expect(result.hasActiveSessions).toBe(false);
    expect(result.sessionCount).toBe(0);
    expect(result.forwardCount).toBe(0);
  });

  it("counts multiple sessions", () => {
    const forwards: ForwardEntry[] = [];
    const sessions = [
      { sandboxName: "dev", pid: 100, sshHost: "openshell-dev" },
      { sandboxName: "dev", pid: 200, sshHost: "openshell-dev" },
    ];
    const result = classifySessionState(forwards, sessions, "dev");
    expect(result.hasActiveSessions).toBe(true);
    expect(result.sessionCount).toBe(2);
    expect(result.forwardCount).toBe(0);
  });
});

describe("getActiveSandboxSessions", () => {
  it("returns detected=false when no deps available", () => {
    const deps: SessionDetectionDeps = {
      getForwardList: () => null,
      getSshProcesses: () => null,
    };
    const result = getActiveSandboxSessions("dev", deps);
    expect(result.detected).toBe(false);
    expect(result.sessions).toEqual([]);
  });

  it("returns detected=false for empty sandbox name", () => {
    const deps: SessionDetectionDeps = {
      getForwardList: () => "some output",
      getSshProcesses: () => "some output",
    };
    const result = getActiveSandboxSessions("", deps);
    expect(result.detected).toBe(false);
  });

  it("detects sessions from pgrep output", () => {
    const deps: SessionDetectionDeps = {
      getForwardList: () => "",
      getSshProcesses: () => "12345 ssh -F /tmp/cfg openshell-my-sandbox\n",
    };
    const result = getActiveSandboxSessions("my-sandbox", deps);
    expect(result.detected).toBe(true);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].pid).toBe(12345);
  });

  it("returns detected=false when pgrep unavailable (forward list alone insufficient)", () => {
    const deps: SessionDetectionDeps = {
      getForwardList: () =>
        "SANDBOX  BIND  PORT  PID  STATUS\nmy-sandbox  127.0.0.1  18789  999  running\n",
      getSshProcesses: () => null,
    };
    const result = getActiveSandboxSessions("my-sandbox", deps);
    // SSH process detection is the authoritative source; forward list alone
    // cannot determine interactive sessions (dashboard forward always runs).
    expect(result.detected).toBe(false);
    expect(result.sessions).toEqual([]);
  });

  it("integrates both sources", () => {
    const deps: SessionDetectionDeps = {
      getForwardList: () =>
        "SANDBOX  BIND  PORT  PID  STATUS\ndev  127.0.0.1  18789  100  running\n",
      getSshProcesses: () => "200 ssh -F /tmp/cfg openshell-dev\n",
    };
    const result = getActiveSandboxSessions("dev", deps);
    expect(result.detected).toBe(true);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].pid).toBe(200);
  });
});
