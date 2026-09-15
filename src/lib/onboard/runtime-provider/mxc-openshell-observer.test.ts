// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createMxcOpenShellStableFileOperations,
  observeMxcOpenShellAttachment,
  readStableMxcOpenShellFileSha256,
  type MxcOpenShellAttachmentObservationRequest,
  type MxcOpenShellStableFileOperations,
} from "./mxc-openshell-observer";

const DIGESTS = {
  distribution: "1".repeat(64),
  cli: "2".repeat(64),
  gateway: "3".repeat(64),
  wxcExec: "4".repeat(64),
  config: "5".repeat(64),
} as const;

const PATHS = {
  distributionArtifactPath: "C:\\OpenShell\\packages\\openshell-0.0.21.zip",
  distributionRoot: "C:\\OpenShell",
  mxcRoot: "C:\\mxc-kit",
  cliPath: "C:\\OpenShell\\bin\\openshell.exe",
  gatewayPath: "C:\\OpenShell\\bin\\openshell-gateway.exe",
  wxcExecPath: "C:\\mxc-kit\\bin\\wxc-exec.exe",
  gatewayConfigPath: "C:\\ProgramData\\NVIDIA\\OpenShell\\gateway.toml",
} as const;

function request(): MxcOpenShellAttachmentObservationRequest {
  return {
    contractVersion: 3,
    providerId: "mxc",
    mode: "attach-existing",
    observedDistribution: {
      version: "0.0.21",
      revision: "a".repeat(40),
    },
    observedGateway: {
      driver: "mxc",
      backend: "process_container",
    },
    installation: { ...PATHS },
  };
}

function acceptedDigest(filePath: string): string {
  const digests = new Map<string, string>([
    [PATHS.distributionArtifactPath, DIGESTS.distribution],
    [PATHS.cliPath, DIGESTS.cli],
    [PATHS.gatewayPath, DIGESTS.gateway],
    [PATHS.wxcExecPath, DIGESTS.wxcExec],
    [PATHS.gatewayConfigPath, DIGESTS.config],
  ]);
  const digest = digests.get(filePath);
  expect(digest).toBeDefined();
  return digest!;
}

type TestStat = Awaited<ReturnType<MxcOpenShellStableFileOperations["lstat"]>>;

function testStat(overrides: Partial<TestStat> = {}): TestStat {
  return {
    dev: 1n,
    ino: 2n,
    size: 3n,
    mtimeNs: 4n,
    ctimeNs: 5n,
    isFile: () => true,
    isSymbolicLink: () => false,
    ...overrides,
  };
}

function stableFileOperations(
  content: string,
  options: {
    readonly handleAfter?: TestStat;
    readonly handleBefore?: TestStat;
    readonly pathAfter?: TestStat;
    readonly pathBefore?: TestStat;
  } = {},
) {
  const bytes = Buffer.from(content, "utf8");
  const base = testStat({ size: BigInt(bytes.length) });
  const close = vi.fn(async () => undefined);
  let pathStatCalls = 0;
  let handleStatCalls = 0;
  const handleStats = [options.handleBefore ?? base, options.handleAfter ?? base];
  const operations: MxcOpenShellStableFileOperations = {
    lstat: vi.fn(async () => {
      pathStatCalls += 1;
      return pathStatCalls === 1 ? (options.pathBefore ?? base) : (options.pathAfter ?? base);
    }),
    open: vi.fn(async () => ({
      stat: async () => {
        const observed = handleStats[handleStatCalls] ?? base;
        handleStatCalls += 1;
        return observed;
      },
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const chunk = bytes.subarray(position, position + length);
        chunk.copy(buffer, offset);
        return { bytesRead: chunk.length };
      },
      close,
    })),
  };
  return { close, operations, handleStatCalls: () => handleStatCalls };
}

