// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../gateway-state", () => ({
  ensureLiveSandboxOrExit: vi.fn(async () => undefined),
}));

vi.mock("../../../adapters/openshell/runtime", () => ({
  captureOpenshell: vi.fn(),
  runOpenshell: vi.fn(),
}));

vi.mock("../../../state/registry", () => ({
  getSandbox: vi.fn(() => null),
}));

import { captureOpenshell, runOpenshell } from "../../../adapters/openshell/runtime";
import * as registry from "../../../state/registry";
import { isWarmupSessionId, WARMUP_SESSION_ID_PREFIX } from "../warmup-session";
import { buildSandboxTarArgv, exportSandboxSessions } from "./export";

const captureMock = captureOpenshell as unknown as ReturnType<typeof vi.fn>;
const runMock = runOpenshell as unknown as ReturnType<typeof vi.fn>;
const getSandboxMock = registry.getSandbox as unknown as ReturnType<typeof vi.fn>;

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  captureMock.mockReset();
  runMock.mockReset();
  runMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
  getSandboxMock.mockReset();
  getSandboxMock.mockReturnValue(null);
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  consoleLogSpy.mockRestore();
});

function makeCapture(output: string, status = 0) {
  return { status, output, error: undefined as Error | undefined };
}

function makeRun(status: number) {
  return { status, stdout: "", stderr: "" };
}

describe("buildSandboxTarArgv", () => {
  it("isolates resolved files behind `--` and prefixes each with './' so a leading-dash filename cannot be reinterpreted as a tar option", () => {
    expect(
      buildSandboxTarArgv({
        sourceDir: "/sandbox/.openclaw/agents/main/sessions",
        tarballRemote: "/tmp/x.tgz",
        resolvedFiles: ["sid-1.jsonl", "sid-2.jsonl"],
      }),
    ).toEqual([
      "tar",
      "-czf",
      "/tmp/x.tgz",
      "-C",
      "/sandbox/.openclaw/agents/main/sessions",
      "--",
      "./sid-1.jsonl",
      "./sid-2.jsonl",
    ]);
  });
});

describe("isWarmupSessionId", () => {
  it("matches the onboard warm-up session id prefix (#5511)", () => {
    expect(isWarmupSessionId(`${WARMUP_SESSION_ID_PREFIX}123`)).toBe(true);
    expect(isWarmupSessionId("sid-real")).toBe(false);
  });
});

describe("exportSandboxSessions warm-up filtering", () => {
  it("excludes the onboard warm-up session from export-all but keeps real sessions (#5511)", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(
        JSON.stringify([
          { key: "agent:main:main", sessionId: `${WARMUP_SESSION_ID_PREFIX}1` },
          { key: "agent:main:telegram:t-1", sessionId: "sid-real" },
        ]),
      ),
    );

    const result = await exportSandboxSessions({
      sandboxName: "alpha",
      out: "./out.tgz",
      format: "tar",
    });

    const tarCall = runMock.mock.calls[0]?.[0] as string[];
    const shellCommand = tarCall[7] as string;
    expect(result.resolvedSessionIds).toEqual(["sid-real"]);
    expect(shellCommand).toMatch(/-- \.\/sid-real\.jsonl/);
    expect(shellCommand).not.toContain(WARMUP_SESSION_ID_PREFIX);
  });

  it("refuses export-all when only the onboard warm-up session remains (#5511)", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(
        JSON.stringify([
          { key: "agent:main:explicit:warm", sessionId: `${WARMUP_SESSION_ID_PREFIX}1` },
        ]),
      ),
    );

    await expect(
      exportSandboxSessions({
        sandboxName: "alpha",
        out: "./sessions-alpha",
      }),
    ).rejects.toThrow(/agent 'main' has no sessions to bundle/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("still exports a warm-up session when the caller names it explicitly", async () => {
    const warmupId = `${WARMUP_SESSION_ID_PREFIX}explicit`;
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:main:main", sessionId: warmupId }])),
    );

    const result = await exportSandboxSessions({
      sandboxName: "alpha",
      keys: ["agent:main:main"],
      out: "./out.tgz",
      format: "tar",
    });

    expect(result.resolvedSessionIds).toEqual([warmupId]);
    expect(result.resolvedFiles).toEqual([`${warmupId}.jsonl`]);
  });
});

