// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";
import { redactOnboardDiagnosticText } from "../../onboard/diagnostics/redaction";
import {
  PodmanExecutablePermissionError,
  type PodmanExecutableStat,
} from "../podman/executable-authority";
import { openshellNotFoundDiagnosticLines, resolveOpenshell } from "./resolve";
import {
  assertHermesPortableOpenShellExecutableAuthority,
  assertHermesPortableOpenShellExecutableFileAuthority,
  captureHermesPortableOpenShellExecutableAuthority,
  type HermesPortableOpenShellExecutableAuthorityDeps,
} from "./resolve-shared";

const AUTHORITY_BINARY = "/opt/nemoclaw/bin/openshell";

function executableAuthorityHarness() {
  let executableInode = 10n;
  let executableBytes = Buffer.from("openshell-binary");
  let parentInode = 20n;
  const stat = (kind: "directory" | "file", inode: bigint, size = 0n): PodmanExecutableStat => ({
    dev: 1n,
    ino: inode,
    mode: kind === "file" ? 0o100755n : 0o40755n,
    uid: kind === "file" ? 1000n : 0n,
    size,
    mtimeNs: 30n,
    ctimeNs: 40n,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => false,
  });
  const deps: HermesPortableOpenShellExecutableAuthorityDeps = {
    uid: 1000,
    realpath: (filePath) => filePath,
    readFile: () => executableBytes,
    lstat: (filePath) =>
      filePath === AUTHORITY_BINARY
        ? stat("file", executableInode, BigInt(executableBytes.byteLength))
        : stat("directory", filePath === "/opt/nemoclaw/bin" ? parentInode : 21n),
    resolve: (env) => env.NEMOCLAW_OPENSHELL_BIN ?? AUTHORITY_BINARY,
    runVersion: () => ({
      status: 0,
      stdout: "openshell 0.0.116\n",
      stderr: "",
    }),
  };
  return {
    deps,
    replaceBinary: () => {
      executableInode += 1n;
      executableBytes = Buffer.from("replacement-binary");
    },
    changeDigest: () => {
      executableBytes = Buffer.alloc(executableBytes.byteLength, 0x78);
    },
    rotateParent: () => {
      parentInode += 1n;
    },
  };
}

describe("lib/resolve-openshell", () => {
  it("returns command -v result when absolute path", () => {
    expect(resolveOpenshell({ commandVResult: "/usr/bin/openshell" })).toBe("/usr/bin/openshell");
  });

  it("prefers explicit installer override over command -v", () => {
    const previous = process.env.NEMOCLAW_OPENSHELL_BIN;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-bin-"));
    const override = path.join(tmp, "openshell");
    fs.writeFileSync(override, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    try {
      process.env.NEMOCLAW_OPENSHELL_BIN = override;
      expect(resolveOpenshell({ commandVResult: "/opt/homebrew/bin/openshell" })).toBe(override);
    } finally {
      if (previous === undefined) {
        delete process.env.NEMOCLAW_OPENSHELL_BIN;
      } else {
        process.env.NEMOCLAW_OPENSHELL_BIN = previous;
      }
    }
  });

  it("rejects non-absolute command -v result (alias)", () => {
    expect(
      resolveOpenshell({ commandVResult: "openshell", checkExecutable: () => false }),
    ).toBeNull();
  });

  it("rejects alias definition from command -v", () => {
    expect(
      resolveOpenshell({
        commandVResult: "alias openshell='echo pwned'",
        checkExecutable: () => false,
      }),
    ).toBeNull();
  });

  it("falls back to ~/.local/bin when command -v fails", () => {
    expect(
      resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) => p === "/fakehome/.local/bin/openshell",
        home: "/fakehome",
      }),
    ).toBe("/fakehome/.local/bin/openshell");
  });

  it("falls back to /usr/local/bin", () => {
    expect(
      resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) => p === "/usr/local/bin/openshell",
      }),
    ).toBe("/usr/local/bin/openshell");
  });

  it("falls back to the Apple Silicon Homebrew prefix at /opt/homebrew/bin (#5334)", () => {
    expect(
      resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) => p === "/opt/homebrew/bin/openshell",
      }),
    ).toBe("/opt/homebrew/bin/openshell");
  });

  it("prefers /opt/homebrew/bin over /usr/local/bin (#5334)", () => {
    expect(
      resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) =>
          p === "/opt/homebrew/bin/openshell" || p === "/usr/local/bin/openshell",
      }),
    ).toBe("/opt/homebrew/bin/openshell");
  });

  it("falls back to /usr/bin", () => {
    expect(
      resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) => p === "/usr/bin/openshell",
      }),
    ).toBe("/usr/bin/openshell");
  });

  it("prefers ~/.local/bin over /usr/local/bin", () => {
    expect(
      resolveOpenshell({
        commandVResult: null,
        checkExecutable: (p) =>
          p === "/fakehome/.local/bin/openshell" || p === "/usr/local/bin/openshell",
        home: "/fakehome",
      }),
    ).toBe("/fakehome/.local/bin/openshell");
  });

  it("returns null when openshell not found anywhere", () => {
    expect(
      resolveOpenshell({
        commandVResult: null,
        checkExecutable: () => false,
      }),
    ).toBeNull();
  });

  it("lists every fallback candidate when OpenShell is unavailable (#9805)", () => {
    expect(openshellNotFoundDiagnosticLines({ HOME: "/fakehome", PATH: "/usr/bin" })).toEqual(
      expect.arrayContaining([
        "    - /fakehome/.local/bin/openshell",
        "    - /opt/homebrew/bin/openshell",
        "    - /usr/local/bin/openshell",
        "    - /usr/bin/openshell",
      ]),
    );
  });

  it("skips home candidate when home is not absolute", () => {
    expect(
      resolveOpenshell({
        commandVResult: null,
        checkExecutable: () => false,
        home: "relative/path",
      }),
    ).toBeNull();
  });
});

