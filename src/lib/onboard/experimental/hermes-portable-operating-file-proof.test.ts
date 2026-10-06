// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  capturePodmanExecutableAuthority,
  type PodmanExecutableAuthorityDeps,
} from "../../adapters/podman";
import { createHermesPortableOperatingFileProof } from "./hermes-portable-operating-file-proof";

function fixture() {
  const contents = Buffer.from("qualified-executable");
  const state = { inode: 2n, ctime: 3n, mode: 0o100755n, directoryInode: 4n, bytes: contents };
  const readFile = vi.fn(() => state.bytes);
  const deps: PodmanExecutableAuthorityDeps = {
    uid: 1000,
    realpath: (file) => file,
    readFile,
    lstat: (file) => {
      const executable = file === "/usr/bin/podman" || file === "/usr/bin/openshell";
      return {
        dev: 1n,
        ino: executable ? state.inode : state.directoryInode,
        mode: executable ? state.mode : 0o40755n,
        uid: 0n,
        size: executable ? BigInt(contents.length) : 0n,
        mtimeNs: 2n,
        ctimeNs: executable ? state.ctime : 1n,
        isDirectory: () => !executable,
        isFile: () => executable,
        isSymbolicLink: () => false,
      };
    },
  };
  const receipt = {
    runtimeAuthority: {
      schemaVersion: 1 as const,
      kind: "podman" as const,
      ownership: "current-user" as const,
      uid: 1000,
      homeDir: "/home/test",
      configHome: "/home/test/.config",
      runtimeDir: "/run/user/1000",
      socketPath: "/run/user/1000/podman/podman.sock",
    },
    openshellExecutableAuthority: {
      version: "0.0.116" as const,
      executable: capturePodmanExecutableAuthority("/usr/bin/openshell", deps),
    },
    podmanExecutableAuthority: {
      version: "5.7.0" as const,
      executable: capturePodmanExecutableAuthority("/usr/bin/podman", deps),
    },
  };
  const env: NodeJS.ProcessEnv = { HOME: "/home/test" };
  const resolveOpenShell = vi.fn((): string | null => "/usr/bin/openshell");
  const resolvePodman = vi.fn(() => "/usr/bin/podman");
  const assertCurrent = createHermesPortableOperatingFileProof(receipt, env, {
    openshell: deps,
    podman: deps,
    resolveOpenShell,
    resolvePodman,
  });
  readFile.mockClear();
  return { state, readFile, env, resolveOpenShell, resolvePodman, assertCurrent };
}

describe("Portable retained executable proofs", () => {
  it("reuses verified bytes across repeated authority checkpoints (#11574)", () => {
    const f = fixture();
    f.assertCurrent();
    f.assertCurrent();
    expect(f.readFile).not.toHaveBeenCalled();
  });

  it("rehashes both retained executables at the shared checkpoint interval (#11574)", () => {
    const f = fixture();
    Array.from({ length: 63 }, () => f.assertCurrent());
    expect(f.readFile).not.toHaveBeenCalled();
    f.assertCurrent();
    expect(f.readFile).toHaveBeenCalledTimes(2);
  });

  it.each(["inode", "ctime", "directoryInode"] as const)(
    "rejects and latches %s changes even if the original identity returns (#11574)",
    (field) => {
      const f = fixture();
      const original = f.state[field];
      f.state[field] += 1n;
      expect(f.assertCurrent).toThrow("changed after it was qualified");
      f.state[field] = original;
      expect(f.assertCurrent).toThrow("changed after it was qualified");
    },
  );

  it.each(["resolveOpenShell", "resolvePodman"] as const)(
    "rejects a changed %s selection (#11574)",
    (field) => {
      const f = fixture();
      f[field].mockReturnValue("/usr/bin/replacement");
      expect(f.assertCurrent).toThrow(/resolution/u);
    },
  );

  it("rejects an OpenShell selection that disappeared (#11574)", () => {
    const f = fixture();
    f.resolveOpenShell.mockReturnValue(null);
    expect(f.assertCurrent).toThrow(/resolution/u);
  });

  it.each(["HOME", "CONTAINER_HOST"])("rejects conflicting %s authority (#11574)", (field) => {
    const f = fixture();
    f.env[field] = "unexpected";
    expect(f.assertCurrent).toThrow(/disagrees|selector is not allowed/u);
  });
});
