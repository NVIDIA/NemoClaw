// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../gateway-state", () => ({
  ensureLiveSandboxOrExit: vi.fn(async () => undefined),
  getKnownSandboxTargetGatewayName: vi.fn(() => "gateway-alpha"),
}));

vi.mock("../../../adapters/openshell/runtime", () => ({
  captureOpenshell: vi.fn(),
  runOpenshell: vi.fn(),
}));

const transferRunMock = vi.hoisted(() => vi.fn());
vi.mock("../../../adapters/openshell/sandbox-transfer-cli", () => ({
  createCliOpenShellSandboxTransferExecutor: () => ({ run: transferRunMock }),
}));

vi.mock("../../../state/registry", () => ({
  getSandbox: vi.fn(() => null),
}));

const withLifecycleLockMock = vi.hoisted(() =>
  vi.fn(async (_sandboxName: string, operation: () => unknown) => await operation()),
);
vi.mock("../../../state/mcp-lifecycle-lock-acquisition", () => ({
  withMcpLifecycleLock: withLifecycleLockMock,
}));

import { captureOpenshell, runOpenshell } from "../../../adapters/openshell/runtime";
import type { OpenShellSandboxTransferCompletion } from "../../../adapters/openshell/sandbox-transfer";
import * as registry from "../../../state/registry";
import { ensureLiveSandboxOrExit, getKnownSandboxTargetGatewayName } from "../gateway-state";
import { isWarmupSessionId, WARMUP_SESSION_ID_PREFIX } from "../warmup-session";
import { buildSandboxTarArgv, exportSandboxSessions } from "./export";