describe("Hermes portable OpenShell executable authority", () => {
  const childEnv = { HOME: "/home/test", PATH: "/opt/nemoclaw/bin" };

  it.each(["/opt/nemoclaw/bin", AUTHORITY_BINARY])(
    "names the writable path %s and its permission remedy before execution (#11717)",
    (rejectedPath) => {
      const harness = executableAuthorityHarness();
      const runVersion = vi.fn(harness.deps.runVersion);
      let writable = true;
      const deps = {
        ...harness.deps,
        runVersion,
        lstat: (filePath: string): PodmanExecutableStat => {
          const stat = harness.deps.lstat?.(filePath);
          assert(stat, "Executable stat fixture is missing.");
          return filePath === rejectedPath && writable
            ? { ...stat, mode: BigInt(stat.mode) | 0o020n }
            : stat;
        },
      };
      const capture = () =>
        captureHermesPortableOpenShellExecutableAuthority(
          AUTHORITY_BINARY,
          childEnv,
          childEnv,
          deps,
        );

      expect(capture).toThrow(rejectedPath);
      expect(capture).toThrow("mode 0775");
      expect(capture).toThrow("Remove group and other write permission");
      expect(runVersion).not.toHaveBeenCalled();

      writable = false;
      expect(capture().executable.executablePath).toBe(AUTHORITY_BINARY);
      expect(runVersion).toHaveBeenCalledOnce();
    },
  );

  it("does not expose unrelated filesystem errors during capture (#11717)", () => {
    const harness = executableAuthorityHarness();
    expect(() =>
      captureHermesPortableOpenShellExecutableAuthority(AUTHORITY_BINARY, childEnv, childEnv, {
        ...harness.deps,
        lstat: () => {
          throw new Error("private filesystem failure detail");
        },
      }),
    ).toThrow(
      /^Hermes portable OpenShell executable authority could not capture a safe executable generation$/,
    );
  });

  it("escapes path controls and preserves onboarding diagnostic redaction (#11717)", () => {
    const secret = `nvapi-${"a".repeat(60)}`;
    const failure = new PodmanExecutablePermissionError(`/opt/${secret}/\u001b[31m/bin`, 0o40775n);
    expect(redactOnboardDiagnosticText(failure.message)).not.toContain(secret);
    expect(failure.message).not.toContain("\u001b");
    expect(failure.message).toContain("\\u001b");
    expect(failure.message).toContain("mode 0775");
  });

  it.each(["version", "file"])(
    "retains permission guidance during %s revalidation (#11717)",
    (kind) => {
      const harness = executableAuthorityHarness();
      const authority = captureHermesPortableOpenShellExecutableAuthority(
        AUTHORITY_BINARY,
        childEnv,
        childEnv,
        harness.deps,
      );
      const deps = {
        ...harness.deps,
        lstat: (filePath: string): PodmanExecutableStat => {
          const stat = harness.deps.lstat?.(filePath);
          assert(stat, "Executable stat fixture is missing.");
          return filePath === "/opt/nemoclaw/bin" ? { ...stat, mode: 0o40775n } : stat;
        },
      };
      const verify = () =>
        kind === "version"
          ? assertHermesPortableOpenShellExecutableAuthority(authority, childEnv, childEnv, deps)
          : assertHermesPortableOpenShellExecutableFileAuthority(authority, childEnv, deps);
      expect(verify).toThrow("executable generation changed after reservation");
      expect(verify).toThrow("Remove group and other write permission");
    },
  );

  it("captures and reuses the exact canonical OpenShell 0.0.116 generation (#9211)", () => {
    const harness = executableAuthorityHarness();
    const authority = captureHermesPortableOpenShellExecutableAuthority(
      AUTHORITY_BINARY,
      childEnv,
      childEnv,
      harness.deps,
    );

    expect(authority.version).toBe("0.0.116");
    expect(authority.executable.executablePath).toBe(AUTHORITY_BINARY);
    expect(
      assertHermesPortableOpenShellExecutableAuthority(authority, childEnv, childEnv, harness.deps),
    ).toBe(AUTHORITY_BINARY);
  });

  it("rejects PATH or explicit binary selection drift before reuse (#9203)", () => {
    const harness = executableAuthorityHarness();
    const authority = captureHermesPortableOpenShellExecutableAuthority(
      AUTHORITY_BINARY,
      childEnv,
      childEnv,
      harness.deps,
    );

    expect(() =>
      assertHermesPortableOpenShellExecutableAuthority(
        authority,
        childEnv,
        { ...childEnv, NEMOCLAW_OPENSHELL_BIN: "/tmp/other-openshell" },
        harness.deps,
      ),
    ).toThrow("disagrees with the current OpenShell resolution");
  });

  it("rejects binary replacement and parent rotation (#9203)", () => {
    const binaryHarness = executableAuthorityHarness();
    const binaryAuthority = captureHermesPortableOpenShellExecutableAuthority(
      AUTHORITY_BINARY,
      childEnv,
      childEnv,
      binaryHarness.deps,
    );
    binaryHarness.replaceBinary();
    expect(() =>
      assertHermesPortableOpenShellExecutableAuthority(
        binaryAuthority,
        childEnv,
        childEnv,
        binaryHarness.deps,
      ),
    ).toThrow("executable generation changed after reservation");

    const parentHarness = executableAuthorityHarness();
    const parentAuthority = captureHermesPortableOpenShellExecutableAuthority(
      AUTHORITY_BINARY,
      childEnv,
      childEnv,
      parentHarness.deps,
    );
    parentHarness.rotateParent();
    expect(() =>
      assertHermesPortableOpenShellExecutableAuthority(
        parentAuthority,
        childEnv,
        childEnv,
        parentHarness.deps,
      ),
    ).toThrow("executable generation changed after reservation");
  });

  it("rejects a same-generation content digest mismatch (#9203)", () => {
    const harness = executableAuthorityHarness();
    const authority = captureHermesPortableOpenShellExecutableAuthority(
      AUTHORITY_BINARY,
      childEnv,
      childEnv,
      harness.deps,
    );
    harness.changeDigest();

    expect(() =>
      assertHermesPortableOpenShellExecutableAuthority(authority, childEnv, childEnv, harness.deps),
    ).toThrow("executable generation changed after reservation");
  });

  it("rejects OpenShell 0.0.101 before authority capture or reuse (#9211)", () => {
    const harness = executableAuthorityHarness();
    expect(() =>
      captureHermesPortableOpenShellExecutableAuthority(AUTHORITY_BINARY, childEnv, childEnv, {
        ...harness.deps,
        runVersion: () => ({ status: 0, stdout: "openshell 0.0.101\n", stderr: "" }),
      }),
    ).toThrow("requires OpenShell 0.0.116");

    const reuseHarness = executableAuthorityHarness();
    const authority = captureHermesPortableOpenShellExecutableAuthority(
      AUTHORITY_BINARY,
      childEnv,
      childEnv,
      reuseHarness.deps,
    );
    expect(() =>
      assertHermesPortableOpenShellExecutableAuthority(authority, childEnv, childEnv, {
        ...reuseHarness.deps,
        runVersion: () => ({ status: 0, stdout: "openshell 0.0.101\n", stderr: "" }),
      }),
    ).toThrow("requires OpenShell 0.0.116");
  });
});