describe("exportSandboxSessions", () => {
  it("enumerates every session via openclaw sessions list when no keys are supplied and tars only the resolved files", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(
        JSON.stringify([
          { key: "agent:main:main", sessionId: "sid-a" },
          { key: "agent:main:telegram:t-1", sessionId: "sid-b" },
        ]),
      ),
    );

    const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation(() => {});

    const result = await exportSandboxSessions({
      sandboxName: "alpha",
      out: "./out.tgz",
      format: "tar",
    });

    // Session JSONL can contain pasted secrets, so the downloaded host bundle
    // must be locked down to owner-only at the resolved host path, not at a
    // path that drifts with the caller's cwd.
    const expectedHostDest = path.resolve(process.cwd(), "out.tgz");
    expect(chmodSpy).toHaveBeenCalledWith(expectedHostDest, 0o600);
    chmodSpy.mockRestore();

    expect(captureMock).toHaveBeenCalledTimes(1);
    const captureCall = captureMock.mock.calls[0]?.[0] as string[];
    expect(captureCall).toContain("openclaw");
    expect(captureCall).toContain("sessions");
    expect(captureCall).toContain("list");
    expect(captureCall).toContain("--agent");
    expect(captureCall).toContain("main");

    const tarCall = runMock.mock.calls[0]?.[0] as string[];
    expect(tarCall.slice(0, 7)).toEqual(["sandbox", "exec", "--name", "alpha", "--", "sh", "-c"]);
    const shellCommand = tarCall[7] as string;
    // Staging directory inside /sandbox keeps openshell's workspace check happy
    // and the umask + chmod chain seals the staging tarball to owner-only.
    expect(shellCommand).toMatch(
      /^umask 077 && mkdir -p \/sandbox\/\.nemoclaw-staging && chmod 700 \/sandbox\/\.nemoclaw-staging && tar -czf \/sandbox\/\.nemoclaw-staging\/sessions-export-main-[0-9a-f]+\.tgz/,
    );
    expect(shellCommand).toMatch(/-- \.\/sid-a\.jsonl \.\/sid-b\.jsonl/);
    expect(shellCommand).toMatch(
      /&& chmod 600 \/sandbox\/\.nemoclaw-staging\/sessions-export-main-[0-9a-f]+\.tgz$/,
    );
    expect(shellCommand).not.toMatch(/sid-a\.trajectory\.jsonl/);

    const downloadCall = runMock.mock.calls[1]?.[0] as string[];
    expect(downloadCall.slice(0, 3)).toEqual(["sandbox", "download", "alpha"]);
    expect(downloadCall[3]).toMatch(
      /^\/sandbox\/\.nemoclaw-staging\/sessions-export-main-[0-9a-f]+\.tgz$/,
    );
    expect(downloadCall.at(-1)).toBe(expectedHostDest);

    expect(result.selectedKeys).toBe("all");
    expect(result.resolvedSessionIds).toEqual(["sid-a", "sid-b"]);
    expect(result.resolvedFiles).toEqual(["sid-a.jsonl", "sid-b.jsonl"]);
    expect(result.hostDest).toBe(expectedHostDest);
    expect(result.bundleBytes).toBeNull();
  });

  it("writes a browsable directory of session files by default (dir format, no tar staging)", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(
        JSON.stringify([
          { key: "agent:main:main", sessionId: "sid-a" },
          { key: "agent:main:telegram:t-1", sessionId: "sid-b" },
        ]),
      ),
    );

    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation(() => {});
    const statSpy = vi
      .spyOn(fs, "statSync")
      .mockReturnValue({ size: 42 } as unknown as ReturnType<typeof fs.statSync>);

    const result = await exportSandboxSessions({
      sandboxName: "alpha",
      out: "./sessions-alpha",
    });

    // dir is the default: no in-sandbox tar/staging, just a per-file download
    // straight into the host directory. The host directory is resolved
    // against process.cwd() so the chmod hardening hits the real file even
    // though openshell runs with a different cwd.
    const expectedDir = path.resolve(process.cwd(), "sessions-alpha");
    const expectedSidA = path.join(expectedDir, "sid-a.jsonl");
    const expectedSidB = path.join(expectedDir, "sid-b.jsonl");
    expect(mkdirSpy).toHaveBeenCalledWith(expectedDir, { recursive: true });
    const shellCalls = runMock.mock.calls.filter((c) => (c[0] as string[]).includes("sh"));
    expect(shellCalls).toHaveLength(0);
    const downloadCalls = runMock.mock.calls.filter((c) => (c[0] as string[])[1] === "download");
    expect(downloadCalls).toHaveLength(2);
    expect(downloadCalls[0]?.[0]).toEqual([
      "sandbox",
      "download",
      "alpha",
      "/sandbox/.openclaw/agents/main/sessions/sid-a.jsonl",
      expectedSidA,
    ]);
    expect(downloadCalls[1]?.[0]).toEqual([
      "sandbox",
      "download",
      "alpha",
      "/sandbox/.openclaw/agents/main/sessions/sid-b.jsonl",
      expectedSidB,
    ]);
    // Every downloaded session file is locked to owner-only — the bug observed
    // in production was inconsistent perms across files in the same export
    // run, so both files in this two-session fixture must see the chmod.
    expect(chmodSpy).toHaveBeenCalledWith(expectedSidA, 0o600);
    expect(chmodSpy).toHaveBeenCalledWith(expectedSidB, 0o600);

    expect(result.format).toBe("dir");
    expect(result.hostDest).toBe(expectedDir);
    expect(result.bundleBytes).toBeNull();
    expect(result.sessions).toEqual([
      {
        key: "agent:main:main",
        sessionId: "sid-a",
        path: expectedSidA,
        sizeBytes: 42,
      },
      {
        key: "agent:main:telegram:t-1",
        sessionId: "sid-b",
        path: expectedSidB,
        sizeBytes: 42,
      },
    ]);

    mkdirSpy.mockRestore();
    chmodSpy.mockRestore();
    statSpy.mockRestore();
  });

  it("dedupes resolved session ids when the same session is referenced by both alias and canonical key", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(
        JSON.stringify([
          { key: "agent:main:main", sessionId: "sid-a" },
          { key: "agent:main:telegram:t-1", sessionId: "sid-b" },
        ]),
      ),
    );

    const result = await exportSandboxSessions({
      sandboxName: "alpha",
      keys: ["agent:main:main", "main"],
      out: "./out.tgz",
      format: "tar",
    });

    expect(result.resolvedSessionIds).toEqual(["sid-a"]);
    expect(result.resolvedFiles).toEqual(["sid-a.jsonl"]);
  });

  it("resolves canonical keys to filenames via openclaw sessions list", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(
        JSON.stringify([
          { key: "agent:main:main", sessionId: "sid-1" },
          { key: "agent:main:telegram:t-1", sessionId: "sid-2" },
        ]),
      ),
    );

    const result = await exportSandboxSessions({
      sandboxName: "alpha",
      keys: ["agent:main:telegram:t-1"],
      out: "./out.tgz",
      format: "tar",
      includeTrajectory: true,
    });

    const tarCall = runMock.mock.calls[0]?.[0] as string[];
    const shellCommand = tarCall[7] as string;
    expect(shellCommand).toMatch(/-- \.\/sid-2\.jsonl \.\/sid-2\.trajectory\.jsonl/);
    expect(shellCommand).not.toMatch(/sid-1\.jsonl/);
    expect(result.selectedKeys).toEqual(["agent:main:telegram:t-1"]);
    expect(result.resolvedFiles).toEqual(["sid-2.jsonl", "sid-2.trajectory.jsonl"]);
  });

  it("treats alias keys under the --agent flag as canonical", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:work:telegram:t-1", sessionId: "sid-9" }])),
    );

    await exportSandboxSessions({
      sandboxName: "alpha",
      agent: "work",
      keys: ["telegram:t-1"],
      out: "./out.tgz",
      format: "tar",
    });

    const captureCall = captureMock.mock.calls[0]?.[0] as string[];
    expect(captureCall).toContain("--agent");
    expect(captureCall).toContain("work");
    const tarCall = runMock.mock.calls[0]?.[0] as string[];
    expect(tarCall[7]).toMatch(/sid-9\.jsonl/);
  });

  it("refuses canonical keys whose agent disagrees with --agent", async () => {
    await expect(
      exportSandboxSessions({
        sandboxName: "alpha",
        agent: "work",
        keys: ["agent:main:main"],
      }),
    ).rejects.toThrow(/scoped to agent 'main', not 'work'/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("refuses to tar when a requested key cannot be found in the index", async () => {
    captureMock.mockReturnValueOnce(makeCapture(JSON.stringify([])));
    await expect(
      exportSandboxSessions({
        sandboxName: "alpha",
        keys: ["agent:main:main"],
      }),
    ).rejects.toThrow(/no entries found in agent 'main'/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("refuses to export when the agent has no sessions at all", async () => {
    captureMock.mockReturnValueOnce(makeCapture(JSON.stringify([])));
    await expect(
      exportSandboxSessions({
        sandboxName: "alpha",
        out: "./out.tgz",
        format: "tar",
      }),
    ).rejects.toThrow(/agent 'main' has no sessions to bundle/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("refuses to export when sessions list emits an unrecognised payload (does not silently fall back to no-sessions)", async () => {
    captureMock.mockReturnValueOnce(makeCapture("upstream changed contract\n<not json>"));
    await expect(
      exportSandboxSessions({
        sandboxName: "alpha",
        out: "./out.tgz",
        format: "tar",
      }),
    ).rejects.toThrow(/Could not parse `openclaw sessions list/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("refuses to tar when a resolved session id starts with '-' (would be interpreted as a tar option)", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(
        JSON.stringify([{ key: "agent:main:main", sessionId: "--checkpoint-action=exec=sh" }]),
      ),
    );
    await expect(
      exportSandboxSessions({
        sandboxName: "alpha",
        keys: ["agent:main:main"],
      }),
    ).rejects.toThrow(/contains unsafe characters or starts with '-'/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("cleans up the staging tarball after the host download succeeds", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:main:main", sessionId: "sid-a" }])),
    );
    await exportSandboxSessions({
      sandboxName: "alpha",
      out: "./out.tgz",
      format: "tar",
    });
    const cleanupCall = runMock.mock.calls.at(-1);
    expect(cleanupCall?.[0]).toContain("rm");
    expect(cleanupCall?.[0]).toContain("-f");
    expect(cleanupCall?.[1]).toMatchObject({ ignoreError: true });
  });

  it("still cleans up the staging tarball when the in-sandbox tar exits non-zero", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:main:main", sessionId: "sid-a" }])),
    );
    runMock.mockReturnValueOnce(makeRun(1));
    await expect(
      exportSandboxSessions({
        sandboxName: "alpha",
        out: "./out.tgz",
        format: "tar",
      }),
    ).rejects.toThrow(/Failed to tar sessions/);
    const cleanupCall = runMock.mock.calls.at(-1);
    expect(cleanupCall?.[0]).toContain("rm");
    expect(cleanupCall?.[0]).toContain("-f");
    expect(cleanupCall?.[1]).toMatchObject({ ignoreError: true });
  });

  it("still cleans up the staging tarball when the host download exits non-zero", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:main:main", sessionId: "sid-a" }])),
    );
    runMock.mockReturnValueOnce(makeRun(0)).mockReturnValueOnce(makeRun(1));
    await expect(
      exportSandboxSessions({
        sandboxName: "alpha",
        out: "./out.tgz",
        format: "tar",
      }),
    ).rejects.toThrow(/Failed to download/);
    const cleanupCall = runMock.mock.calls.at(-1);
    expect(cleanupCall?.[0]).toContain("rm");
    expect(cleanupCall?.[0]).toContain("-f");
    expect(cleanupCall?.[1]).toMatchObject({ ignoreError: true });
  });

  it("emits a JSON manifest with resolved session ids, files, host path, and bundle size when --json is set", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:main:main", sessionId: "sid-a" }])),
    );
    await exportSandboxSessions({
      sandboxName: "alpha",
      out: "./out.tgz",
      format: "tar",
      json: true,
    });
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const printed = consoleLogSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(printed);
    expect(parsed).toMatchObject({
      sandboxName: "alpha",
      agent: "main",
      selectedKeys: "all",
      resolvedSessionIds: ["sid-a"],
      resolvedFiles: ["sid-a.jsonl"],
      hostDest: path.resolve(process.cwd(), "out.tgz"),
    });
    expect(parsed).toHaveProperty("bundleBytes");
  });
});

describe("exportSandboxSessions (hermes sandbox)", () => {
  let mkdtempSpy: ReturnType<typeof vi.spyOn>;
  let chmodSpy: ReturnType<typeof vi.spyOn>;
  let renameSpy: ReturnType<typeof vi.spyOn>;
  let rmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mkdtempSpy = vi
      .spyOn(fs, "mkdtempSync")
      .mockImplementation((prefix) => `${prefix as string}stubdir`);
    chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation(() => {});
    renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {});
    rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => {});
  });

  afterEach(() => {
    mkdtempSpy.mockRestore();
    chmodSpy.mockRestore();
    renameSpy.mockRestore();
    rmSpy.mockRestore();
  });

  it("routes to `hermes sessions export` instead of `openclaw sessions list` when the registry marks the sandbox as hermes", async () => {
    getSandboxMock.mockReturnValue({ name: "alpha", agent: "hermes" });

    const result = await exportSandboxSessions({ sandboxName: "alpha" });

    expect(captureMock).not.toHaveBeenCalled();

    const execCall = runMock.mock.calls[0]?.[0] as string[];
    expect(execCall.slice(0, 7)).toEqual(["sandbox", "exec", "--name", "alpha", "--", "sh", "-c"]);
    const shellCommand = execCall[7] as string;
    expect(shellCommand).toMatch(
      /^umask 077 && mkdir -p \/sandbox\/\.nemoclaw-staging && chmod 700 \/sandbox\/\.nemoclaw-staging && hermes sessions export \/sandbox\/\.nemoclaw-staging\/sessions-export-hermes-[0-9a-f]+\.jsonl && chmod 600 \/sandbox\/\.nemoclaw-staging\/sessions-export-hermes-[0-9a-f]+\.jsonl$/,
    );

    const downloadCall = runMock.mock.calls[1]?.[0] as string[];
    expect(downloadCall.slice(0, 3)).toEqual(["sandbox", "download", "alpha"]);
    expect(downloadCall[3]).toMatch(
      /^\/sandbox\/\.nemoclaw-staging\/sessions-export-hermes-[0-9a-f]+\.jsonl$/,
    );
    const hostStagingPath = downloadCall.at(-1) as string;
    expect(hostStagingPath).toContain(".sessions-export-hermes-");
    expect(hostStagingPath.endsWith("sessions-alpha.jsonl")).toBe(true);
    expect(hostStagingPath).not.toBe("./sessions-alpha.jsonl");

    const cleanupCall = runMock.mock.calls.at(-1);
    expect(cleanupCall?.[0]).toContain("rm");
    expect(cleanupCall?.[0]).toContain("-f");

    expect(chmodSpy).toHaveBeenCalledWith(hostStagingPath, 0o600);
    expect(renameSpy).toHaveBeenCalledWith(hostStagingPath, "./sessions-alpha.jsonl");

    expect(result).toMatchObject({
      sandboxName: "alpha",
      agent: "hermes",
      format: "jsonl",
      selectedKeys: "all",
      resolvedSessionIds: [],
      resolvedFiles: ["sessions-alpha.jsonl"],
      hostDest: "./sessions-alpha.jsonl",
      sessions: [],
    });
  });

  it("honours --out for the host destination on a hermes sandbox", async () => {
    getSandboxMock.mockReturnValue({ name: "alpha", agent: "hermes" });

    const result = await exportSandboxSessions({
      sandboxName: "alpha",
      out: "./hermes-bundle.jsonl",
    });

    const downloadCall = runMock.mock.calls[1]?.[0] as string[];
    const hostStagingPath = downloadCall.at(-1) as string;
    expect(hostStagingPath).toContain(".sessions-export-hermes-");
    expect(hostStagingPath.endsWith("hermes-bundle.jsonl")).toBe(true);
    expect(renameSpy).toHaveBeenCalledWith(hostStagingPath, "./hermes-bundle.jsonl");
    expect(result.hostDest).toBe("./hermes-bundle.jsonl");
    expect(result.resolvedFiles).toEqual(["hermes-bundle.jsonl"]);
  });

  it("aborts the export and skips download when the in-sandbox `hermes sessions export` exits non-zero, while still cleaning up the staging file", async () => {
    getSandboxMock.mockReturnValue({ name: "alpha", agent: "hermes" });
    runMock.mockReturnValueOnce(makeRun(1));

    await expect(exportSandboxSessions({ sandboxName: "alpha" })).rejects.toThrow(
      /Failed to export hermes sessions/,
    );

    expect(runMock).toHaveBeenCalledTimes(2);
    const execCall = runMock.mock.calls[0]?.[0] as string[];
    expect(execCall.slice(0, 3)).toEqual(["sandbox", "exec", "--name"]);
    const cleanupCall = runMock.mock.calls[1]?.[0] as string[];
    expect(cleanupCall).toContain("rm");
    expect(cleanupCall).toContain("-f");
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it("cleans up the in-sandbox staging file even when the host download exits non-zero", async () => {
    getSandboxMock.mockReturnValue({ name: "alpha", agent: "hermes" });
    runMock.mockReturnValueOnce(makeRun(0)).mockReturnValueOnce(makeRun(1));

    await expect(exportSandboxSessions({ sandboxName: "alpha" })).rejects.toThrow(
      /Failed to download/,
    );
    const cleanupCall = runMock.mock.calls.at(-1);
    expect(cleanupCall?.[0]).toContain("rm");
    expect(cleanupCall?.[0]).toContain("-f");
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it("fails closed when chmod on the staging file errors so a permissive host cannot end up with a world-readable session bundle", async () => {
    getSandboxMock.mockReturnValue({ name: "alpha", agent: "hermes" });
    chmodSpy.mockImplementation(() => {
      throw new Error("EPERM");
    });

    await expect(exportSandboxSessions({ sandboxName: "alpha" })).rejects.toThrow(/EPERM/);
    expect(renameSpy).not.toHaveBeenCalled();
    const cleanupCall = runMock.mock.calls.at(-1);
    expect(cleanupCall?.[0]).toContain("rm");
    expect(cleanupCall?.[0]).toContain("-f");
  });

  it("refuses non-hermes --agent values, positional keys, --include-trajectory, and --format tar on a hermes sandbox so users see a clear error rather than a silent half-export", async () => {
    getSandboxMock.mockReturnValue({ name: "alpha", agent: "hermes" });
    await expect(exportSandboxSessions({ sandboxName: "alpha", agent: "main" })).rejects.toThrow(
      /--agent main is OpenClaw-specific/,
    );
    await expect(exportSandboxSessions({ sandboxName: "alpha", keys: ["main"] })).rejects.toThrow(
      /positional session keys are OpenClaw-specific/,
    );
    await expect(
      exportSandboxSessions({ sandboxName: "alpha", includeTrajectory: true }),
    ).rejects.toThrow(/--include-trajectory is OpenClaw-specific/);
    await expect(exportSandboxSessions({ sandboxName: "alpha", format: "tar" })).rejects.toThrow(
      /--format tar is OpenClaw-specific/,
    );
    expect(runMock).not.toHaveBeenCalled();
  });

  it("accepts `--agent hermes` as a no-op alias on a hermes sandbox and still routes to `hermes sessions export`", async () => {
    getSandboxMock.mockReturnValue({ name: "alpha", agent: "hermes" });

    const result = await exportSandboxSessions({ sandboxName: "alpha", agent: "hermes" });

    expect(captureMock).not.toHaveBeenCalled();
    const execCall = runMock.mock.calls[0]?.[0] as string[];
    const shellCommand = execCall[7] as string;
    expect(shellCommand).toContain("hermes sessions export");
    expect(result.agent).toBe("hermes");
    expect(result.format).toBe("jsonl");
  });

  it("warns about a non-zero in-sandbox cleanup exit so a leftover sensitive JSONL never disappears silently from the sandbox", async () => {
    getSandboxMock.mockReturnValue({ name: "alpha", agent: "hermes" });
    runMock
      .mockReturnValueOnce(makeRun(0))
      .mockReturnValueOnce(makeRun(0))
      .mockReturnValueOnce(makeRun(2));
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = await exportSandboxSessions({ sandboxName: "alpha" });
      expect(result.agent).toBe("hermes");
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /failed to remove in-sandbox staging file '\/sandbox\/\.nemoclaw-staging\/sessions-export-hermes-[0-9a-f]+\.jsonl'.*sandbox 'alpha'.*exit 2/,
        ),
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("warns about a non-zero in-sandbox cleanup exit without masking the primary export error", async () => {
    getSandboxMock.mockReturnValue({ name: "alpha", agent: "hermes" });
    runMock.mockReturnValueOnce(makeRun(1)).mockReturnValueOnce(makeRun(3));
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(exportSandboxSessions({ sandboxName: "alpha" })).rejects.toThrow(
        /Failed to export hermes sessions/,
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/failed to remove in-sandbox staging file.*exit 3/),
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("warns with the local staging directory when host cleanup fails after a finalization error so a leftover JSONL with pasted secrets does not vanish silently", async () => {
    getSandboxMock.mockReturnValue({ name: "alpha", agent: "hermes" });
    chmodSpy.mockImplementation(() => {
      throw new Error("EPERM");
    });
    rmSpy.mockImplementation(() => {
      throw new Error("EACCES");
    });
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(exportSandboxSessions({ sandboxName: "alpha" })).rejects.toThrow(/EPERM/);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /failed to remove local staging directory '.*\.sessions-export-hermes-.*'.*EACCES/,
        ),
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});