describe("inactive OpenShell MXC installation observer", () => {
  it("collects exact installed-file identities without executing the package (#8178)", async () => {
    const observeDigest = vi.fn(async (filePath: string) => acceptedDigest(filePath));

    const observed = await observeMxcOpenShellAttachment(request(), observeDigest);

    expect(observeDigest.mock.calls.map(([filePath]) => filePath)).toEqual([
      PATHS.distributionArtifactPath,
      PATHS.cliPath,
      PATHS.gatewayPath,
      PATHS.wxcExecPath,
      PATHS.gatewayConfigPath,
    ]);
    expect(observed).toMatchObject({
      distribution: { sha256: DIGESTS.distribution },
      components: {
        cliSha256: DIGESTS.cli,
        gatewaySha256: DIGESTS.gateway,
        wxcExecSha256: DIGESTS.wxcExec,
      },
      gateway: { configSha256: DIGESTS.config },
    });
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed.components)).toBe(true);
  });

  it("does not retain mutable aliases from the observation request (#8178)", async () => {
    const source = request();
    const originalCliPath = source.installation.cliPath;
    const observed = await observeMxcOpenShellAttachment(source, async (filePath) =>
      acceptedDigest(filePath),
    );

    Reflect.set(source.observedDistribution, "version", "9.9.9");
    Reflect.set(source.installation, "cliPath", "C:\\OpenShell\\bin\\replacement.exe");

    expect(observed.distribution.version).toBe("0.0.21");
    expect(observed.cliPath).toBe(originalCliPath);
  });

  it("stops when an installation file cannot be observed (#8178)", async () => {
    const observeDigest = vi.fn((filePath: string) =>
      filePath === PATHS.cliPath
        ? Promise.reject(new Error("reader detail must not escape"))
        : Promise.resolve(acceptedDigest(filePath)),
    );

    await expect(observeMxcOpenShellAttachment(request(), observeDigest)).rejects.toThrow(
      /OpenShell CLI could not be observed/u,
    );
    expect(observeDigest).toHaveBeenCalledTimes(2);
  });

  it("rejects a malformed file digest before returning an observation (#8178)", async () => {
    const observeDigest = vi.fn(async () => "not-a-sha256");

    await expect(observeMxcOpenShellAttachment(request(), observeDigest)).rejects.toThrow(
      /distribution package returned an invalid digest/u,
    );
    expect(observeDigest).toHaveBeenCalledOnce();
  });

  it("rejects a component path escape before reading installation files (#8178)", async () => {
    const source = request();
    const candidate = {
      ...source,
      installation: {
        ...source.installation,
        gatewayPath: "C:\\OtherOpenShell\\openshell-gateway.exe",
      },
    };
    const observeDigest = vi.fn(async (filePath: string) => acceptedDigest(filePath));

    await expect(observeMxcOpenShellAttachment(candidate, observeDigest)).rejects.toThrow(
      /gateway path must remain inside the observed distribution root/u,
    );
    expect(observeDigest).not.toHaveBeenCalled();
  });

  it.each([
    ["distributionArtifactPath", "\\\\host\\share\\openshell.zip"],
    ["distributionRoot", "\\\\host\\share\\OpenShell"],
    ["mxcRoot", "\\\\host\\share\\mxc-kit"],
    ["cliPath", "\\\\host\\share\\openshell.exe"],
    ["gatewayPath", "\\\\host\\share\\openshell-gateway.exe"],
    ["wxcExecPath", "\\\\host\\share\\wxc-exec.exe"],
    ["gatewayConfigPath", "\\\\host\\share\\gateway.toml"],
    ["distributionArtifactPath", "\\\\?\\C:\\OpenShell\\openshell.zip"],
  ] as const)(
    "rejects the non-local %s installation path before reading files (#8178)",
    async (field, value) => {
      const source = request();
      const candidate = {
        ...source,
        installation: { ...source.installation, [field]: value },
      };
      const observeDigest = vi.fn(async (filePath: string) => acceptedDigest(filePath));

      await expect(observeMxcOpenShellAttachment(candidate, observeDigest)).rejects.toThrow(
        /local-drive Windows path/u,
      );
      expect(observeDigest).not.toHaveBeenCalled();
    },
  );

  it.each([
    { field: "acceptedIdentity", value: { distribution: "caller-controlled" } },
    { field: "attachmentAuthority", value: "caller-controlled" },
    { field: "providerToken", value: "must-not-enter-observation" },
  ])(
    "rejects caller-controlled $field before reading installation files (#8178)",
    async ({ field, value }) => {
      const candidate = { ...request(), [field]: value };
      const observeDigest = vi.fn(async (filePath: string) => acceptedDigest(filePath));

      await expect(observeMxcOpenShellAttachment(candidate, observeDigest)).rejects.toThrow(
        /unknown or missing fields/u,
      );
      expect(observeDigest).not.toHaveBeenCalled();
    },
  );

  it("does not copy a reader failure or file content into diagnostics (#8178)", async () => {
    const sensitiveValue = "provider-secret-must-not-appear";

    await expect(
      observeMxcOpenShellAttachment(request(), async () => {
        throw new Error(sensitiveValue);
      }),
    ).rejects.not.toThrow(sensitiveValue);
  });

  it("hashes one unchanged regular-file handle and closes it (#8178)", async () => {
    const { close, handleStatCalls, operations } = stableFileOperations("accepted package bytes");

    await expect(
      readStableMxcOpenShellFileSha256("C:\\OpenShell\\package.zip", operations),
    ).resolves.toBe(createHash("sha256").update("accepted package bytes").digest("hex"));
    expect(handleStatCalls()).toBe(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects replacement during observation and still closes the handle (#8178)", async () => {
    const replacement = testStat({ dev: 9n, ino: 9n, size: 22n });
    const { close, operations } = stableFileOperations("accepted package bytes", {
      pathAfter: replacement,
    });

    await expect(
      readStableMxcOpenShellFileSha256("C:\\OpenShell\\package.zip", operations),
    ).rejects.toThrow(/stable regular-file handle/u);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    ["before hashing", { handleBefore: testStat({ ino: 9n }) }],
    ["after hashing", { handleAfter: testStat({ ino: 9n }) }],
  ] as const)(
    "rejects handle identity drift %s and closes the handle (#8178)",
    async (_phase, options) => {
      const { close, operations } = stableFileOperations("accepted package bytes", options);

      await expect(
        readStableMxcOpenShellFileSha256("C:\\OpenShell\\package.zip", operations),
      ).rejects.toThrow(/stable regular-file handle/u);
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("rejects a symbolic link before opening it (#8178)", async () => {
    const symbolicLink = testStat({ isFile: () => false, isSymbolicLink: () => true });
    const open = vi.fn();
    const operations: MxcOpenShellStableFileOperations = {
      lstat: async () => symbolicLink,
      open,
    };

    await expect(
      readStableMxcOpenShellFileSha256("C:\\OpenShell\\package.zip", operations),
    ).rejects.toThrow(/stable regular-file handle/u);
    expect(open).not.toHaveBeenCalled();
  });

  it.skipIf(
    typeof fsConstants.O_NOFOLLOW !== "number" || typeof fsConstants.O_NONBLOCK !== "number",
  )("rejects a symbolic-link swap at the no-follow open boundary (#8178)", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "nemoclaw-mxc-observer-"));
    const candidate = path.join(directory, "openshell.zip");
    const replacement = path.join(directory, "replacement.zip");
    const nativeOperations = createMxcOpenShellStableFileOperations();
    try {
      await writeFile(candidate, "accepted package bytes");
      await writeFile(replacement, "replacement package bytes");
      const observePath = vi.fn(nativeOperations.lstat).mockImplementationOnce(async (filePath) => {
        const observed = await nativeOperations.lstat(filePath);
        await unlink(candidate);
        await symlink(replacement, candidate);
        return observed;
      });
      const operations: MxcOpenShellStableFileOperations = {
        lstat: observePath,
        open: nativeOperations.open,
      };

      await expect(readStableMxcOpenShellFileSha256(candidate, operations)).rejects.toThrow(
        /stable regular-file handle/u,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
