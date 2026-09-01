// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { rootCertificates } from "node:tls";

import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  closeSync: vi.fn(),
  fstatSync: vi.fn(),
  lstatSync: vi.fn(),
  openSync: vi.fn(),
  readSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  ...fsMocks,
}));

import { buildSanitizedExternalOpenShellTargetPlan } from "./openshell-external-target-boundary.cjs";

const CA_FILE = "/var/run/openshell-target/private-ca.pem";
const AUTHENTICATION_FILE = "/var/run/openshell-target/private-authentication";
const AUTHENTICATION_CONTENTS = "private-authentication-material";
const CA_PEM = rootCertificates[0];
const COMPATIBILITY = { minVersion: "0.0.106", maxVersion: "0.0.106" };
const REGULAR_FILE_METADATA = {
  isFile: () => true,
  isSymbolicLink: () => false,
  dev: 1,
  ino: 1,
};
const REPLACED_FILE_METADATA = {
  isFile: () => true,
  isSymbolicLink: () => false,
  dev: 1,
  ino: 2,
};
const FIFO_METADATA = {
  isFile: () => false,
  isSymbolicLink: () => false,
  dev: 1,
  ino: 1,
};
const SYMBOLIC_LINK_METADATA = {
  isFile: () => false,
  isSymbolicLink: () => true,
  dev: 1,
  ino: 1,
};
const specialFileMetadata = new Map<string, typeof REGULAR_FILE_METADATA>();
const openedFileMetadata = new Map<string, typeof REGULAR_FILE_METADATA>();
const descriptorFiles = new Map<
  number,
  {
    contents: Buffer;
    filePath: string;
    metadata: typeof REGULAR_FILE_METADATA;
    offset: number;
  }
>();
const fileContents = new Map<string, string>();
const fileSizes = new Map<string, number>();
const readFilePaths: string[] = [];
let nextDescriptor = 100;

function externalTarget() {
  return {
    endpoint: "https://openshell.example.test:8443",
    workspace: "default",
    expected_release: "0.0.106",
    lifecycle: "external",
    trust: { ca_file: CA_FILE },
    authentication: { credential_file: AUTHENTICATION_FILE },
  };
}

function missingFile(filePath: string): never {
  throw new Error(`private read failure at ${filePath}`);
}

