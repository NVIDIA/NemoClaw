// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OpenShellSandboxBufferedCommandCompletion,
  OpenShellSandboxBufferedCommandExecutor,
} from "../../../adapters/openshell/sandbox-command";

const runBufferedMock = vi.hoisted(() =>
  vi.fn<OpenShellSandboxBufferedCommandExecutor["runBuffered"]>(),
);
const execMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureLiveMock = vi.hoisted(() => vi.fn(async () => ({})));
const getSandboxMock = vi.hoisted(() => vi.fn(() => null as { agent?: string } | null));
const withLifecycleLockMock = vi.hoisted(() =>
  vi.fn(async (_sandboxName: string, operation: () => unknown) => await operation()),
);

vi.mock("../exec", async () => {
  const actual = await vi.importActual<typeof import("../exec")>("../exec");
  return { ...actual, execSandbox: execMock };
});
vi.mock("../gateway-state", () => ({ ensureLiveSandboxOrExit: ensureLiveMock }));
vi.mock("../../../state/registry", () => ({ getSandbox: getSandboxMock }));
vi.mock("../../../state/mcp-lifecycle-lock-acquisition", () => ({
  withMcpLifecycleLock: withLifecycleLockMock,
}));

import { WARMUP_SESSION_ID_PREFIX } from "../warmup-session";
import {
  createSessionsPassthrough,
  filterWarmupSessionsListJson,
  filterWarmupSessionsListText,
  printSessionsPassthroughHelp,
} from "./passthrough";

const runSessionsPassthrough = createSessionsPassthrough({
  sandboxCommandExecutor: { runBuffered: runBufferedMock },
});

function completedBufferedCommand(
  stdout: string,
  stderr = "",
  exitCode = 0,
): OpenShellSandboxBufferedCommandCompletion {
  return {
    outcome: { kind: "completed", exitCode },
    stdout,
    stderr,
  };
}

describe("filterWarmupSessionsListJson", () => {
  it("filters internal warm-up sessions from wrapped OpenClaw list JSON (#5511)", () => {
    const filtered = filterWarmupSessionsListJson(
      JSON.stringify({
        count: 2,
        totalCount: 2,
        sessions: [
          { key: "agent:main:explicit:warm", sessionId: `${WARMUP_SESSION_ID_PREFIX}1` },
          { key: "agent:main:explicit:real", sessionId: "sid-real" },
        ],
      }),
    );

    expect(JSON.parse(filtered as string)).toEqual({
      count: 1,
      totalCount: 1,
      sessions: [{ key: "agent:main:explicit:real", sessionId: "sid-real" }],
    });
  });

  it("filters plain array list JSON", () => {
    const filtered = filterWarmupSessionsListJson(
      JSON.stringify([
        { key: "agent:main:explicit:warm", sessionId: `${WARMUP_SESSION_ID_PREFIX}1` },
        { key: "agent:main:explicit:real", sessionId: "sid-real" },
      ]),
    );

    expect(JSON.parse(filtered as string)).toEqual([
      { key: "agent:main:explicit:real", sessionId: "sid-real" },
    ]);
  });

  it("filters warm-up sessions from every recognized wrapped list array", () => {
    const filtered = filterWarmupSessionsListJson(
      JSON.stringify({
        count: 2,
        totalCount: 2,
        sessions: [{ key: "agent:main:explicit:real", sessionId: "sid-real" }],
        entries: [{ key: "agent:main:explicit:warm", sessionId: `${WARMUP_SESSION_ID_PREFIX}1` }],
      }),
    );

    expect(JSON.stringify(JSON.parse(filtered as string))).not.toContain(WARMUP_SESSION_ID_PREFIX);
    expect(JSON.parse(filtered as string)).toEqual({
      count: 1,
      totalCount: 1,
      sessions: [{ key: "agent:main:explicit:real", sessionId: "sid-real" }],
      entries: [],
    });
  });

  it("uses the tolerant session-index parser for noisy JSON output", () => {
    const filtered = filterWarmupSessionsListJson(
      [
        "(node:1) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental",
        JSON.stringify({
          count: 1,
          totalCount: 1,
          sessions: [
            { key: "agent:main:explicit:warm", sessionId: `${WARMUP_SESSION_ID_PREFIX}1` },
          ],
        }),
      ].join("\n"),
    );

    expect(JSON.parse(filtered as string)).toEqual({ count: 0, totalCount: 0, sessions: [] });
  });

  it("filters pretty JSON when stderr warnings are appended to the captured output", () => {
    const filtered = filterWarmupSessionsListJson(
      [
        JSON.stringify(
          {
            path: "/sandbox/.openclaw/agents/main/sessions/sessions.json",
            count: 1,
            totalCount: 1,
            sessions: [
              { key: "agent:main:explicit:warm", sessionId: `${WARMUP_SESSION_ID_PREFIX}1` },
            ],
          },
          null,
          2,
        ),
        "(node:1) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental",
      ].join("\n"),
    );

    expect(JSON.parse(filtered as string)).toEqual({
      path: "/sandbox/.openclaw/agents/main/sessions/sessions.json",
      count: 0,
      totalCount: 0,
      sessions: [],
    });
  });
});

