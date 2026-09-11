// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { HermesPortableOpenShellExecutableAuthority } from "../../adapters/openshell/resolve-shared";
import type { PodmanExecutableAuthorityDeps, PodmanExecutableStat } from "../../adapters/podman";
import type { HermesPortablePodmanExecutableAuthority } from "./hermes-portable-podman-authority";

const PODMAN_BYTES = Buffer.from("podman-5.7.0-test", "utf8");

export function testOpenShellExecutableAuthority(): HermesPortableOpenShellExecutableAuthority {
  return {
    version: "0.0.116",
    executable: {
      executablePath: "/usr/bin/openshell",
      device: "1",
      inode: "10",
      mode: String(0o100755),
      ownerUid: "0",
      size: "1024",
      modifiedTimeNanoseconds: "11",
      changedTimeNanoseconds: "12",
      sha256: "f".repeat(64),
      directoryChain: ["/usr/bin", "/usr", "/"].map((directory, index) => ({
        device: "1",
        inode: String(index + 20),
        mode: String(0o40755),
        ownerUid: "0",
        path: directory,
      })),
    },
  };
}

export function testPodmanExecutableAuthority(): HermesPortablePodmanExecutableAuthority {
  return {
    version: "5.7.0",
    executable: {
      executablePath: "/usr/bin/podman",
      device: "1",
      inode: "30",
      mode: String(0o100755),
      ownerUid: "0",
      size: String(PODMAN_BYTES.byteLength),
      modifiedTimeNanoseconds: "31",
      changedTimeNanoseconds: "32",
      sha256: createHash("sha256").update(PODMAN_BYTES).digest("hex"),
      directoryChain: ["/usr/bin", "/usr", "/"].map((directory, index) => ({
        device: "1",
        inode: String(index + 40),
        mode: String(0o40755),
        ownerUid: "0",
        path: directory,
      })),
    },
  };
}

export function testPodmanExecutableAuthorityDeps(): PodmanExecutableAuthorityDeps {
  const stat = (filePath: string): PodmanExecutableStat => ({
    dev: 1n,
    ino:
      filePath === "/usr/bin/podman"
        ? 30n
        : filePath === "/usr/bin"
          ? 40n
          : filePath === "/usr"
            ? 41n
            : 42n,
    mode: filePath === "/usr/bin/podman" ? 0o100755n : 0o40755n,
    uid: 0n,
    size: filePath === "/usr/bin/podman" ? BigInt(PODMAN_BYTES.byteLength) : 0n,
    mtimeNs: 31n,
    ctimeNs: 32n,
    isDirectory: () => filePath !== "/usr/bin/podman",
    isFile: () => filePath === "/usr/bin/podman",
    isSymbolicLink: () => false,
  });
  return {
    uid: process.getuid!(),
    lstat: stat,
    readFile: () => PODMAN_BYTES,
    realpath: (filePath) => filePath,
  };
}
