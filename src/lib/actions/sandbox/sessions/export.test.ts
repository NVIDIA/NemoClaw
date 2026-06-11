// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../gateway-state", () => ({
  ensureLiveSandboxOrExit: vi.fn(async () => undefined),
}));

vi.mock("../../../adapters/openshell/runtime", () => ({
  captureOpenshell: vi.fn(),
  runOpenshell: vi.fn(),
}));

import { captureOpenshell, runOpenshell } from "../../../adapters/openshell/runtime";
import { buildSandboxTarArgv, exportSandboxSessions, parseSessionIndex } from "./export";

const captureMock = captureOpenshell as unknown as ReturnType<typeof vi.fn>;
const runMock = runOpenshell as unknown as ReturnType<typeof vi.fn>;

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  captureMock.mockReset();
  runMock.mockReset();
  runMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
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

describe("parseSessionIndex", () => {
  it("accepts a plain JSON array of entries", () => {
    const output = '[{"key":"agent:main:main","sessionId":"sid-1"}]';
    expect(parseSessionIndex(output)).toEqual([{ key: "agent:main:main", sessionId: "sid-1" }]);
  });

  it("accepts an object wrapper with a sessions array", () => {
    const output = '{"sessions":[{"key":"agent:main:main","sessionId":"sid-1"}]}';
    expect(parseSessionIndex(output)).toEqual([{ key: "agent:main:main", sessionId: "sid-1" }]);
  });

  it("treats id as an alias for sessionId", () => {
    const output = '[{"key":"agent:main:main","id":"sid-1"}]';
    expect(parseSessionIndex(output)).toEqual([{ key: "agent:main:main", sessionId: "sid-1" }]);
  });

  it("tolerates log noise preceding a single-line JSON payload", () => {
    const output = 'warning: deprecation\n[{"key":"agent:main:main","sessionId":"sid-1"}]';
    expect(parseSessionIndex(output)).toEqual([{ key: "agent:main:main", sessionId: "sid-1" }]);
  });

  it("returns [] when the upstream emits an empty index (empty array)", () => {
    expect(parseSessionIndex("[]")).toEqual([]);
  });

  it("returns [] when the upstream emits no output at all", () => {
    expect(parseSessionIndex("")).toEqual([]);
  });

  it("returns null when the output is non-empty but no JSON shape is recognised", () => {
    expect(parseSessionIndex("hello world")).toBeNull();
  });

  it("returns null when the array is non-empty but every entry uses unknown field names (schema drift)", () => {
    const output = JSON.stringify([{ alias: "agent:main:main", uuid: "sid-1" }]);
    expect(parseSessionIndex(output)).toBeNull();
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
    // must be locked down to owner-only, not just the in-sandbox staging copy.
    expect(chmodSpy).toHaveBeenCalledWith("./out.tgz", 0o600);
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
    expect(shellCommand).toMatch(/^umask 077 && tar -czf /);
    expect(shellCommand).toMatch(/-- \.\/sid-a\.jsonl \.\/sid-b\.jsonl/);
    expect(shellCommand).toMatch(/&& chmod 600 /);
    expect(shellCommand).not.toMatch(/sid-a\.trajectory\.jsonl/);

    const downloadCall = runMock.mock.calls[1]?.[0] as string[];
    expect(downloadCall.slice(0, 3)).toEqual(["sandbox", "download", "alpha"]);
    expect(downloadCall.at(-1)).toBe("./out.tgz");

    expect(result.selectedKeys).toBe("all");
    expect(result.resolvedSessionIds).toEqual(["sid-a", "sid-b"]);
    expect(result.resolvedFiles).toEqual(["sid-a.jsonl", "sid-b.jsonl"]);
    expect(result.hostDest).toBe("./out.tgz");
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
    // straight into the host directory.
    expect(mkdirSpy).toHaveBeenCalledWith("./sessions-alpha", { recursive: true });
    const shellCalls = runMock.mock.calls.filter((c) => (c[0] as string[]).includes("sh"));
    expect(shellCalls).toHaveLength(0);
    const downloadCalls = runMock.mock.calls.filter((c) => (c[0] as string[])[1] === "download");
    expect(downloadCalls).toHaveLength(2);
    expect(downloadCalls[0]?.[0]).toEqual([
      "sandbox",
      "download",
      "alpha",
      "/sandbox/.openclaw/agents/main/sessions/sid-a.jsonl",
      "sessions-alpha/sid-a.jsonl",
    ]);
    // Each downloaded file is locked to owner-only (session JSONL may hold secrets).
    expect(chmodSpy).toHaveBeenCalledWith("sessions-alpha/sid-a.jsonl", 0o600);

    expect(result.format).toBe("dir");
    expect(result.hostDest).toBe("./sessions-alpha");
    expect(result.bundleBytes).toBeNull();
    expect(result.sessions).toEqual([
      {
        key: "agent:main:main",
        sessionId: "sid-a",
        path: "sessions-alpha/sid-a.jsonl",
        sizeBytes: 42,
      },
      {
        key: "agent:main:telegram:t-1",
        sessionId: "sid-b",
        path: "sessions-alpha/sid-b.jsonl",
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
      hostDest: "./out.tgz",
    });
    expect(parsed).toHaveProperty("bundleBytes");
  });
});