describe("external OpenShell target boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    specialFileMetadata.clear();
    openedFileMetadata.clear();
    descriptorFiles.clear();
    fileContents.clear();
    fileContents.set(CA_FILE, CA_PEM);
    fileContents.set(AUTHENTICATION_FILE, AUTHENTICATION_CONTENTS);
    fileSizes.clear();
    readFilePaths.length = 0;
    nextDescriptor = 100;
    fsMocks.lstatSync.mockImplementation(
      (filePath: string) => specialFileMetadata.get(filePath) ?? REGULAR_FILE_METADATA,
    );
    fsMocks.openSync.mockImplementation((filePath: string) => {
      const contents = fileContents.get(filePath) ?? missingFile(filePath);
      const descriptor = nextDescriptor++;
      descriptorFiles.set(descriptor, {
        contents: Buffer.from(contents),
        filePath,
        metadata:
          openedFileMetadata.get(filePath) ??
          specialFileMetadata.get(filePath) ??
          REGULAR_FILE_METADATA,
        offset: 0,
      });
      return descriptor;
    });
    fsMocks.fstatSync.mockImplementation((descriptor: number) => {
      const file = descriptorFiles.get(descriptor)!;
      return { ...file.metadata, size: fileSizes.get(file.filePath) ?? file.contents.length };
    });
    fsMocks.readSync.mockImplementation(
      (descriptor: number, buffer: Buffer, offset: number, length: number) => {
        const file = descriptorFiles.get(descriptor)!;
        readFilePaths.push(file.filePath);
        const bytesRead = file.contents.copy(buffer, offset, file.offset, file.offset + length);
        file.offset += bytesRead;
        return bytesRead;
      },
    );
  });

  it("builds the canonical sanitized target-only plan (#9872)", () => {
    const plan = buildSanitizedExternalOpenShellTargetPlan(externalTarget(), COMPATIBILITY);

    expect(plan).toEqual({
      endpoint: "https://openshell.example.test:8443",
      workspace: "default",
      expected_release: "0.0.106",
      lifecycle: "external",
      authentication_source: "file",
      ca_fingerprint: `sha256:${createHash("sha256")
        .update(new X509Certificate(CA_PEM).raw)
        .digest("hex")}`,
    });
    expect(fsMocks.openSync).toHaveBeenCalledWith(CA_FILE, expect.any(Number));
    expect(fsMocks.openSync).toHaveBeenCalledWith(AUTHENTICATION_FILE, expect.any(Number));
    expect(readFilePaths).toContain(CA_FILE);
    expect(readFilePaths).not.toContain(AUTHENTICATION_FILE);
    const rendered = JSON.stringify(plan);
    expect(rendered).not.toContain(CA_FILE);
    expect(rendered).not.toContain(AUTHENTICATION_FILE);
    expect(rendered).not.toContain(AUTHENTICATION_CONTENTS);
    expect(rendered).not.toContain("BEGIN CERTIFICATE");
    expect(rendered).not.toMatch(/mtls|oidc/iu);
  });

  it.each([
    undefined,
    "not-a-url",
    "http://openshell.example.test:8443",
    "https://user:password@openshell.example.test:8443",
    "https://openshell.example.test:8443/rpc",
    "https://openshell.example.test:8443?workspace=other",
    "https://openshell.example.test:0",
    "https://localhost:8443",
    "https://localhost.:8443",
    "https://127.0.0.1:8443",
    "https://0.0.0.0:8443",
    "https://[::]:8443",
    "https://[::ffff:127.0.0.1]:8443",
  ])("rejects a malformed or non-external HTTPS endpoint before reading files [%s]", (endpoint) => {
    const target = { ...externalTarget(), endpoint };

    expect(() => buildSanitizedExternalOpenShellTargetPlan(target, COMPATIBILITY)).toThrow(
      /endpoint/,
    );
    expect(fsMocks.openSync).not.toHaveBeenCalled();
  });

  it.each([
    ["workspace", (target: Record<string, unknown>) => delete target.workspace],
    ["expected release", (target: Record<string, unknown>) => delete target.expected_release],
    ["trust", (target: Record<string, unknown>) => delete target.trust],
    ["authentication", (target: Record<string, unknown>) => delete target.authentication],
    [
      "CA file",
      (target: Record<string, unknown>) => {
        target.trust = {};
      },
    ],
    [
      "authentication file",
      (target: Record<string, unknown>) => {
        target.authentication = {};
      },
    ],
  ] as const)("rejects missing %s before reading files", (_name, corrupt) => {
    const target = { ...externalTarget() } as Record<string, unknown>;
    corrupt(target);

    expect(() => buildSanitizedExternalOpenShellTargetPlan(target, COMPATIBILITY)).toThrow(
      /external OpenShell target/,
    );
    expect(fsMocks.openSync).not.toHaveBeenCalled();
  });

  it("rejects mixed local and external lifecycle input before reading files (#9872)", () => {
    const target = { ...externalTarget(), local: { mode: "managed" } };

    expect(() => buildSanitizedExternalOpenShellTargetPlan(target, COMPATIBILITY)).toThrow(
      /must not combine external and local lifecycle/,
    );
    expect(fsMocks.openSync).not.toHaveBeenCalled();
  });

  it.each([
    ["target", null],
    ["target field", { ...externalTarget(), unsupported: true }],
    ["lifecycle", { ...externalTarget(), lifecycle: "managed" }],
    ["workspace", { ...externalTarget(), workspace: "not valid" }],
    ["expected release", { ...externalTarget(), expected_release: "0.0" }],
    ["authentication", { ...externalTarget(), authentication: "file" }],
    [
      "authentication field",
      {
        ...externalTarget(),
        authentication: { ...externalTarget().authentication, unsupported: true },
      },
    ],
    [
      "relative authentication file",
      { ...externalTarget(), authentication: { credential_file: "authentication.txt" } },
    ],
    [
      "protocol-specific authentication form",
      {
        ...externalTarget(),
        authentication: { kind: "oidc", token_file: AUTHENTICATION_FILE },
      },
    ],
  ])("rejects an unsupported %s before reading files", (_name, target) => {
    expect(() => buildSanitizedExternalOpenShellTargetPlan(target, COMPATIBILITY)).toThrow(
      /external OpenShell target/,
    );
    expect(fsMocks.openSync).not.toHaveBeenCalled();
  });

  it("rejects an incompatible expected release before reading files (#9872)", () => {
    const target = { ...externalTarget(), expected_release: "0.0.107" };

    expect(() => buildSanitizedExternalOpenShellTargetPlan(target, COMPATIBILITY)).toThrow(
      /outside the compatible range/,
    );
    expect(fsMocks.openSync).not.toHaveBeenCalled();
  });

  it.each([
    ["non-semantic", { minVersion: "current", maxVersion: "0.0.106" }],
    ["unsafe", { minVersion: "0.0.106", maxVersion: "9007199254740992.0.0" }],
    ["reversed", { minVersion: "0.0.107", maxVersion: "0.0.106" }],
  ])("rejects a %s compatibility range before reading files", (_name, compatibility) => {
    expect(() =>
      buildSanitizedExternalOpenShellTargetPlan(externalTarget(), compatibility),
    ).toThrow(/compatibility range/);
    expect(fsMocks.openSync).not.toHaveBeenCalled();
  });

  it("rejects an invalid CA bundle and empty authentication without exposing private input (#9872)", () => {
    const privateCaContents = "not-a-certificate private-ca-value";
    fileContents.set(CA_FILE, privateCaContents);

    const caError = expectError(() =>
      buildSanitizedExternalOpenShellTargetPlan(externalTarget(), COMPATIBILITY),
    );
    fileContents.set(CA_FILE, CA_PEM);
    fileSizes.set(AUTHENTICATION_FILE, 0);
    const authenticationError = expectError(() =>
      buildSanitizedExternalOpenShellTargetPlan(externalTarget(), COMPATIBILITY),
    );
    const output = `${caError.message}\n${authenticationError.message}`;

    expect(output).not.toContain(CA_FILE);
    expect(output).not.toContain(AUTHENTICATION_FILE);
    expect(output).not.toContain(privateCaContents);
    expect(output).not.toContain(AUTHENTICATION_CONTENTS);
  });

  it("rejects an oversized CA bundle without returning its path (#9872)", () => {
    fileSizes.set(CA_FILE, 1024 * 1024 + 1);

    const error = expectError(() =>
      buildSanitizedExternalOpenShellTargetPlan(externalTarget(), COMPATIBILITY),
    );

    expect(error.message).toBe(
      "external OpenShell target CA file is empty or exceeds its size limit",
    );
    expect(error.message).not.toContain(CA_FILE);
    expect(readFilePaths).not.toContain(CA_FILE);
  });

  it("rejects an oversized authentication file without returning its path (#9872)", () => {
    fileSizes.set(AUTHENTICATION_FILE, 1024 * 1024 + 1);

    const error = expectError(() =>
      buildSanitizedExternalOpenShellTargetPlan(externalTarget(), COMPATIBILITY),
    );

    expect(error.message).toBe(
      "external OpenShell target authentication file is empty or exceeds its size limit",
    );
    expect(error.message).not.toContain(AUTHENTICATION_FILE);
    expect(readFilePaths).toContain(CA_FILE);
    expect(readFilePaths).not.toContain(AUTHENTICATION_FILE);
  });

  it("redacts a file-read failure cause (#9872)", () => {
    fsMocks.readSync.mockImplementationOnce(() => {
      throw new Error(`credential/private-value from ${CA_FILE}`);
    });

    const error = expectError(() =>
      buildSanitizedExternalOpenShellTargetPlan(externalTarget(), COMPATIBILITY),
    );

    expect(error.message).toBe("external OpenShell target CA file could not be read");
    expect(error.message).not.toContain(CA_FILE);
    expect(error.message).not.toContain("credential/private-value");
    expect(fsMocks.closeSync).toHaveBeenCalled();
  });

  it.each([
    ["CA FIFO", externalTarget(), CA_FILE, FIFO_METADATA],
    ["authentication FIFO", externalTarget(), AUTHENTICATION_FILE, FIFO_METADATA],
    ["CA symbolic link", externalTarget(), CA_FILE, SYMBOLIC_LINK_METADATA],
    ["authentication symbolic link", externalTarget(), AUTHENTICATION_FILE, SYMBOLIC_LINK_METADATA],
  ])("rejects a %s without reading it (#9872)", (_name, target, specialPath, metadata) => {
    specialFileMetadata.set(specialPath, metadata);
    openedFileMetadata.set(specialPath, metadata);

    const error = expectError(() =>
      buildSanitizedExternalOpenShellTargetPlan(target, COMPATIBILITY),
    );

    expect(error.message).toMatch(/could not be (?:read|validated)/);
    expect(error.message).not.toContain(specialPath);
    expect(fsMocks.lstatSync).toHaveBeenCalledWith(specialPath);
    expect(fsMocks.openSync).toHaveBeenCalledWith(specialPath, expect.any(Number));
    const openFlags = fsMocks.openSync.mock.calls.find(([path]) => path === specialPath)?.[1];
    expect(Number(openFlags) & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    expect(readFilePaths).not.toContain(specialPath);
  });

  it("rejects a path replacement without reading from the opened file (#9872)", () => {
    openedFileMetadata.set(CA_FILE, REGULAR_FILE_METADATA);
    specialFileMetadata.set(CA_FILE, REPLACED_FILE_METADATA);

    const error = expectError(() =>
      buildSanitizedExternalOpenShellTargetPlan(externalTarget(), COMPATIBILITY),
    );

    expect(error.message).toBe("external OpenShell target CA file could not be read");
    expect(error.message).not.toContain(CA_FILE);
    expect(readFilePaths).not.toContain(CA_FILE);
  });
});

function expectError(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected operation to fail");
}
