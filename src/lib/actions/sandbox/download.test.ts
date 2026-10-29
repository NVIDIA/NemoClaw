// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./gateway-state", () => ({
  assertHermesPortableCommandUnavailable: vi.fn(),
  ensureLiveSandboxOrExit: vi.fn(async () => undefined),
  getKnownSandboxTargetGatewayName: () => null,
}));

const { runMock, captureMock } = vi.hoisted(() => ({ runMock: vi.fn(), captureMock: vi.fn() }));
vi.mock("../../adapters/openshell/sandbox-transfer-cli", () => ({
  createCliOpenShellSandboxTransferExecutor: () => ({ run: runMock }),
}));
vi.mock("../../adapters/openshell/sandbox-command-cli", () => ({
  createCliOpenShellSandboxCommandExecutor: () => ({ runBuffered: captureMock }),
}));

vi.mock("./sessions/download-verify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sessions/download-verify")>();
  return {
    ...actual,
    publishDownloadArtifact: vi.fn(),
  };
});

import {
  OPENSHELL_DOWNLOAD_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
} from "../../adapters/openshell/timeouts";
import { deferSandboxLifecycleExit } from "../../core/process-exit";
import { downloadFromSandbox, SandboxDownloadSourceMissingError } from "./download";
import { ensureLiveSandboxOrExit } from "./gateway-state";
import { publishDownloadArtifact } from "./sessions/download-verify";

const ensureMock = ensureLiveSandboxOrExit as unknown as ReturnType<typeof vi.fn>;
const publishMock = publishDownloadArtifact as unknown as ReturnType<typeof vi.fn>;
const stagingDir = path.join(process.cwd(), ".tmp-download-staging");
const stagedArtifact = path.join(stagingDir, "artifact");

