// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureMock = vi.hoisted(() => vi.fn());
const execMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureLiveMock = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("../../../adapters/openshell/runtime", () => ({
  captureOpenshell: captureMock,
}));
vi.mock("../exec", async () => {
  const actual = await vi.importActual<typeof import("../exec")>("../exec");
  return { ...actual, execSandbox: execMock };
});
vi.mock("../gateway-state", () => ({ ensureLiveSandboxOrExit: ensureLiveMock }));

import { WARMUP_SESSION_ID_PREFIX } from "../warmup-session";
import {
  filterWarmupSessionsListJson,
  filterWarmupSessionsListText,
  runSessionsPassthrough,
} from "./passthrough";

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

describe("runSessionsPassthrough", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captureMock.mockReset();
    execMock.mockClear();
    ensureLiveMock.mockClear();
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
    captureMock.mockReturnValueOnce({
      status: 0,
      output: JSON.stringify({
        count: 1,
        totalCount: 1,
        sessions: [{ key: "agent:main:explicit:warm", sessionId: `${WARMUP_SESSION_ID_PREFIX}1` }],
      }),
    });

    await runSessionsPassthrough("alpha", {
      verb: "list",
      extraArgs: ["--agent", "main", "--json"],
    });

    expect(ensureLiveMock).toHaveBeenCalledWith("alpha", { allowNonReadyPhase: true });
    expect(execMock).not.toHaveBeenCalled();
    expect(captureMock).toHaveBeenCalledWith(
      [
        "sandbox",
        "exec",
        "--name",
        "alpha",
        "--",
        "openclaw",
        "sessions",
        "list",
        "--agent",
        "main",
        "--json",
      ],
      { ignoreError: true, includeStreams: true, maxBuffer: 64 * 1024 * 1024 },
    );
    expect(JSON.parse(String(stdoutSpy.mock.calls[0]?.[0]))).toEqual({
      count: 0,
      totalCount: 0,
      sessions: [],
    });
  });

  it("captures and filters text `sessions list` output", async () => {
    captureMock.mockReturnValueOnce({
      status: 0,
      stdout: [
        "Sessions listed: 1",
        `direct  agent:main:expli...  1m ago  model  id:${WARMUP_SESSION_ID_PREFIX}1`,
      ].join("\n"),
      stderr: "warning: noisy but non-fatal\n",
      output: [
        "Sessions listed: 1",
        `direct  agent:main:expli...  1m ago  model  id:${WARMUP_SESSION_ID_PREFIX}1`,
      ].join("\n"),
    });

    await runSessionsPassthrough("alpha", { verb: "list", extraArgs: ["--agent", "main"] });

    expect(execMock).not.toHaveBeenCalled();
    expect(captureMock).toHaveBeenCalled();
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toBe("Sessions listed: 0\n");
    expect(String(stderrSpy.mock.calls[0]?.[0])).toBe("warning: noisy but non-fatal\n");
  });

  it("also filters the parent `sessions` list shorthand", async () => {
    captureMock.mockReturnValueOnce({
      status: 0,
      output: `Sessions listed: 1\nid:${WARMUP_SESSION_ID_PREFIX}1`,
    });

    await runSessionsPassthrough("alpha", { extraArgs: [] });

    expect(execMock).not.toHaveBeenCalled();
    expect(captureMock).toHaveBeenCalledWith(
      ["sandbox", "exec", "--name", "alpha", "--", "openclaw", "sessions"],
      { ignoreError: true, includeStreams: true, maxBuffer: 64 * 1024 * 1024 },
    );
    expect(String(stdoutSpy.mock.calls[0]?.[0])).toBe("Sessions listed: 0\n");
  });

  it("fails closed on unrecognised JSON that could leak a warm-up session", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    captureMock.mockReturnValueOnce({
      status: 0,
      output: JSON.stringify({
        records: [{ sid: `${WARMUP_SESSION_ID_PREFIX}1` }],
      }),
    });

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
    captureMock.mockReturnValueOnce({
      status: 0,
      output: raw,
    });

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
    captureMock.mockReturnValueOnce({
      status: null,
      output: "",
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawnSync openshell ENOBUFS"), { code: "ENOBUFS" }),
    });

    try {
      await expect(
        runSessionsPassthrough("alpha", { verb: "list", extraArgs: ["--all-agents", "--json"] }),
      ).rejects.toThrow("process.exit:1");
    } finally {
      exitSpy.mockRestore();
    }

    expect(captureMock).toHaveBeenCalledWith(expect.any(Array), {
      ignoreError: true,
      includeStreams: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("output exceeded NemoClaw's 64 MiB filtering buffer"),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("--agent"));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("--limit"));
  });

  it("prints captured output when OpenClaw exits non-zero", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    captureMock.mockReturnValueOnce({
      status: 2,
      output: "",
      stdout: "",
      stderr: "unknown flag: --bad\n",
    });

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
});
