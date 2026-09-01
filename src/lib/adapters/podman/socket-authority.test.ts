// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assertPodmanSocketAuthority,
  capturePodmanSocketAuthority,
  hardenPodmanSocketDirectory,
} from "./socket-authority";

const SOCKET_PATH = "/run/user/1000/podman/podman.sock";

function stat(
  overrides: Partial<{
    dev: bigint;
    directory: boolean;
    ino: bigint;
    mode: bigint;
    socket: boolean;
    uid: bigint;
  }> = {},
) {
  return {
    dev: overrides.dev ?? 8n,
    ino: overrides.ino ?? 9001n,
    mode: overrides.mode ?? 0o600n,
    uid: overrides.uid ?? 1000n,
    isDirectory: () => overrides.directory ?? false,
    isSocket: () => overrides.socket ?? true,
  };
}

function secureLstat(
  socketOverrides: Parameters<typeof stat>[0] = {},
  directoryOverrides: Readonly<Record<string, Parameters<typeof stat>[0]>> = {},
) {
  const directoryInodes = new Map<string, bigint>();
  return (filePath: string) => {
    const directoryInode = directoryInodes.get(filePath) ?? BigInt(7000 + directoryInodes.size);
    directoryInodes.set(filePath, directoryInode);
    return filePath === SOCKET_PATH
      ? stat(socketOverrides)
      : stat({
          directory: true,
          ino: directoryInode,
          mode: 0o755n,
          uid: filePath.startsWith("/run/user/1000") ? 1000n : 0n,
          ...(directoryOverrides[filePath] ?? {}),
        });
  };
}

