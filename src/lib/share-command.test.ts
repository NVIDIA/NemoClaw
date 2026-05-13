// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawnSync: spawnSyncMock,
}));

import {
  defaultShareMountDir,
  isMountPoint,
  resolveLinuxUnmount,
  runShareMount,
  runShareStatus,
} from "./share-command";
import type { ShareCommandDeps } from "./share-command-deps";

function makeDeps(overrides: Partial<ShareCommandDeps> = {}): ShareCommandDeps {
  return {
    getSshConfig: vi.fn(() => ({
      status: 0,
      output: "Host openshell-alpha\n  HostName 127.0.0.1\n",
    })),
    ensureLive: vi.fn(async () => undefined),
    colorGreen: "",
    colorReset: "",
    cliName: "nemoclaw",
    ...overrides,
  };
}

function installExitThrow(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as never);
}

function mountedAt(dir: string): string {
  return `/dev/fuse on ${path.resolve(dir)} type fuse.sshfs (rw)\n`;
}

function withProcessPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform });
  try {
    fn();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

describe("share-command helpers", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds the default mount directory under ~/.nemoclaw/mounts", () => {
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = "/home/tester";
      expect(defaultShareMountDir("alpha")).toBe("/home/tester/.nemoclaw/mounts/alpha");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }
  });

  it("falls back to mount output when mountpoint is unavailable", () => {
    withProcessPlatform("linux", () => {
      const dir = "/tmp/nemoclaw-share-mounted";
      spawnSyncMock.mockImplementation((cmd: string) => {
        if (cmd === "mountpoint") return { status: 127 };
        if (cmd === "mount") return { status: 0, stdout: mountedAt(dir) };
        return { status: 1, stdout: "", stderr: "" };
      });

      expect(isMountPoint(dir)).toBe(true);
    });
  });

  it("trusts mountpoint -q status 1 as not mounted on Linux", () => {
    withProcessPlatform("linux", () => {
      spawnSyncMock.mockImplementation((cmd: string) => {
        if (cmd === "mountpoint") return { status: 1 };
        if (cmd === "mount") throw new Error("mount fallback should not run");
        return { status: 1, stdout: "", stderr: "" };
      });

      expect(isMountPoint("/tmp/nemoclaw-share-not-mounted")).toBe(false);
    });
  });

  it("prefers fusermount3 over fusermount on Linux", () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const script = args[1] as string;
      if (script.includes("fusermount3")) return { status: 0, stdout: "/usr/bin/fusermount3\n" };
      if (script.includes("fusermount")) return { status: 0, stdout: "/usr/bin/fusermount\n" };
      return { status: 1, stdout: "" };
    });

    expect(resolveLinuxUnmount()).toBe("/usr/bin/fusermount3");
  });

  it("falls back to fusermount when fusermount3 is unavailable", () => {
    spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
      const script = args[1] as string;
      if (script.includes("fusermount3")) return { status: 1, stdout: "" };
      if (script.includes("fusermount")) return { status: 0, stdout: "/bin/fusermount\n" };
      return { status: 1, stdout: "" };
    });

    expect(resolveLinuxUnmount()).toBe("/bin/fusermount");
  });
});

describe("ShareCommand mount/status actions", () => {
  let exitSpy: ReturnType<typeof installExitThrow>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    exitSpy = installExitThrow();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("mounts through sshfs with a private temporary ssh config and cleans it up", async () => {
    const deps = makeDeps();
    const localMount = fs.mkdtempSync(path.join(process.cwd(), ".tmp-share-mount-"));
    let sshfsConfigPath = "";
    try {
      spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "sh" && args[1] === "command -v sshfs") {
          return { status: 0, stdout: "/usr/bin/sshfs\n", stderr: "" };
        }
        if (cmd === "mountpoint") return { status: 1, stdout: "", stderr: "" };
        if (cmd === "mount") return { status: 0, stdout: "", stderr: "" };
        if (cmd === "sshfs") {
          const configFlagIndex = args.indexOf("-F");
          sshfsConfigPath = args[configFlagIndex + 1];
          expect(fs.statSync(sshfsConfigPath).mode & 0o777).toBe(0o600);
          expect(args).toContain("sftp_server=/usr/lib/openssh/sftp-server");
          expect(args).toContain("openshell-alpha:/workspace");
          expect(args.at(-1)).toBe(localMount);
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 1, stdout: "", stderr: `unexpected ${cmd} ${args.join(" ")}` };
      });

      await runShareMount({ sandboxName: "alpha", remotePath: "/workspace", localMount }, deps);

      expect(deps.ensureLive).toHaveBeenCalledWith("alpha");
      expect(deps.getSshConfig).toHaveBeenCalledWith("alpha");
      expect(spawnSyncMock).toHaveBeenCalledWith(
        "sshfs",
        expect.arrayContaining(["openshell-alpha:/workspace", localMount]),
        expect.objectContaining({ timeout: 30_000 }),
      );
      expect(sshfsConfigPath).not.toBe("");
      expect(fs.existsSync(sshfsConfigPath)).toBe(false);
      expect(fs.existsSync(path.dirname(sshfsConfigPath))).toBe(false);
      expect(
        logSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes("Mounted /workspace")),
      ).toBe(true);
    } finally {
      fs.rmSync(localMount, { recursive: true, force: true });
    }
  });

  it("exits with an install hint when sshfs is missing", async () => {
    const deps = makeDeps();
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "sh" && args[1] === "command -v sshfs") {
        return { status: 1, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });

    await expect(runShareMount({ sandboxName: "alpha" }, deps)).rejects.toThrow(
      "process.exit:1",
    );

    expect(deps.ensureLive).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n")).toContain(
      "sshfs is not installed",
    );
  });

  it("surfaces SFTP-specific remediation when sshfs fails after sandbox validation", async () => {
    const deps = makeDeps();
    const localMount = fs.mkdtempSync(path.join(process.cwd(), ".tmp-share-sftp-"));
    try {
      spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "sh" && args[1] === "command -v sshfs") return { status: 0, stdout: "sshfs\n" };
        if (cmd === "mountpoint") return { status: 1, stdout: "", stderr: "" };
        if (cmd === "mount") return { status: 0, stdout: "", stderr: "" };
        if (cmd === "sshfs")
          return { status: 1, stdout: "", stderr: "subsystem request failed: sftp" };
        return { status: 1, stdout: "", stderr: "" };
      });

      await expect(
        runShareMount({ sandboxName: "alpha", remotePath: "/sandbox", localMount }, deps),
      ).rejects.toThrow("process.exit:1");

      const stderr = errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
      expect(stderr).toContain("SSHFS mount failed");
      expect(stderr).toContain("openssh-sftp-server");
      expect(stderr).toContain("nemoclaw alpha rebuild --yes");
    } finally {
      fs.rmSync(localMount, { recursive: true, force: true });
    }
  });

  it("prints mounted status when the local mount point is active", () => {
    const mountDir = "/tmp/nemoclaw-share-status";
    spawnSyncMock.mockImplementation((cmd: string) => {
      if (cmd === "mountpoint") return { status: 0, stdout: "", stderr: "" };
      if (cmd === "mount") return { status: 0, stdout: mountedAt(mountDir), stderr: "" };
      return { status: 1, stdout: "", stderr: "" };
    });

    runShareStatus({ sandboxName: "alpha", localMount: mountDir }, makeDeps());

    expect(logSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n")).toContain(
      `Mounted at ${mountDir}`,
    );
  });
});