beforeEach(() => {
  runMock.mockReset();
  runMock.mockResolvedValue({
    outcome: { kind: "completed", exitCode: 0 },
    release: vi.fn(),
    wasInterrupted: () => false,
  });
  captureMock.mockReset();
  // Default: the source probe reports a file that exists, so the artifact
  // verification treats the mocked download as complete. Individual tests
  // override the probe result or the filesystem to exercise the failure paths.
  captureMock.mockReturnValue({
    outcome: { kind: "completed", exitCode: 0 },
    stdout: "file",
    stderr: "",
  });
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
    expect(ensureMock).toHaveBeenCalledWith("alpha", {
      allowNonReadyPhase: true,
      exit: deferSandboxLifecycleExit,
    });
    expect(runMock).toHaveBeenCalledWith({
      direction: "download",
      sandboxName: "alpha",
      target: { kind: "selected" },
      source: "/sandbox/.openclaw/workspace/SOUL.md",
      destination: stagedArtifact,
    });
    expect(publishMock).toHaveBeenCalledWith(stagedArtifact, expectedHostDest, "file");
    expect(result).toEqual({
      sandboxPath: "/sandbox/.openclaw/workspace/SOUL.md",
      hostDest: expectedHostDest,
    });
    expect(fs.rmSync).toHaveBeenCalledWith(stagingDir, { recursive: true, force: true });
  });

  it("normalizes a leading-hyphen sandbox path before probing and download (#11378)", async () => {
    const result = await downloadFromSandbox({
      sandboxName: "alpha",
      sandboxPath: "-payload",
      hostDest: "./out",
    });

    // The probe runs before and after the download, and its script reads the
    // source as "$2", which is the final argv entry, so assert that position
    // rather than mere presence in the argument list.
    expect(captureMock).toHaveBeenCalledTimes(2);
    expect((captureMock.mock.calls[0]?.[0].command as string[]).at(-1)).toBe("./-payload");
    expect((captureMock.mock.calls[1]?.[0].command as string[]).at(-1)).toBe("./-payload");
    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: "download",
        sandboxName: "alpha",
        source: "./-payload",
        destination: stagedArtifact,
      }),
    );
    expect(result).toEqual({
      sandboxPath: "./-payload",
      hostDest: path.resolve(process.cwd(), "out"),
    });
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
    captureMock.mockReturnValue({
      outcome: { kind: "completed", exitCode: 0 },
      stdout: "file",
      stderr: "",
    });
    (fs.existsSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/etc/passwd", hostDest: "/tmp/p" }),
    ).rejects.toThrow(/reported success \(exit 0\) but nothing was written/);
    // The download was still attempted; verification is what caught it.
    expect(runMock).toHaveBeenCalled();
  });

  it("rejects a missing sandbox source before attempting the download (#7367)", async () => {
    captureMock.mockReturnValue({
      outcome: { kind: "completed", exitCode: 0 },
      stdout: "missing",
      stderr: "",
    });

    const error = await downloadFromSandbox({
      sandboxName: "alpha",
      sandboxPath: "/sandbox/nope",
      hostDest: "./o",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SandboxDownloadSourceMissingError);
    expect(error).toMatchObject({ exitCode: 2 });
    expect((error as Error).message).toMatch(/no such path in the sandbox/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported sandbox source before attempting the download (#7367)", async () => {
    captureMock.mockReturnValue({
      outcome: { kind: "completed", exitCode: 0 },
      stdout: "unsupported",
      stderr: "",
    });

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/fifo", hostDest: "./o" }),
    ).rejects.toThrow(/source is not a regular file or directory/);
    expect(runMock).not.toHaveBeenCalled();
  });

  // #10636: the root-type probe cleared a directory whose members were never
  // inspected, so a nested symbolic link travelled with the archive.
  it("rejects a directory source whose members are not files or directories (#10636)", async () => {
    captureMock.mockReturnValue({
      outcome: { kind: "completed", exitCode: 0 },
      stdout: "unsafe-member",
      stderr: "",
    });

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/mydir", hostDest: "./o" }),
    ).rejects.toThrow(/directory contains an entry that is not a regular file or directory/);
    expect(runMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "rejects a nested symbolic link in an expression-like directory before download (#10636)",
    async () => {
      const probeRoot = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "nemoclaw-download-probe-"),
      );
      try {
        const nestedDir = path.join(probeRoot, "-payload", "nested");
        const target = path.join(probeRoot, "target.txt");
        await fs.promises.mkdir(nestedDir, { recursive: true });
        await fs.promises.writeFile(target, "safe target");
        await fs.promises.symlink(target, path.join(nestedDir, "linked.txt"));

        captureMock.mockImplementation(({ command }: { command: string[] }) => {
          const probe = childProcess.spawnSync(command[0], command.slice(1), {
            cwd: probeRoot,
            encoding: "utf8",
          });
          return {
            outcome: { kind: "completed", exitCode: probe.status },
            stdout: probe.stdout,
            stderr: probe.stderr,
          };
        });

        await expect(
          downloadFromSandbox({
            sandboxName: "alpha",
            sandboxPath: "-payload",
            hostDest: "./o",
          }),
        ).rejects.toThrow(/directory contains an entry that is not a regular file or directory/);
        expect(runMock).not.toHaveBeenCalled();
        expect(publishMock).not.toHaveBeenCalled();
      } finally {
        await fs.promises.rm(probeRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a FIFO directory member before download (#10636)",
    async () => {
      const probeRoot = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "nemoclaw-download-fifo-probe-"),
      );
      try {
        const source = path.join(probeRoot, "payload");
        const fifo = path.join(source, "input");
        await fs.promises.mkdir(source);
        const created = childProcess.spawnSync("mkfifo", [fifo], {
          encoding: "utf8",
          timeout: 5_000,
        });
        expect(created.status, created.stderr).toBe(0);
        expect(fs.lstatSync(fifo).isFIFO()).toBe(true);

        captureMock.mockImplementation(({ command }: { command: string[] }) => {
          const probe = childProcess.spawnSync(command[0], command.slice(1), {
            cwd: probeRoot,
            encoding: "utf8",
          });
          return {
            outcome: { kind: "completed", exitCode: probe.status },
            stdout: probe.stdout,
            stderr: probe.stderr,
          };
        });

        await expect(
          downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "payload", hostDest: "./o" }),
        ).rejects.toThrow(/directory contains an entry that is not a regular file or directory/);
        expect(runMock).not.toHaveBeenCalled();
        expect(publishMock).not.toHaveBeenCalled();
      } finally {
        await fs.promises.rm(probeRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32").each(["linked/", "linked/.", "linked/nested"])(
    "rejects a source path with a link component written as %s before download (#10636)",
    async (sandboxPath) => {
      const probeRoot = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), "nemoclaw-download-root-link-probe-"),
      );
      try {
        const target = path.join(probeRoot, "target");
        await fs.promises.mkdir(path.join(target, "nested"), { recursive: true });
        await fs.promises.writeFile(path.join(target, "inside.txt"), "target contents");
        await fs.promises.symlink(target, path.join(probeRoot, "linked"));

        captureMock.mockImplementation(({ command }: { command: string[] }) => {
          const probe = childProcess.spawnSync(command[0], command.slice(1), {
            cwd: probeRoot,
            encoding: "utf8",
          });
          return {
            outcome: { kind: "completed", exitCode: probe.status },
            stdout: probe.stdout,
            stderr: probe.stderr,
          };
        });

        await expect(
          downloadFromSandbox({ sandboxName: "alpha", sandboxPath, hostDest: "./o" }),
        ).rejects.toThrow(/source is not a regular file or directory/);
        expect(runMock).not.toHaveBeenCalled();
        expect(publishMock).not.toHaveBeenCalled();
      } finally {
        await fs.promises.rm(probeRoot, { recursive: true, force: true });
      }
    },
  );

  it("passes a directory source through without requiring a regular file", async () => {
    captureMock.mockReturnValue({
      outcome: { kind: "completed", exitCode: 0 },
      stdout: "dir",
      stderr: "",
    });
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
      .mockReturnValueOnce({
        outcome: { kind: "completed", exitCode: 0 },
        stdout: "file",
        stderr: "",
      })
      .mockReturnValueOnce({
        outcome: { kind: "completed", exitCode: 0 },
        stdout: "unsupported",
        stderr: "",
      });

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/x", hostDest: "/tmp/p" }),
    ).rejects.toThrow(/source type changed or could not be revalidated after download/);
    expect(runMock).toHaveBeenCalled();
    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(publishMock).not.toHaveBeenCalled();
    expect(fs.rmSync).toHaveBeenCalledWith(stagingDir, { recursive: true, force: true });
  });

  it("rejects publication when a directory becomes unsafe during download (#10636)", async () => {
    captureMock
      .mockReturnValueOnce({
        outcome: { kind: "completed", exitCode: 0 },
        stdout: "dir",
        stderr: "",
      })
      .mockReturnValueOnce({
        outcome: { kind: "completed", exitCode: 0 },
        stdout: "unsafe-member",
        stderr: "",
      });

    await expect(
      downloadFromSandbox({
        sandboxName: "alpha",
        sandboxPath: "/sandbox/mydir",
        hostDest: "/tmp/p",
      }),
    ).rejects.toThrow(/source type changed or could not be revalidated after download/);
    expect(runMock).toHaveBeenCalledOnce();
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
    const probeArgs = captureMock.mock.calls[0]?.[0].command as string[];
    // The crafted path is a distinct argv element, never spliced into the script.
    expect(probeArgs.at(-1)).toBe("/sandbox/x; rm -rf /");
    expect(probeArgs.some((a) => a.includes("rm -rf /") && a.includes("if ["))).toBe(false);
  });

  it("rejects when the source probe cannot determine the kind (#7367)", async () => {
    captureMock.mockReturnValue({
      outcome: { kind: "completed", exitCode: 1 },
      stdout: "",
      stderr: "",
    });

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/x", hostDest: "/tmp/p" }),
    ).rejects.toThrow(/could not verify whether the source is a file or directory/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("rejects a timed-out source probe before download (#10636)", async () => {
    captureMock.mockReturnValue({
      outcome: {
        kind: "failed",
        error: { kind: "timeout", message: "OpenShell command timed out" },
      },
      stdout: "",
      stderr: "",
    });

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/x", hostDest: "/tmp/p" }),
    ).rejects.toThrow(/source verification timed out/);
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMilliseconds: OPENSHELL_PROBE_TIMEOUT_MS }),
    );
    expect(runMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("removes staged data when source revalidation times out (#10636)", async () => {
    captureMock
      .mockReturnValueOnce({
        outcome: { kind: "completed", exitCode: 0 },
        stdout: "file",
        stderr: "",
      })
      .mockReturnValueOnce({
        outcome: {
          kind: "failed",
          error: { kind: "timeout", message: "OpenShell command timed out" },
        },
        stdout: "",
        stderr: "",
      });

    await expect(
      downloadFromSandbox({ sandboxName: "alpha", sandboxPath: "/sandbox/x", hostDest: "/tmp/p" }),
    ).rejects.toThrow(/source verification timed out after download/);
    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(
      captureMock.mock.calls.every(
        (call) => call[0]?.timeoutMilliseconds === OPENSHELL_PROBE_TIMEOUT_MS,
      ),
    ).toBe(true);
    expect(runMock).toHaveBeenCalledOnce();
    expect(publishMock).not.toHaveBeenCalled();
    expect(fs.rmSync).toHaveBeenCalledWith(stagingDir, { recursive: true, force: true });
  });

  it("rejects a non-zero staged download and removes the staging directory", async () => {
    runMock.mockResolvedValue({
      outcome: { kind: "completed", exitCode: 7 },
      release: vi.fn(),
      wasInterrupted: () => false,
    });

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

  it("publishes an allowlisted credential-free recovery artifact when a legacy Shields record exists", async () => {
    vi.restoreAllMocks();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-download-legacy-shields-"));
    vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", root);
    let stagedDestination = "";
    try {
      fs.writeFileSync(path.join(root, "shields-alpha.json"), "{}\n");
      runMock.mockImplementation(async ({ destination }: { destination: string }) => {
        stagedDestination = destination;
        fs.writeFileSync(destination, "# Agent Workspace\n\nSafe workspace instructions.\n");
        return {
          outcome: { kind: "completed", exitCode: 0 },
          release: vi.fn(),
          wasInterrupted: () => false,
        };
      });
      const hostDest = path.join(root, "out");

      const result = await downloadFromSandbox({
        sandboxName: "alpha",
        sandboxPath: "/sandbox/.openclaw/workspace/SOUL.md",
        hostDest,
      });

      expect(runMock).toHaveBeenCalledWith({
        direction: "download",
        sandboxName: "alpha",
        target: { kind: "selected" },
        source: "/sandbox/.openclaw/workspace/SOUL.md",
        destination: stagedDestination,
        signal: expect.any(AbortSignal),
      });
      expect(publishMock).toHaveBeenCalledWith(stagedDestination, hostDest, "file");
      expect(result).toEqual({
        sandboxPath: "/sandbox/.openclaw/workspace/SOUL.md",
        hostDest,
      });
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects credential-bearing source paths and content when a legacy Shields record exists", async () => {
    vi.restoreAllMocks();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-download-legacy-shields-"));
    vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", root);
    try {
      fs.writeFileSync(path.join(root, "shields-alpha.json"), "{}\n");
      runMock.mockImplementation(async ({ destination }: { destination: string }) => {
        fs.writeFileSync(destination, `OPENAI_API_KEY=${"sk-" + "a".repeat(32)}\n`);
        return {
          outcome: { kind: "completed", exitCode: 0 },
          release: vi.fn(),
          wasInterrupted: () => false,
        };
      });

      await expect(
        downloadFromSandbox({
          sandboxName: "alpha",
          sandboxPath: "/sandbox/.openclaw/credentials/tokens.json",
          hostDest: path.join(root, "out"),
        }),
      ).rejects.toThrow(/mutable posture cannot be proven/u);
      expect(runMock).not.toHaveBeenCalled();

      await expect(
        downloadFromSandbox({
          sandboxName: "alpha",
          sandboxPath: "/sandbox/.openclaw/workspace/SOUL.md",
          hostDest: path.join(root, "out"),
        }),
      ).rejects.toThrow(/credential-bearing or uninspectable material/u);
      expect(publishMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "deadline",
      elapsedMs: OPENSHELL_DOWNLOAD_TIMEOUT_MS,
      expected: /recovery transfer timed out/u,
      prepare: (_destination: string) => undefined,
    },
    {
      name: "staged file growth",
      elapsedMs: 250,
      expected: /wrote a file larger than 16 MiB/u,
      prepare: (destination: string) => {
        fs.writeFileSync(destination, "");
        fs.truncateSync(destination, 16 * 1024 * 1024 + 1);
      },
    },
    {
      name: "staged directory entry overflow",
      elapsedMs: 250,
      expected: /recovery transfer could not be inspected/u,
      prepare: (destination: string) => {
        fs.mkdirSync(destination, { recursive: true });
        Array.from({ length: 4_097 }, (_, index) => {
          fs.writeFileSync(path.join(destination, `note-${index}.md`), "ok\n");
        });
      },
    },
  ])(
    "stops a legacy recovery transfer on $name and removes staging",
    async ({ elapsedMs, expected, prepare }) => {
      vi.restoreAllMocks();
      vi.useFakeTimers();
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-download-legacy-abort-"));
      vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", root);
      let started!: () => void;
      const transferStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      try {
        fs.writeFileSync(path.join(root, "shields-alpha.json"), "{}\n");
        runMock.mockImplementation(
          ({ destination, signal }: { destination: string; signal: AbortSignal }) => {
            prepare(destination);
            started();
            return new Promise((resolve) => {
              signal.addEventListener(
                "abort",
                () =>
                  resolve({
                    outcome: { kind: "failed", reason: "interrupted" },
                    release: vi.fn(),
                    wasInterrupted: () => true,
                  }),
                { once: true },
              );
            });
          },
        );
        const hostDest = path.join(root, "out");
        const pending = downloadFromSandbox({
          sandboxName: "alpha",
          sandboxPath: "/sandbox/.openclaw/workspace/SOUL.md",
          hostDest,
        });
        await transferStarted;
        await vi.advanceTimersByTimeAsync(elapsedMs);
        await expect(pending).rejects.toThrow(expected);
        expect(fs.existsSync(hostDest)).toBe(false);
        expect(publishMock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("accepts a legacy recovery directory with 4,096 entries and rejects 4,097 entries", async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-download-legacy-entry-limit-"));
    vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", root);
    try {
      fs.writeFileSync(path.join(root, "shields-alpha.json"), "{}\n");
      captureMock.mockReturnValue({
        outcome: { kind: "completed", exitCode: 0 },
        stdout: "dir",
        stderr: "",
      });
      let entryCount = 4_096;
      let stagedDestination = "";
      let started!: () => void;
      const transferStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      runMock.mockImplementation(({ destination }: { destination: string }) => {
        stagedDestination = destination;
        fs.mkdirSync(destination, { recursive: true });
        Array.from({ length: entryCount }, (_, index) => {
          fs.writeFileSync(path.join(destination, `note-${index}.md`), "safe note\n");
        });
        started();
        return new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                outcome: { kind: "completed", exitCode: 0 },
                release: vi.fn(),
                wasInterrupted: () => false,
              }),
            250,
          );
        });
      });

      const allowedHostDest = path.join(root, "out-allowed");
      const allowedDownload = downloadFromSandbox({
        sandboxName: "alpha",
        sandboxPath: "/sandbox/.openclaw/workspace/memory",
        hostDest: allowedHostDest,
      });
      await transferStarted;
      await vi.advanceTimersByTimeAsync(250);
      await expect(allowedDownload).resolves.toEqual({
        sandboxPath: "/sandbox/.openclaw/workspace/memory",
        hostDest: allowedHostDest,
      });
      expect(publishMock).toHaveBeenCalledWith(stagedDestination, allowedHostDest, "dir");

      publishMock.mockClear();
      entryCount = 4_097;
      runMock.mockImplementationOnce(async ({ destination }: { destination: string }) => {
        fs.mkdirSync(destination, { recursive: true });
        Array.from({ length: entryCount }, (_, index) => {
          fs.writeFileSync(path.join(destination, `note-${index}.md`), "safe note\n");
        });
        return {
          outcome: { kind: "completed", exitCode: 0 },
          release: vi.fn(),
          wasInterrupted: () => false,
        };
      });

      await expect(
        downloadFromSandbox({
          sandboxName: "alpha",
          sandboxPath: "/sandbox/.openclaw/workspace/memory",
          hostDest: path.join(root, "out-rejected"),
        }),
      ).rejects.toThrow(
        /Cannot download '\/sandbox\/\.openclaw\/workspace\/memory'.*directory depth or entry limit.*Do not destroy the sandbox/u,
      );
      expect(publishMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects an oversized allowlisted recovery file or directory before transfer when a legacy Shields record exists",
    async () => {
      vi.restoreAllMocks();
      const root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-download-legacy-oversized-")),
      );
      vi.stubEnv("NEMOCLAW_TEST_STATE_DIR", root);
      try {
        fs.writeFileSync(path.join(root, "shields-alpha.json"), "{}\n");
        const workspace = path.join(root, "sandbox/.openclaw/workspace");
        const memory = path.join(workspace, "memory");
        fs.mkdirSync(memory, { recursive: true });
        const soul = path.join(workspace, "SOUL.md");
        const noteA = path.join(memory, "a.md");
        const noteB = path.join(memory, "b.md");
        fs.writeFileSync(soul, "");
        fs.truncateSync(soul, 16 * 1024 * 1024 + 1);
        fs.writeFileSync(noteA, "");
        fs.truncateSync(noteA, 16 * 1024 * 1024 + 1);
        fs.writeFileSync(noteB, "");
        fs.truncateSync(noteB, 9 * 1024 * 1024);

        captureMock.mockImplementation(({ command }: { command: string[] }) => {
          const mapped = [...command.slice(0, -1), path.join(root, command.at(-1)!.slice(1))];
          const probe = childProcess.spawnSync(mapped[0]!, mapped.slice(1), {
            cwd: root,
            encoding: "utf8",
          });
          return {
            outcome: { kind: "completed", exitCode: probe.status },
            stdout: probe.stdout,
            stderr: probe.stderr,
          };
        });

        await expect(
          downloadFromSandbox({
            sandboxName: "alpha",
            sandboxPath: "/sandbox/.openclaw/workspace/SOUL.md",
            hostDest: path.join(root, "out-file"),
          }),
        ).rejects.toThrow(
          /Cannot download '\/sandbox\/\.openclaw\/workspace\/SOUL\.md'.*file larger than 16 MiB.*Do not destroy the sandbox/u,
        );
        await expect(
          downloadFromSandbox({
            sandboxName: "alpha",
            sandboxPath: "/sandbox/.openclaw/workspace/memory",
            hostDest: path.join(root, "out-dir"),
          }),
        ).rejects.toThrow(
          /Cannot download '\/sandbox\/\.openclaw\/workspace\/memory'.*file larger than 16 MiB.*Do not destroy the sandbox/u,
        );
        expect(runMock).not.toHaveBeenCalled();
        expect(publishMock).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