describe("filterWarmupSessionsListText", () => {
  it("filters internal warm-up rows and adjusts the displayed count (#5511)", () => {
    const filtered = filterWarmupSessionsListText(
      [
        "Sessions listed: 2",
        "direct  agent:main:main  1m ago  model  id:sid-real",
        `direct  agent:main:expli...  1m ago  model  id:${WARMUP_SESSION_ID_PREFIX}1`,
        "",
      ].join("\n"),
    );

    expect(filtered).toBe(
      ["Sessions listed: 1", "direct  agent:main:main  1m ago  model  id:sid-real", ""].join("\n"),
    );
  });

  it("filters warm-up rows when the session id uses alternate text labels or a bare id column", () => {
    const filtered = filterWarmupSessionsListText(
      [
        "Sessions listed: 4",
        "direct  agent:main:main  1m ago  model  id:sid-real",
        `direct  agent:main:explicit  1m ago  model  sessionId:${WARMUP_SESSION_ID_PREFIX}session-id`,
        `direct  agent:main:explicit  1m ago  model  sid:${WARMUP_SESSION_ID_PREFIX}sid`,
        `direct  agent:main:explicit  1m ago  model  ${WARMUP_SESSION_ID_PREFIX}bare`,
        "",
      ].join("\n"),
    );

    expect(filtered).toBe(
      ["Sessions listed: 1", "direct  agent:main:main  1m ago  model  id:sid-real", ""].join("\n"),
    );
  });

  it("does not drop unrelated text that merely mentions the warm-up prefix", () => {
    const filtered = filterWarmupSessionsListText(
      [
        "Sessions listed: 1",
        `direct  agent:main:main  1m ago  model  note:${WARMUP_SESSION_ID_PREFIX}mentioned`,
        "",
      ].join("\n"),
    );

    expect(filtered).toBe(
      [
        "Sessions listed: 1",
        `direct  agent:main:main  1m ago  model  note:${WARMUP_SESSION_ID_PREFIX}mentioned`,
        "",
      ].join("\n"),
    );
  });
});

describe("printSessionsPassthroughHelp", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function capturedHelpText(): string {
    return logSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? "")).join("\n");
  }

  it("does not promise OpenClaw-only passthrough for the generic sessions command (#6247)", () => {
    printSessionsPassthroughHelp();
    const help = capturedHelpText();

    expect(help).not.toMatch(/Pass-through to `openclaw sessions/i);
    expect(help).toMatch(/openclaw/i);
    expect(help).toMatch(/hermes sessions list/i);
    // Warm-up filtering is documented as OpenClaw-specific, not universal.
    expect(help).toMatch(/warm-up[^\n]*OpenClaw|OpenClaw[^\n]*warm-up/i);
  });

  it("scopes the list-verb help to per-agent binaries and OpenClaw-only filtering (#6247)", () => {
    printSessionsPassthroughHelp("list");
    const help = capturedHelpText();

    expect(help).not.toMatch(/Pass-through to `openclaw sessions list/i);
    expect(help).toMatch(/sessions list/);
    expect(help).toMatch(/hermes/i);
  });
});