const captureMock = captureOpenshell as unknown as ReturnType<typeof vi.fn>;
const runMock = runOpenshell as unknown as ReturnType<typeof vi.fn>;
const getSandboxMock = registry.getSandbox as unknown as ReturnType<typeof vi.fn>;
const ensureLiveMock = ensureLiveSandboxOrExit as unknown as ReturnType<typeof vi.fn>;
const getKnownGatewayMock = getKnownSandboxTargetGatewayName as unknown as ReturnType<typeof vi.fn>;

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let statSyncSpy: ReturnType<typeof vi.spyOn>;
let stagingMkdtempSpy: ReturnType<typeof vi.spyOn>;
let stagingRenameSpy: ReturnType<typeof vi.spyOn>;
let stagingRmSpy: ReturnType<typeof vi.spyOn>;
let processExitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  captureMock.mockReset();
  runMock.mockReset();
  runMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
  transferRunMock.mockReset();
  transferRunMock.mockImplementation(async () => makeTransferCompletion());
  getSandboxMock.mockReset();
  getSandboxMock.mockReturnValue(null);
  ensureLiveMock.mockReset();
  ensureLiveMock.mockResolvedValue(undefined);
  getKnownGatewayMock.mockReset();
  getKnownGatewayMock.mockReturnValue("gateway-alpha");
  withLifecycleLockMock.mockClear();
  processExitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit:${code ?? 0}`);
  });
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  // Default to a present, non-empty regular file so the post-download artifact
  // verification (assertDownloadedFile) treats the mocked download as complete.
  // Individual tests override this to simulate a missing/empty artifact.
  statSyncSpy = vi
    .spyOn(fs, "statSync")
    .mockReturnValue({ size: 42, isFile: () => true } as unknown as ReturnType<typeof fs.statSync>);
  // Downloads are mocked and never write, so the host-side staging pipeline
  // (mkdtemp -> verify -> rename -> rm) must not touch the real filesystem.
  // The deterministic mkdtemp suffix lets tests compute staging paths.
  stagingMkdtempSpy = vi
    .spyOn(fs, "mkdtempSync")
    .mockImplementation((prefix) => `${prefix as string}stub`);
  stagingRenameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {});
  stagingRmSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  consoleLogSpy.mockRestore();
  statSyncSpy.mockRestore();
  stagingMkdtempSpy.mockRestore();
  stagingRenameSpy.mockRestore();
  stagingRmSpy.mockRestore();
  processExitSpy.mockRestore();
});

function makeCapture(output: string, status = 0) {
  return { status, output, error: undefined as Error | undefined };
}

function makeRun(status: number) {
  return { status, stdout: "", stderr: "" };
}

function shellCommand(args: string[]): string {
  return args[args.indexOf("-c") + 1] ?? "";
}

function makeTransferCompletion(
  outcome: OpenShellSandboxTransferCompletion["outcome"] = { kind: "completed", exitCode: 0 },
  interrupted = false,
): OpenShellSandboxTransferCompletion {
  return {
    outcome,
    wasInterrupted: vi.fn(() => interrupted),
    release: vi.fn(),
  };
}

// A statSync stand-in for "this path does not exist". Kept branchless so the
// mocks that use it stay linear (the changed-test if-statement guardrail).
function throwEnoent(): never {
  throw new Error("ENOENT");
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
  it("defers a readiness exit through lifecycle authority (#9203)", async () => {
    ensureLiveMock.mockImplementationOnce(async (_sandboxName, options) => options.exit(1));

    await expect(
      exportSandboxSessions({
        sandboxName: "alpha",
        out: "./out.tgz",
        format: "tar",
      }),
    ).rejects.toThrow(/process\.exit:1/);

    expect(withLifecycleLockMock).toHaveBeenCalledOnce();
    expect(captureMock).not.toHaveBeenCalled();
  });

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
    const command = shellCommand(tarCall);
    expect(result.resolvedSessionIds).toEqual(["sid-real"]);
    expect(command).toMatch(/-- \.\/sid-real\.jsonl/);
    expect(command).not.toContain(WARMUP_SESSION_ID_PREFIX);
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
    try {
      const result = await exportSandboxSessions({
        sandboxName: "alpha",
        out: "./out.tgz",
        format: "tar",
      });

      // Session JSONL can contain pasted secrets, so the downloaded bundle must
      // be locked down to owner-only while it is still staged — the publish
      // rename preserves the mode, so the bundle is never world-readable at the
      // final path. The download lands in a fresh staging directory next to the
      // destination (#7367: a stale pre-existing bundle must never satisfy the
      // post-download verification), and is renamed into place after it passes.
      const expectedHostDest = path.resolve(process.cwd(), "out.tgz");
      const expectedStagingPath = path.join(
        path.dirname(expectedHostDest),
        ".sessions-export-stub",
        "out.tgz",
      );
      expect(chmodSpy).toHaveBeenCalledWith(expectedStagingPath, 0o600);
      expect(stagingRenameSpy).toHaveBeenCalledWith(expectedStagingPath, expectedHostDest);
      expect(stagingRmSpy).toHaveBeenCalledWith(path.dirname(expectedStagingPath), {
        recursive: true,
        force: true,
      });

      expect(captureMock).toHaveBeenCalledTimes(1);
      const captureCall = captureMock.mock.calls[0]?.[0] as string[];
      expect(captureCall.slice(0, 7)).toEqual([
        "sandbox",
        "exec",
        "-g",
        "gateway-alpha",
        "--name",
        "alpha",
        "--",
      ]);
      expect(captureCall).toContain("openclaw");
      expect(captureCall).toContain("sessions");
      expect(captureCall).toContain("list");
      expect(captureCall).toContain("--agent");
      expect(captureCall).toContain("main");

      const tarCall = runMock.mock.calls[0]?.[0] as string[];
      expect(tarCall.slice(0, 7)).toEqual([
        "sandbox",
        "exec",
        "-g",
        "gateway-alpha",
        "--name",
        "alpha",
        "--",
      ]);
      const command = shellCommand(tarCall);
      // Staging directory inside /sandbox keeps openshell's workspace check happy
      // and the umask + chmod chain seals the staging tarball to owner-only.
      expect(command).toMatch(
        /^umask 077 && mkdir -p \/sandbox\/\.nemoclaw-staging && chmod 700 \/sandbox\/\.nemoclaw-staging && tar -czf \/sandbox\/\.nemoclaw-staging\/sessions-export-main-[0-9a-f]+\.tgz/,
      );
      expect(command).toMatch(/-- \.\/sid-a\.jsonl \.\/sid-b\.jsonl/);
      expect(command).toMatch(
        /&& chmod 600 \/sandbox\/\.nemoclaw-staging\/sessions-export-main-[0-9a-f]+\.tgz$/,
      );
      expect(command).not.toMatch(/sid-a\.trajectory\.jsonl/);

      const downloadCall = transferRunMock.mock.calls[0]?.[0];
      expect(downloadCall).toMatchObject({
        direction: "download",
        sandboxName: "alpha",
        target: { kind: "named", gatewayName: "gateway-alpha" },
        destination: expectedStagingPath,
      });
      expect(downloadCall.source).toMatch(
        /^\/sandbox\/\.nemoclaw-staging\/sessions-export-main-[0-9a-f]+\.tgz$/,
      );
      expect(runMock.mock.calls.at(-1)?.[0]).toEqual(
        expect.arrayContaining(["sandbox", "exec", "-g", "gateway-alpha", "rm", "-f"]),
      );

      expect(result.selectedKeys).toBe("all");
      expect(result.resolvedSessionIds).toEqual(["sid-a", "sid-b"]);
      expect(result.resolvedFiles).toEqual(["sid-a.jsonl", "sid-b.jsonl"]);
      expect(result.hostDest).toBe(expectedHostDest);
      expect(result.bundleBytes).toBe(42);
    } finally {
      chmodSpy.mockRestore();
    }
  });

  it("uses the selected gateway for every operation when the sandbox has no recorded gateway", async () => {
    getKnownGatewayMock.mockReturnValue(null);
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:main:main", sessionId: "sid-a" }])),
    );
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation(() => {});

    try {
      await exportSandboxSessions({ sandboxName: "alpha", out: "./sessions-alpha" });
      expect(captureMock.mock.calls[0]?.[0]).not.toContain("-g");
      expect(transferRunMock.mock.calls[0]?.[0]).toMatchObject({
        target: { kind: "selected" },
      });
    } finally {
      mkdirSpy.mockRestore();
      chmodSpy.mockRestore();
    }
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
    try {
      const result = await exportSandboxSessions({
        sandboxName: "alpha",
        out: "./sessions-alpha",
      });

      // dir is the default: no in-sandbox tar/staging, but each file downloads
      // into a fresh host-side staging directory inside the export directory and
      // is renamed into place only after verification (#7367: a stale file from
      // an earlier export must never satisfy the post-download check). The host
      // directory is resolved against process.cwd() so the chmod hardening hits
      // the real file even though openshell runs with a different cwd.
      const expectedDir = path.resolve(process.cwd(), "sessions-alpha");
      const expectedSidA = path.join(expectedDir, "sid-a.jsonl");
      const expectedSidB = path.join(expectedDir, "sid-b.jsonl");
      const expectedStagingDir = path.join(expectedDir, ".sessions-export-stub");
      const expectedStagingSidA = path.join(expectedStagingDir, "sid-a.jsonl");
      const expectedStagingSidB = path.join(expectedStagingDir, "sid-b.jsonl");
      expect(mkdirSpy).toHaveBeenCalledWith(expectedDir, { recursive: true });
      const shellCalls = runMock.mock.calls.filter((c) => (c[0] as string[]).includes("sh"));
      expect(shellCalls).toHaveLength(0);
      expect(transferRunMock.mock.calls.map((call) => call[0])).toEqual([
        {
          direction: "download",
          sandboxName: "alpha",
          target: { kind: "named", gatewayName: "gateway-alpha" },
          source: "/sandbox/.openclaw/agents/main/sessions/sid-a.jsonl",
          destination: expectedStagingSidA,
        },
        {
          direction: "download",
          sandboxName: "alpha",
          target: { kind: "named", gatewayName: "gateway-alpha" },
          source: "/sandbox/.openclaw/agents/main/sessions/sid-b.jsonl",
          destination: expectedStagingSidB,
        },
      ]);
      // Every downloaded session file is locked to owner-only while still staged
      // (the publish rename preserves the mode) — the bug observed in production
      // was inconsistent perms across files in the same export run, so both
      // files in this two-session fixture must see the chmod.
      expect(chmodSpy).toHaveBeenCalledWith(expectedStagingSidA, 0o600);
      expect(chmodSpy).toHaveBeenCalledWith(expectedStagingSidB, 0o600);
      // ...and both are published to their final paths after verification.
      expect(stagingRenameSpy).toHaveBeenCalledWith(expectedStagingSidA, expectedSidA);
      expect(stagingRenameSpy).toHaveBeenCalledWith(expectedStagingSidB, expectedSidB);
      expect(stagingRmSpy).toHaveBeenCalledWith(expectedStagingDir, {
        recursive: true,
        force: true,
      });

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
    } finally {
      mkdirSpy.mockRestore();
      chmodSpy.mockRestore();
    }
  });

  it("keeps continuous interruption coverage across a multi-file directory export and releases the final completion after lifecycle cleanup", async () => {
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
    const first = makeTransferCompletion();
    const second = makeTransferCompletion();
    transferRunMock.mockResolvedValueOnce(first).mockImplementationOnce(async () => {
      expect(first.release).not.toHaveBeenCalled();
      return second;
    });

    try {
      await exportSandboxSessions({ sandboxName: "alpha", out: "./sessions-alpha" });
      expect(first.release).toHaveBeenCalledOnce();
      expect(second.release).toHaveBeenCalledOnce();
    } finally {
      mkdirSpy.mockRestore();
      chmodSpy.mockRestore();
    }
  });

  it("does not start the next directory download after the retained transfer is interrupted", async () => {
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
    const first = makeTransferCompletion();
    vi.mocked(first.wasInterrupted).mockReturnValueOnce(false).mockReturnValue(true);
    transferRunMock.mockResolvedValueOnce(first);

    try {
      await expect(
        exportSandboxSessions({ sandboxName: "alpha", out: "./sessions-alpha" }),
      ).rejects.toThrow(/Failed to download.*\(exit null\)/);
      expect(transferRunMock).toHaveBeenCalledOnce();
      expect(first.release).toHaveBeenCalledOnce();
    } finally {
      mkdirSpy.mockRestore();
      chmodSpy.mockRestore();
    }
  });

  it("does not report success when the retained transfer is interrupted while the lifecycle lock settles", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:main:main", sessionId: "sid-a" }])),
    );
    let interrupted = false;
    const completion = makeTransferCompletion({ kind: "completed", exitCode: 0 });
    vi.mocked(completion.wasInterrupted).mockImplementation(() => interrupted);
    transferRunMock.mockResolvedValueOnce(completion);
    withLifecycleLockMock.mockImplementationOnce(async (_sandboxName, operation) => {
      const result = await operation();
      interrupted = true;
      return result;
    });

    await expect(
      exportSandboxSessions({ sandboxName: "alpha", out: "./out.tgz", format: "tar" }),
    ).rejects.toThrow(/Failed to download.*\(exit null\)/);
    expect(consoleErrorSpy.mock.calls.flat()).not.toContainEqual(
      expect.stringContaining("Exported"),
    );
    expect(completion.release).toHaveBeenCalledOnce();
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
    const command = shellCommand(tarCall);
    expect(command).toMatch(/-- \.\/sid-2\.jsonl \.\/sid-2\.trajectory\.jsonl/);
    expect(command).not.toMatch(/sid-1\.jsonl/);
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
    expect(shellCommand(tarCall)).toMatch(/sid-9\.jsonl/);
  });

  it("preserves OpenClaw export output when its agent id is hermes", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:hermes:main", sessionId: "sid-9" }])),
    );
    const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation(() => {});

    try {
      await exportSandboxSessions({
        sandboxName: "alpha",
        agent: "hermes",
        out: "./out.tgz",
        format: "tar",
      });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Exported all sessions for agent 'hermes' \(1 session\(s\)\)/),
      );
    } finally {
      chmodSpy.mockRestore();
    }
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

  it("cleans up the staging tarball after the host download succeeds and stays silent when the cleanup exits zero", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:main:main", sessionId: "sid-a" }])),
    );
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await exportSandboxSessions({
        sandboxName: "alpha",
        out: "./out.tgz",
        format: "tar",
      });
      const cleanupCall = runMock.mock.calls.at(-1);
      expect(cleanupCall?.[0]).toContain("rm");
      expect(cleanupCall?.[0]).toContain("-f");
      expect(cleanupCall?.[1]).toMatchObject({ ignoreError: true });
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("warns about a non-zero in-sandbox cleanup exit so a leftover sensitive tarball never disappears silently from the sandbox", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:main:main", sessionId: "sid-a" }])),
    );
    runMock.mockReturnValueOnce(makeRun(0)).mockReturnValueOnce(makeRun(2));
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await exportSandboxSessions({
        sandboxName: "alpha",
        out: "./out.tgz",
        format: "tar",
      });
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /failed to remove in-sandbox staging tarball '\/sandbox\/\.nemoclaw-staging\/[^']+'.*sandbox 'alpha'.*exit 2.*remove it manually with `[^`]+ sandbox exec -g gateway-alpha --name alpha -- rm -f \/sandbox\/\.nemoclaw-staging\/[^`]+`/,
        ),
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("keeps the selected-gateway cleanup command unchanged when no gateway is recorded", async () => {
    getKnownGatewayMock.mockReturnValue(null);
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:main:main", sessionId: "sid-a" }])),
    );
    runMock.mockReturnValueOnce(makeRun(0)).mockReturnValueOnce(makeRun(2));
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await exportSandboxSessions({
        sandboxName: "alpha",
        out: "./out.tgz",
        format: "tar",
      });
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /remove it manually with `[^`]+ sandbox exec --name alpha -- rm -f \/sandbox\/\.nemoclaw-staging\/[^`]+`/,
        ),
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  // Both the tar step and the cleanup can fail in the same run. The tar failure
  // is the primary rejection the caller must see; the cleanup warning is
  // additive and must still name the leftover artefact and how to remove it.
  it("keeps the tar failure as the primary rejection and still warns with the staging path, sandbox, exit status, and manual removal command when the cleanup also exits non-zero", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:main:main", sessionId: "sid-a" }])),
    );
    runMock.mockReturnValueOnce(makeRun(1)).mockReturnValueOnce(makeRun(3));
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await expect(
        exportSandboxSessions({
          sandboxName: "alpha",
          out: "./out.tgz",
          format: "tar",
        }),
      ).rejects.toThrow(/Failed to tar sessions/);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /failed to remove in-sandbox staging tarball '\/sandbox\/\.nemoclaw-staging\/[^']+'.*sandbox 'alpha'.*exit 3.*remove it manually with `[^`]+ sandbox exec -g gateway-alpha --name alpha -- rm -f \/sandbox\/\.nemoclaw-staging\/[^`]+`/,
        ),
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
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
    runMock.mockReturnValueOnce(makeRun(0));
    transferRunMock.mockResolvedValueOnce(
      makeTransferCompletion({ kind: "completed", exitCode: 1 }),
    );
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

  it("fails closed on a typed transfer failure and still cleans up the staging tarball", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:main:main", sessionId: "sid-a" }])),
    );
    const completion = makeTransferCompletion({ kind: "failed", reason: "invocation" });
    transferRunMock.mockResolvedValueOnce(completion);

    await expect(
      exportSandboxSessions({ sandboxName: "alpha", out: "./out.tgz", format: "tar" }),
    ).rejects.toThrow(/Failed to download.*\(exit null\)/);
    expect(runMock.mock.calls.at(-1)?.[0]).toContain("rm");
    expect(stagingRenameSpy).not.toHaveBeenCalled();
    expect(completion.release).toHaveBeenCalledOnce();
  });

  // #7367: `openshell sandbox download` can report success (exit 0) while
  // writing nothing (an upstream process-exit race). The export must not treat
  // that as a valid bundle, and must still clean up the in-sandbox staging file.
  it("aborts and cleans up when the host download reports success but writes no file (#7367)", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:main:main", sessionId: "sid-a" }])),
    );
    // The tar exec and typed transfer both report success...
    runMock.mockReturnValueOnce(makeRun(0));
    // ...but the host artifact never materialised.
    statSyncSpy.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    await expect(
      exportSandboxSessions({
        sandboxName: "alpha",
        out: "./out.tgz",
        format: "tar",
      }),
    ).rejects.toThrow(/reported success \(exit 0\) but no file was written/);
    const cleanupCall = runMock.mock.calls.at(-1);
    expect(cleanupCall?.[0]).toContain("rm");
    expect(cleanupCall?.[0]).toContain("-f");
    expect(cleanupCall?.[1]).toMatchObject({ ignoreError: true });
  });

  // #7367: a tar bundle is never legitimately empty (the zero-session case is
  // refused earlier), so an exit-0 download that produced an empty file is the
  // race, not a valid export — and cleanup must still run.
  it("aborts and cleans up when the host download reports success but writes an empty tar bundle (#7367)", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:main:main", sessionId: "sid-a" }])),
    );
    runMock.mockReturnValueOnce(makeRun(0));
    statSyncSpy.mockReturnValue({
      size: 0,
      isFile: () => true,
    } as unknown as ReturnType<typeof fs.statSync>);
    await expect(
      exportSandboxSessions({
        sandboxName: "alpha",
        out: "./out.tgz",
        format: "tar",
      }),
    ).rejects.toThrow(/reported success \(exit 0\) but wrote an empty file/);
    const cleanupCall = runMock.mock.calls.at(-1);
    expect(cleanupCall?.[0]).toContain("rm");
    expect(cleanupCall?.[0]).toContain("-f");
    expect(cleanupCall?.[1]).toMatchObject({ ignoreError: true });
  });

  // #7367: the per-file dir path must abort the export when a session download
  // reports success but wrote no file, rather than returning a partial export.
  it("aborts a dir export when a per-file download reports success but writes no file (#7367)", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:main:main", sessionId: "sid-a" }])),
    );
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    statSyncSpy.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    try {
      await expect(
        exportSandboxSessions({ sandboxName: "alpha", out: "./sessions-alpha" }),
      ).rejects.toThrow(/reported success \(exit 0\) but no file was written/);
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  // #7367 regression: the default destination is deterministic, so re-running
  // an export into the same directory is the normal workflow and stale files
  // from the previous run sit at the published paths. Verification must run
  // against the fresh staging path — a stale destination file must not turn an
  // exit-0/no-write download into a phantom success.
  it("rejects a dir export whose download wrote nothing even when a stale file from an earlier export sits at the destination (#7367)", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:main:main", sessionId: "sid-a" }])),
    );
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
    // Stale published paths stat fine; the fresh staging path does not exist
    // because the exit-0 download wrote nothing.
    statSyncSpy.mockImplementation((target: fs.PathLike) =>
      String(target).includes(".sessions-export-")
        ? throwEnoent()
        : ({ size: 42, isFile: () => true } as unknown as ReturnType<typeof fs.statSync>),
    );
    try {
      await expect(
        exportSandboxSessions({ sandboxName: "alpha", out: "./sessions-alpha" }),
      ).rejects.toThrow(/reported success \(exit 0\) but no file was written/);
      // Nothing may be published when verification fails.
      expect(stagingRenameSpy).not.toHaveBeenCalled();
    } finally {
      mkdirSpy.mockRestore();
    }
  });

  it("rejects a tar export whose download wrote nothing even when a stale bundle from an earlier export sits at the destination (#7367)", async () => {
    captureMock.mockReturnValueOnce(
      makeCapture(JSON.stringify([{ key: "agent:main:main", sessionId: "sid-a" }])),
    );
    statSyncSpy.mockImplementation((target: fs.PathLike) =>
      String(target).includes(".sessions-export-")
        ? throwEnoent()
        : ({ size: 42, isFile: () => true } as unknown as ReturnType<typeof fs.statSync>),
    );
    await expect(
      exportSandboxSessions({ sandboxName: "alpha", out: "./out.tgz", format: "tar" }),
    ).rejects.toThrow(/reported success \(exit 0\) but no file was written/);
    expect(stagingRenameSpy).not.toHaveBeenCalled();
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
    expect(execCall.slice(0, 7)).toEqual([
      "sandbox",
      "exec",
      "-g",
      "gateway-alpha",
      "--name",
      "alpha",
      "--",
    ]);
    const command = shellCommand(execCall);
    expect(command).toMatch(
      /^umask 077 && mkdir -p \/sandbox\/\.nemoclaw-staging && chmod 700 \/sandbox\/\.nemoclaw-staging && hermes sessions export \/sandbox\/\.nemoclaw-staging\/sessions-export-hermes-[0-9a-f]+\.jsonl && chmod 600 \/sandbox\/\.nemoclaw-staging\/sessions-export-hermes-[0-9a-f]+\.jsonl$/,
    );

    const downloadCall = transferRunMock.mock.calls[0]?.[0];
    expect(downloadCall).toMatchObject({
      direction: "download",
      sandboxName: "alpha",
      target: { kind: "named", gatewayName: "gateway-alpha" },
    });
    expect(downloadCall.source).toMatch(
      /^\/sandbox\/\.nemoclaw-staging\/sessions-export-hermes-[0-9a-f]+\.jsonl$/,
    );
    const hostStagingPath = downloadCall.destination as string;
    expect(hostStagingPath).toContain(".sessions-export-hermes-");
    expect(hostStagingPath.endsWith("sessions-alpha.jsonl")).toBe(true);
    expect(hostStagingPath).not.toBe("./sessions-alpha.jsonl");

    const cleanupCall = runMock.mock.calls.at(-1);
    expect(cleanupCall?.[0]).toEqual(
      expect.arrayContaining(["sandbox", "exec", "-g", "gateway-alpha", "rm", "-f"]),
    );
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

    const downloadCall = transferRunMock.mock.calls[0]?.[0];
    const hostStagingPath = downloadCall.destination as string;
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
    expect(execCall.slice(0, 5)).toEqual(["sandbox", "exec", "-g", "gateway-alpha", "--name"]);
    const cleanupCall = runMock.mock.calls[1]?.[0] as string[];
    expect(cleanupCall).toContain("rm");
    expect(cleanupCall).toContain("-f");
    expect(renameSpy).not.toHaveBeenCalled();
  });

  it("cleans up the in-sandbox staging file even when the host download exits non-zero", async () => {
    getSandboxMock.mockReturnValue({ name: "alpha", agent: "hermes" });
    runMock.mockReturnValueOnce(makeRun(0));
    transferRunMock.mockResolvedValueOnce(
      makeTransferCompletion({ kind: "completed", exitCode: 1 }),
    );

    await expect(exportSandboxSessions({ sandboxName: "alpha" })).rejects.toThrow(
      /Failed to download/,
    );
    const cleanupCall = runMock.mock.calls.at(-1);
    expect(cleanupCall?.[0]).toContain("rm");
    expect(cleanupCall?.[0]).toContain("-f");
    expect(renameSpy).not.toHaveBeenCalled();
  });

  // #7367: an exit-0 download that wrote no file must abort before the staging
  // file is renamed into place, and must still clean up the in-sandbox staging.
  it("aborts before rename and cleans up when the host download reports success but writes no file (#7367)", async () => {
    getSandboxMock.mockReturnValue({ name: "alpha", agent: "hermes" });
    runMock.mockReturnValueOnce(makeRun(0));
    statSyncSpy.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    await expect(exportSandboxSessions({ sandboxName: "alpha" })).rejects.toThrow(
      /reported success \(exit 0\) but no file was written/,
    );
    expect(renameSpy).not.toHaveBeenCalled();
    const cleanupCall = runMock.mock.calls.at(-1);
    expect(cleanupCall?.[0]).toContain("rm");
    expect(cleanupCall?.[0]).toContain("-f");
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
    const command = shellCommand(execCall);
    expect(command).toContain("hermes sessions export");
    expect(result.agent).toBe("hermes");
    expect(result.format).toBe("jsonl");
  });

  it("warns about a non-zero in-sandbox cleanup exit so a leftover sensitive JSONL never disappears silently from the sandbox", async () => {
    getSandboxMock.mockReturnValue({ name: "alpha", agent: "hermes" });
    runMock.mockReturnValueOnce(makeRun(0)).mockReturnValueOnce(makeRun(2));
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
