// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./gateway-state", () => ({
  ensureLiveSandboxOrExit: vi.fn(async () => undefined),
}));

vi.mock("../../adapters/openshell/runtime", () => ({
  runOpenshell: vi.fn(),
  captureOpenshell: vi.fn(),
}));

vi.mock("./sessions/download-verify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sessions/download-verify")>();
  return {
    ...actual,
    publishDownloadArtifact: vi.fn(),
  };
});

import { captureOpenshell, runOpenshell } from "../../adapters/openshell/runtime";
import { downloadFromSandbox } from "./download";
import { ensureLiveSandboxOrExit } from "./gateway-state";
import { publishDownloadArtifact } from "./sessions/download-verify";

const runMock = runOpenshell as unknown as ReturnType<typeof vi.fn>;
const captureMock = captureOpenshell as unknown as ReturnType<typeof vi.fn>;
const ensureMock = ensureLiveSandboxOrExit as unknown as ReturnType<typeof vi.fn>;
const publishMock = publishDownloadArtifact as unknown as ReturnType<typeof vi.fn>;
const stagingDir = path.join(process.cwd(), ".tmp-download-staging");
const stagedArtifact = path.join(stagingDir, "artifact");

beforeEach(() => {
  runMock.mockReset();
  runMock.mockReturnValue({ status: 0 });
  captureMock.mockReset();
  // Default: the source probe reports a file that exists, so the artifact
  // verification treats the mocked download as complete. Individual tests
  // override the probe result or the filesystem to exercise the failure paths.
  captureMock.mockReturnValue({ status: 0, output: "file" });
  ensureMock.mockClear();
  publishMock.mockReset();
  vi.spyOn(fs, "existsSync").mockReturnValue(true);
  vi.spyOn(fs, "statSync").mockReturnValue({
    isDirectory: () => false,
  } as unknown as ReturnType<typeof fs.statSync>);
  vi.spyOn(fs, "mkdtempSync").mockReturnValue(stagingDir);
  vi.spyOn(fs, "rmSync").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("downloadFromSandbox", () => {
  it("publishes a staged file to a relative host destination from the caller cwd", async () => {
    const result = await downloadFromSandbox({
      sandboxName: "alpha",
      sandboxPath: "/sandbox/.openclaw/workspace/SOUL.md",
      hostDest: "./out",
    });

    const expectedHostDest = path.resolve(process.cwd(), "out");
    expect(ensureMock).toHaveBeenCalledWith("alpha", { allowNonReadyPhase: true });
    expect(runMock).toHaveBeenCalledWith(
      ["sandbox", "download", "alpha", "/sandbox/.openclaw/workspace/SOUL.md", stagedArtifact],
      expect.objectContaining({ ignoreError: true, stdio: "inherit" }),
    );
    expect(publishMock).toHaveBeenCalledWith(stagedArtifact, expectedHostDest, "file");
    expect(result).toEqual({
      sandboxPath: "/sandbox/.openclaw/workspace/SOUL.md",
      hostDest: expectedHostDest,
    });
    expect(fs.rmSync).toHaveBeenCalledWith(stagingDir, { recursive: true, force: true });
  });

  it("defaults the host destination to the caller cwd when omitted", async () => {
    (fs.statSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      isDirectory: () => true,
    });
    await downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/x" });
    expect(publishMock).toHaveBeenCalledWith(stagedArtifact, path.join(process.cwd(), "x"), "file");
  });

  it("publishes to an absolute host destination unchanged", async () => {
    await downloadFromSandbox({
      sandboxName: "alpha",
      sandboxPath: "/sandbox/x",
      hostDest: "/tmp/dl-default",
    });
    expect(publishMock).toHaveBeenCalledWith(stagedArtifact, "/tmp/dl-default", "file");
  });

  it("preserves a trailing separator on a relative directory destination", async () => {
    await downloadFromSandbox({
      sandboxName: "alpha",
      sandboxPath: "/sandbox/x",
      hostDest: "./out/",
    });
    const hostDest = `${path.resolve(process.cwd(), "out")}${path.sep}`;
    const publishArgs = publishMock.mock.calls[0];
    const publishedPath = publishArgs?.[1] as string;
    expect(hostDest.endsWith(path.sep) || hostDest.endsWith("/")).toBe(true);
    expect(publishedPath).toBe(path.join(hostDest, "x"));
  });

  it("throws (does not exit) when no sandbox path is given", async () => {
    await expect(downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "" })).rejects.toThrow(
      /No sandbox path provided/,
    );
    expect(ensureMock).not.toHaveBeenCalled();
    expect(runMock).not.toHaveBeenCalled();
  });

  // #7367: `openshell sandbox download` can report success (exit 0) while
  // writing nothing (a rejected out-of-workspace source; upstream race). The
  // command must surface that instead of returning a phantom success.
  it("throws when the download reports success but no artifact landed (#7367)", async () => {
    captureMock.mockReturnValue({ status: 0, output: "file" });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/etc/passwd", hostDest: "/tmp/p" }),
    ).rejects.toThrow(/reported success \(exit 0\) but nothing was written/);
    // The download was still attempted; verification is what caught it.
    expect(runMock).toHaveBeenCalled();
  });

  it("rejects a missing sandbox source before attempting the download (#7367)", async () => {
    captureMock.mockReturnValue({ status: 0, output: "missing" });

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/nope", hostDest: "./o" }),
    ).rejects.toThrow(/no such path in the sandbox/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported sandbox source before attempting the download (#7367)", async () => {
    captureMock.mockReturnValue({ status: 0, output: "unsupported" });

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/fifo", hostDest: "./o" }),
    ).rejects.toThrow(/source is not a regular file or directory/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("passes a directory source through without requiring a regular file", async () => {
    captureMock.mockReturnValue({ status: 0, output: "dir" });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/mydir", hostDest: "./o" }),
    ).resolves.toMatchObject({ sandboxPath: "/sandbox/mydir" });
    expect(runMock).toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalledWith(
      stagedArtifact,
      path.resolve(process.cwd(), "o"),
      "dir",
    );
  });

  it("publishes over a pre-existing destination only after staged verification (#7367)", async () => {
    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/x", hostDest: "/tmp/p" }),
    ).resolves.toMatchObject({ sandboxPath: "/sandbox/x" });
    expect(publishMock).toHaveBeenCalledWith(stagedArtifact, "/tmp/p", "file");
  });

  it("publishes a fresh staged artifact to a fresh destination (#7367)", async () => {
    // Call order: destination directory check, then staged artifact check.
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/x", hostDest: "/tmp/p" }),
    ).resolves.toMatchObject({ sandboxPath: "/sandbox/x" });
    expect(publishMock).toHaveBeenCalledWith(stagedArtifact, "/tmp/p", "file");
  });

  it("rejects publication when a regular source becomes a symbolic link during download", async () => {
    captureMock
      .mockReturnValueOnce({ status: 0, output: "file" })
      .mockReturnValueOnce({ status: 0, output: "unsupported" });

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/x", hostDest: "/tmp/p" }),
    ).rejects.toThrow(/source type changed or could not be revalidated after download/);
    expect(runMock).toHaveBeenCalled();
    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(publishMock).not.toHaveBeenCalled();
    expect(fs.rmSync).toHaveBeenCalledWith(stagingDir, { recursive: true, force: true });
  });

  it("passes the source path as a positional arg to the probe (no shell interpolation)", async () => {
    await downloadFromSandbox({
      sandboxName: "alpha",
      sandboxPath: "/sandbox/x; rm -rf /",
      hostDest: "/tmp/p",
    });
    const probeArgs = captureMock.mock.calls[0]?.[0] as string[];
    // The crafted path is a distinct argv element, never spliced into the script.
    expect(probeArgs.at(-1)).toBe("/sandbox/x; rm -rf /");
    expect(probeArgs.some((a) => a.includes("rm -rf /") && a.includes("if ["))).toBe(false);
  });

  it("rejects when the source probe cannot determine the kind (#7367)", async () => {
    captureMock.mockReturnValue({ status: 1, output: "" });

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/x", hostDest: "/tmp/p" }),
    ).rejects.toThrow(/could not verify whether the source is a file or directory/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("rejects a non-zero staged download and removes the staging directory", async () => {
    runMock.mockReturnValue({ status: 7 });

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/x", hostDest: "/tmp/p" }),
    ).rejects.toThrow(/Failed to download.*\(exit 7\)/);
    expect(publishMock).not.toHaveBeenCalled();
    expect(fs.rmSync).toHaveBeenCalledWith(stagingDir, { recursive: true, force: true });
  });

  it("removes the staging directory when exit 0 produces no artifact (#7367)", async () => {
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/x", hostDest: "/tmp/p" }),
    ).rejects.toThrow(/reported success \(exit 0\) but nothing was written/);
    expect(publishMock).not.toHaveBeenCalled();
    expect(fs.rmSync).toHaveBeenCalledWith(stagingDir, { recursive: true, force: true });
  });

  it("removes the staging directory when verified artifact publication fails", async () => {
    publishMock.mockImplementationOnce(() => {
      throw new Error("publication failed");
    });

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/x", hostDest: "/tmp/p" }),
    ).rejects.toThrow(/publication failed/);
    expect(publishMock).toHaveBeenCalledWith(stagedArtifact, "/tmp/p", "file");
    expect(fs.rmSync).toHaveBeenCalledWith(stagingDir, { recursive: true, force: true });
  });
});