describe("runSessionsPassthrough", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    runBufferedMock.mockReset();
    execMock.mockClear();
    ensureLiveMock.mockClear();
    getSandboxMock.mockReset();
    getSandboxMock.mockReturnValue(null);
    withLifecycleLockMock.mockClear();
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("captures and filters `sessions list --json` instead of streaming warm-up entries", async () => {
    runBufferedMock.mockResolvedValueOnce(
      completedBufferedCommand(
        JSON.stringify({
          count: 1,
          totalCount: 1,
          sessions: [
            { key: "agent:main:explicit:warm", sessionId: `${WARMUP_SESSION_ID_PREFIX}1` },
          ],
        }),
      ),
    );

    await runSessionsPassthrough("alpha", {
      verb: "list",
      extraArgs: ["--agent", "main", "--json"],
    });

    expect(ensureLiveMock).toHaveBeenCalledWith("alpha", {
      allowNonReadyPhase: true,
      exit: expect.any(Function),
    });
    expect(execMock).not.toHaveBeenCalled();
    expect(runBufferedMock).toHaveBeenCalledWith({
      sandboxName: "alpha",
      target: { kind: "selected" },
      command: ["openclaw", "sessions", "list", "--agent", "main", "--json"],
      outputLimitBytes: 64 * 1024 * 1024,
    });
    expect(JSON.parse(String(stdoutSpy.mock.calls[0]?.[0]))).toEqual({
      count: 0,
      totalCount: 0,
      sessions: [],
    });
  });

  it("captures and filters text `sessions list` output", async () => {
    runBufferedMock.mockResolvedValueOnce(
      completedBufferedCommand(
        [
          "Sessions listed: 1",
          `direct  agent:main:expli...  1m ago  model  id:${WARMUP_SESSION_ID_PREFIX}1`,
        ].join("\n"),
        "warning: noisy but non-fatal\n",
      ),
    );

    await runSessionsPassthrough("alpha", { verb: "list", extraArgs: ["--agent", "main"] });

    expect(execMock).not.toHaveBeenCalled();
    expect(runBufferedMock).toHaveBeenCalled();
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toBe("Sessions listed: 0\n");
    expect(String(stderrSpy.mock.calls[0]?.[0])).toBe("warning: noisy but non-fatal\n");
  });

  it("also filters the parent `sessions` list shorthand", async () => {
    runBufferedMock.mockResolvedValueOnce(
      completedBufferedCommand(`Sessions listed: 1\nid:${WARMUP_SESSION_ID_PREFIX}1`),
    );

    await runSessionsPassthrough("alpha", { extraArgs: [] });

    expect(execMock).not.toHaveBeenCalled();
    expect(runBufferedMock).toHaveBeenCalledWith({
      sandboxName: "alpha",
      target: { kind: "selected" },
      command: ["openclaw", "sessions"],
      outputLimitBytes: 64 * 1024 * 1024,
    });
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toBe("Sessions listed: 0\n");
  });

  it("fails closed on unrecognised JSON that could leak a warm-up session", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    runBufferedMock.mockResolvedValueOnce(
      completedBufferedCommand(
        JSON.stringify({
          records: [{ sid: `${WARMUP_SESSION_ID_PREFIX}1` }],
        }),
      ),
    );

    try {
      await expect(
        runSessionsPassthrough("alpha", { verb: "list", extraArgs: ["--json"] }),
      ).rejects.toThrow("process.exit:1");
    } finally {
      exitSpy.mockRestore();
    }

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("Could not parse"));
  });

  it("passes through unrecognised JSON when it cannot leak a warm-up session", async () => {
    const raw = JSON.stringify({ records: [{ key: "agent:main:main", sessionId: "sid-real" }] });
    runBufferedMock.mockResolvedValueOnce(completedBufferedCommand(raw));

    await runSessionsPassthrough("alpha", { verb: "list", extraArgs: ["--json"] });

    expect(String(stdoutSpy.mock.calls[0]?.[0])).toBe(`${raw}\n`);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("reports a clear filter buffer error when large sessions list output exceeds capture capacity", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    runBufferedMock.mockResolvedValueOnce({
      outcome: {
        kind: "failed",
        error: { kind: "capture", message: "stdout exceeded the buffered output limit" },
      },
      stdout: "",
      stderr: "",
    });

    try {
      await expect(
        runSessionsPassthrough("alpha", { verb: "list", extraArgs: ["--all-agents", "--json"] }),
      ).rejects.toThrow("process.exit:1");
    } finally {
      exitSpy.mockRestore();
    }

    expect(runBufferedMock).toHaveBeenCalledWith({
      sandboxName: "alpha",
      target: { kind: "selected" },
      command: ["openclaw", "sessions", "list", "--all-agents", "--json"],
      outputLimitBytes: 64 * 1024 * 1024,
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("output exceeded NemoClaw's 64 MiB filtering buffer"),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("--agent"));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("--limit"));
  });

  it("routes the bare command to `hermes sessions list` and skips warm-up filtering (#6247)", async () => {
    getSandboxMock.mockReturnValue({ agent: "hermes" });

    await runSessionsPassthrough("hermes", { extraArgs: [] });

    expect(runBufferedMock).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledWith(
      "hermes",
      ["hermes", "sessions", "list"],
      {},
      expect.objectContaining({ exit: expect.any(Function) }),
    );
  });

  it("uses openclaw binary for openclaw-agent sandboxes (#6247)", async () => {
    getSandboxMock.mockReturnValue({ agent: "openclaw" });
    runBufferedMock.mockResolvedValueOnce(completedBufferedCommand("Sessions listed: 0\n"));

    await runSessionsPassthrough("alpha", { extraArgs: [] });

    expect(execMock).not.toHaveBeenCalled();
    expect(runBufferedMock).toHaveBeenCalledWith({
      sandboxName: "alpha",
      target: { kind: "selected" },
      command: ["openclaw", "sessions"],
      outputLimitBytes: 64 * 1024 * 1024,
    });
  });

  it("routes hermes `sessions list` with forwarded flags via execSandbox (#6247)", async () => {
    getSandboxMock.mockReturnValue({ agent: "hermes" });

    await runSessionsPassthrough("hermes", {
      verb: "list",
      extraArgs: ["--limit", "5"],
    });

    expect(runBufferedMock).not.toHaveBeenCalled();
    expect(execMock).toHaveBeenCalledWith(
      "hermes",
      ["hermes", "sessions", "list", "--limit", "5"],
      {},
      expect.objectContaining({ exit: expect.any(Function) }),
    );
  });

  it("defaults to the openclaw binary + filter path when the registry has no entry (#6247)", async () => {
    getSandboxMock.mockReturnValue(null);
    runBufferedMock.mockResolvedValueOnce(completedBufferedCommand("Sessions listed: 0\n"));

    await runSessionsPassthrough("alpha", { extraArgs: [] });

    expect(execMock).not.toHaveBeenCalled();
    expect(runBufferedMock).toHaveBeenCalledWith({
      sandboxName: "alpha",
      target: { kind: "selected" },
      command: ["openclaw", "sessions"],
      outputLimitBytes: 64 * 1024 * 1024,
    });
  });

  it("defaults to the openclaw binary for an unknown agent value (#6247)", async () => {
    getSandboxMock.mockReturnValue({ agent: "custom-future-agent" });
    runBufferedMock.mockResolvedValueOnce(completedBufferedCommand("Sessions listed: 0\n"));

    await runSessionsPassthrough("alpha", { extraArgs: [] });

    expect(execMock).not.toHaveBeenCalled();
    expect(runBufferedMock).toHaveBeenCalledWith({
      sandboxName: "alpha",
      target: { kind: "selected" },
      command: ["openclaw", "sessions"],
      outputLimitBytes: 64 * 1024 * 1024,
    });
  });

  it("prints captured output when OpenClaw exits non-zero", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    runBufferedMock.mockResolvedValueOnce(completedBufferedCommand("", "unknown flag: --bad\n", 2));

    try {
      await expect(
        runSessionsPassthrough("alpha", { verb: "list", extraArgs: ["--bad"] }),
      ).rejects.toThrow("process.exit:2");
    } finally {
      exitSpy.mockRestore();
    }

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(String(stderrSpy.mock.calls[0]?.[0])).toBe("unknown flag: --bad\n");
  });

  it.each(["invocation", "unavailable", "timeout"] as const)(
    "reports typed buffered %s failures with their captured streams",
    async (kind) => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
        code?: string | number | null,
      ) => {
        throw new Error(`process.exit:${code}`);
      }) as never);
      runBufferedMock.mockResolvedValueOnce({
        outcome: {
          kind: "failed",
          error: { kind, message: `OpenShell ${kind} failure` },
        },
        stdout: "partial output\n",
        stderr: "transport detail\n",
      });

      try {
        await expect(
          runSessionsPassthrough("alpha", { verb: "list", extraArgs: ["--json"] }),
        ).rejects.toThrow("process.exit:1");
      } finally {
        exitSpy.mockRestore();
      }

      expect(String(stdoutSpy.mock.calls[0]?.[0])).toBe("partial output\n");
      expect(String(stderrSpy.mock.calls[0]?.[0])).toBe("transport detail\n");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        `  Failed to invoke openshell: OpenShell ${kind} failure`,
      );
    },
  );

  it("reports an executor rejection and still releases the lifecycle lock", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    runBufferedMock.mockRejectedValueOnce(new Error("adapter rejected"));

    try {
      await expect(
        runSessionsPassthrough("alpha", { verb: "list", extraArgs: ["--json"] }),
      ).rejects.toThrow("process.exit:1");
    } finally {
      exitSpy.mockRestore();
    }

    expect(consoleErrorSpy).toHaveBeenCalledWith("  Failed to invoke openshell: adapter rejected");
    expect(withLifecycleLockMock).toHaveBeenCalledOnce();
  });
});