describe("Podman socket authority", () => {
  it("captures the exact current-user socket and secure path identity", () => {
    const authority = capturePodmanSocketAuthority(SOCKET_PATH, {
      lstat: vi.fn(secureLstat()),
      uid: 1000,
    });

    expect(authority).toMatchObject({
      device: "8",
      inode: "9001",
      mode: "384",
      ownerUid: "1000",
      socketPath: SOCKET_PATH,
    });
    expect(authority.directoryChain.map(({ ownerUid, path }) => ({ ownerUid, path }))).toEqual([
      { ownerUid: "1000", path: "/run/user/1000/podman" },
      { ownerUid: "1000", path: "/run/user/1000" },
      { ownerUid: "0", path: "/run/user" },
      { ownerUid: "0", path: "/run" },
      { ownerUid: "0", path: "/" },
    ]);
  });

  it("rejects foreign ownership and writable directory components", () => {
    expect(() =>
      capturePodmanSocketAuthority(SOCKET_PATH, {
        lstat: secureLstat({ uid: 2000n }),
        uid: 1000,
      }),
    ).toThrow("owned by uid 2000");
    expect(() =>
      capturePodmanSocketAuthority(SOCKET_PATH, {
        lstat: secureLstat({}, { "/run/user/1000/podman": { mode: 0o770n } }),
        uid: 1000,
      }),
    ).toThrow("writable by another user or group");
    expect(() =>
      capturePodmanSocketAuthority(SOCKET_PATH, {
        lstat: secureLstat({}, { "/run/user": { mode: 0o700n, uid: 2000n } }),
        uid: 1000,
      }),
    ).toThrow("expected root or current uid 1000");
  });

  it("accepts the rootless systemd socket mode inside a private current-user directory", () => {
    const authority = capturePodmanSocketAuthority(SOCKET_PATH, {
      lstat: secureLstat({ mode: 0o660n }, { "/run/user/1000/podman": { mode: 0o700n } }),
      uid: 1000,
    });

    expect(authority.mode).toBe(String(0o660));
  });

  it.runIf(process.platform !== "win32")(
    "hardens the current-user socket directory without following unsafe parents (#8584)",
    async () => {
      const root = fs.mkdtempSync(path.join(fs.realpathSync(process.cwd()), ".nc-p-"));
      const server = net.createServer();
      try {
        const socketDirectory = path.join(root, "p");
        fs.mkdirSync(socketDirectory);
        fs.chmodSync(socketDirectory, 0o755);
        const socketPath = path.join(socketDirectory, "s");
        const uid = process.getuid?.() ?? -1;
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });
        fs.chmodSync(socketPath, 0o660);

        hardenPodmanSocketDirectory(socketPath, uid);
        expect(fs.statSync(socketDirectory).mode & 0o777).toBe(0o700);

        fs.chmodSync(socketDirectory, 0o770);
        expect(() => hardenPodmanSocketDirectory(socketPath, uid)).toThrow(
          "writable by another user or group",
        );

        const targetDirectory = path.join(root, "target");
        const linkedDirectory = path.join(root, "linked");
        fs.mkdirSync(targetDirectory);
        fs.symlinkSync(targetDirectory, linkedDirectory, "dir");
        expect(() =>
          hardenPodmanSocketDirectory(path.join(linkedDirectory, "podman.sock"), uid),
        ).toThrow();

        const missingSocketDirectory = path.join(root, "missing");
        fs.mkdirSync(missingSocketDirectory, { mode: 0o755 });
        expect(() =>
          hardenPodmanSocketDirectory(path.join(missingSocketDirectory, "missing.sock"), uid),
        ).toThrow();
        expect(fs.statSync(missingSocketDirectory).mode & 0o777).toBe(0o755);

        fs.chmodSync(socketDirectory, 0o755);
        fs.chmodSync(socketPath, 0o666);
        expect(() => hardenPodmanSocketDirectory(socketPath, uid)).toThrow(
          "writable by another user or group",
        );
        expect(fs.statSync(socketDirectory).mode & 0o777).toBe(0o755);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
        fs.rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("rejects socket modes reachable by another user", () => {
    expect(() =>
      capturePodmanSocketAuthority(SOCKET_PATH, {
        lstat: secureLstat({ mode: 0o660n }),
        uid: 1000,
      }),
    ).toThrow("socket authority is writable by another user or group");

    expect(() =>
      capturePodmanSocketAuthority(SOCKET_PATH, {
        lstat: secureLstat({ mode: 0o666n }, { "/run/user/1000/podman": { mode: 0o700n } }),
        uid: 1000,
      }),
    ).toThrow("socket authority is writable by another user or group");
  });

  it("rejects socket and directory replacement after qualification", () => {
    const expected = capturePodmanSocketAuthority(SOCKET_PATH, {
      lstat: secureLstat(),
      uid: 1000,
    });

    expect(() =>
      assertPodmanSocketAuthority(expected, {
        lstat: secureLstat({ ino: 9002n }),
        uid: 1000,
      }),
    ).toThrow("changed after it was qualified");
    expect(() =>
      assertPodmanSocketAuthority(expected, {
        lstat: secureLstat({ mode: 0o400n }),
        uid: 1000,
      }),
    ).toThrow("changed after it was qualified");
    expect(() =>
      assertPodmanSocketAuthority(expected, {
        lstat: secureLstat({}, { "/run/user/1000/podman": { ino: 8000n } }),
        uid: 1000,
      }),
    ).toThrow("changed after it was qualified");
  });

  it("rejects relative, non-socket, and foreign-directory authorities", () => {
    expect(() => capturePodmanSocketAuthority("relative.sock", { uid: 1000 })).toThrow(
      "normalized absolute path",
    );
    expect(() =>
      capturePodmanSocketAuthority(SOCKET_PATH, {
        lstat: secureLstat({ socket: false }),
        uid: 1000,
      }),
    ).toThrow("not a Unix socket");
    expect(() =>
      capturePodmanSocketAuthority(SOCKET_PATH, {
        lstat: secureLstat({}, { "/run/user/1000/podman": { uid: 2000n } }),
        uid: 1000,
      }),
    ).toThrow("expected current uid 1000");
  });
});
