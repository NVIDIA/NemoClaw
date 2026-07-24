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

import { captureOpenshell, runOpenshell } from "../../adapters/openshell/runtime";
import { downloadFromSandbox } from "./download";
import { ensureLiveSandboxOrExit } from "./gateway-state";

const runMock = runOpenshell as unknown as ReturnType<typeof vi.fn>;
const captureMock = captureOpenshell as unknown as ReturnType<typeof vi.fn>;
const ensureMock = ensureLiveSandboxOrExit as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  runMock.mockReset();
  captureMock.mockReset();
  // Default: the source probe reports a file that exists, so the artifact
  // verification treats the mocked download as complete. Individual tests
  // override the probe result or the filesystem to exercise the failure paths.
  captureMock.mockReturnValue({ status: 0, output: "file" });
  ensureMock.mockClear();
  vi.spyOn(fs, "existsSync").mockReturnValue(true);
  vi.spyOn(fs, "statSync").mockReturnValue({
    isDirectory: () => false,
  } as unknown as ReturnType<typeof fs.statSync>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("downloadFromSandbox", () => {
  it("resolves a relative host destination against the caller cwd before forwarding to openshell", async () => {
    const result = await downloadFromSandbox({
      sandboxName: "alpha",
      sandboxPath: "/sandbox/.openclaw/workspace/SOUL.md",
      hostDest: "./out",
    });

    const expectedHostDest = path.resolve(process.cwd(), "out");
    expect(ensureMock).toHaveBeenCalledWith("alpha", { allowNonReadyPhase: true });
    expect(runMock).toHaveBeenCalledWith(
      ["sandbox", "download", "alpha", "/sandbox/.openclaw/workspace/SOUL.md", expectedHostDest],
      expect.objectContaining({ stdio: "inherit" }),
    );
    expect(result).toEqual({
      sandboxPath: "/sandbox/.openclaw/workspace/SOUL.md",
      hostDest: expectedHostDest,
    });
  });

  it("defaults the host destination to the caller cwd when omitted", async () => {
    await downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/x" });
    const args = runMock.mock.calls[0]?.[0];
    expect(args?.at(-1)).toBe(process.cwd());
  });

  it("forwards an absolute host destination unchanged", async () => {
    await downloadFromSandbox({
      sandboxName: "alpha",
      sandboxPath: "/sandbox/x",
      hostDest: "/tmp/dl-default",
    });
    const args = runMock.mock.calls[0]?.[0];
    expect(args?.at(-1)).toBe("/tmp/dl-default");
  });

  it("preserves a trailing separator on a relative directory destination", async () => {
    await downloadFromSandbox({
      sandboxName: "alpha",
      sandboxPath: "/sandbox/x",
      hostDest: "./out/",
    });
    const args = runMock.mock.calls[0]?.[0];
    const hostDest = args?.at(-1) as string;
    expect(hostDest.endsWith(path.sep) || hostDest.endsWith("/")).toBe(true);
    expect(hostDest.slice(0, -1)).toBe(path.resolve(process.cwd(), "out"));
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

  it("passes a directory source through without requiring a regular file", async () => {
    captureMock.mockReturnValue({ status: 0, output: "dir" });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/mydir", hostDest: "./o" }),
    ).resolves.toMatchObject({ sandboxPath: "/sandbox/mydir" });
    expect(runMock).toHaveBeenCalled();
  });

  it("warns instead of silently passing when the destination pre-existed (#7367)", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // beforeEach existsSync=true: the resolved artifact exists before the
    // download runs, so existence-after proves nothing about this transfer.
    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/x", hostDest: "/tmp/p" }),
    ).resolves.toMatchObject({ sandboxPath: "/sandbox/x" });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/cannot confirm the download wrote '.*': the path existed before/),
    );
  });

  it("verifies a fresh destination without warning when the artifact appears (#7367)", async () => {
    const warnSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Call order: dest directory-ness in resolveDownloadArtifactPath, the
    // pre-existence snapshot (absent), then the post-download check (present).
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/x", hostDest: "/tmp/p" }),
    ).resolves.toMatchObject({ sandboxPath: "/sandbox/x" });
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringMatching(/cannot confirm/));
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

  it("skips verification when the source probe cannot determine the kind", async () => {
    captureMock.mockReturnValue({ status: 1, output: "" });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);

    // Probe inconclusive -> fall back to openshell's own exit handling; the
    // command must not throw a spurious verification error.
    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/x", hostDest: "/tmp/p" }),
    ).resolves.toMatchObject({ sandboxPath: "/sandbox/x" });
    expect(runMock).toHaveBeenCalled();
  });
});
