// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, X509Certificate } from "node:crypto";
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

import {
  buildSanitizedExternalOpenShellTargetPlan,
  isExternalOpenShellTarget,
  type ExternalOpenShellTarget,
} from "./openshell-external-target-boundary.cjs";

const CA_FILE = "/run/secrets/openshell/private-ca.pem";
const TOKEN_FILE = "/run/secrets/openshell/private-oidc-token";
const CLIENT_CERTIFICATE_FILE = "/run/secrets/openshell/private-client.crt";
const CLIENT_KEY_FILE = "/run/secrets/openshell/private-client.key";
const OIDC_TOKEN = "header.private-credential.signature";
const CA_PEM = rootCertificates[0];
const CLIENT_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIBczCCASWgAwIBAgIUc6u16vRHoTSFkoJ5JDxy+eoCvykwBQYDK2VwMC8xLTAr
BgNVBAMMJE5lbW9DbGF3IGV4dGVybmFsIHRhcmdldCB0ZXN0IGNsaWVudDAeFw0y
NjA4MjQwMDIyNDRaFw0zNjA4MjEwMDIyNDRaMC8xLTArBgNVBAMMJE5lbW9DbGF3
IGV4dGVybmFsIHRhcmdldCB0ZXN0IGNsaWVudDAqMAUGAytlcAMhABCvaNyHlkEa
75YhATM3d/uSSi9xZVTy847slsn2N1xHo1MwUTAdBgNVHQ4EFgQUMsWyQj5Kub0m
gzDVpRipT6+r8owwHwYDVR0jBBgwFoAUMsWyQj5Kub0mgzDVpRipT6+r8owwDwYD
VR0TAQH/BAUwAwEB/zAFBgMrZXADQQB/o1lK+sF+sTFVEMOzu4k+prnGQ7fPYqux
n6hN+hDkBtOg2KHxy9V/Kv4WzzROmscdCuj+KYrnTgHKMmT7afoM
-----END CERTIFICATE-----`;
const PRIVATE_KEY_LABEL = `${"PRIVATE"} KEY`;
const CLIENT_KEY_PEM = `-----BEGIN ${PRIVATE_KEY_LABEL}-----
MC4CAQAwBQYDK2VwBCIEIBX8tF759OyKafVaSsBXDYYT2k76SD+5MkpLJKASbJkv
-----END ${PRIVATE_KEY_LABEL}-----`;
const OTHER_CLIENT_KEY_PEM = `-----BEGIN ${PRIVATE_KEY_LABEL}-----
MC4CAQAwBQYDK2VwBCIEIPzdNLmPz7FCEIJK3Kclxe6ZW67boddYBowDcQA98CnJ
-----END ${PRIVATE_KEY_LABEL}-----`;
const COMPATIBILITY = { minVersion: "0.0.106", maxVersion: "0.0.106" };
const REGULAR_FILE_METADATA = { isFile: () => true, isSymbolicLink: () => false };
const FIFO_METADATA = { isFile: () => false, isSymbolicLink: () => false };
const SYMBOLIC_LINK_METADATA = { isFile: () => false, isSymbolicLink: () => true };
const specialFileMetadata = new Map<string, typeof REGULAR_FILE_METADATA>();
const descriptorFiles = new Map<number, { contents: Buffer; offset: number }>();
const defaultFileContents = new Map([
  [CA_FILE, CA_PEM],
  [TOKEN_FILE, OIDC_TOKEN],
  [CLIENT_CERTIFICATE_FILE, CLIENT_CERTIFICATE_PEM],
  [CLIENT_KEY_FILE, CLIENT_KEY_PEM],
]);
let nextDescriptor = 100;

function oidcTarget(): ExternalOpenShellTarget {
  return {
    endpoint: "https://openshell.example.test:8443",
    workspace: "default",
    expected_release: "0.0.106",
    lifecycle: "external",
    trust: { ca_file: CA_FILE },
    authentication: { kind: "oidc", token_file: TOKEN_FILE },
  };
}

function mtlsTarget(): ExternalOpenShellTarget {
  return {
    ...oidcTarget(),
    authentication: {
      kind: "mtls",
      client_certificate_file: CLIENT_CERTIFICATE_FILE,
      client_key_file: CLIENT_KEY_FILE,
    },
  };
}

function reader(files?: ReadonlyMap<string, string>) {
  const contents =
    files ??
    new Map([
      [CA_FILE, CA_PEM],
      [TOKEN_FILE, OIDC_TOKEN],
    ]);
  return vi.fn((filePath: string, _maxBytes: number) => {
    return contents.get(filePath) ?? missingFile(filePath);
  });
}

function missingFile(filePath: string): never {
  throw new Error(`private read failure at ${filePath}`);
}

describe("external OpenShell target boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    specialFileMetadata.clear();
    descriptorFiles.clear();
    nextDescriptor = 100;
    fsMocks.lstatSync.mockImplementation(
      (filePath: string) => specialFileMetadata.get(filePath) ?? REGULAR_FILE_METADATA,
    );
    fsMocks.openSync.mockImplementation((filePath: string) => {
      const descriptor = nextDescriptor++;
      descriptorFiles.set(descriptor, {
        contents: Buffer.from(defaultFileContents.get(filePath)!),
        offset: 0,
      });
      return descriptor;
    });
    fsMocks.fstatSync.mockImplementation((descriptor: number) => {
      const file = descriptorFiles.get(descriptor)!;
      return { isFile: () => true, size: file.contents.length };
    });
    fsMocks.readSync.mockImplementation(
      (descriptor: number, buffer: Buffer, offset: number, length: number) => {
        const file = descriptorFiles.get(descriptor)!;
        const bytesRead = file.contents.copy(buffer, offset, file.offset, file.offset + length);
        file.offset += bytesRead;
        return bytesRead;
      },
    );
  });

  it("builds the canonical sanitized target-only plan (#9872)", () => {
    const readFile = reader();

    const plan = buildSanitizedExternalOpenShellTargetPlan(oidcTarget(), COMPATIBILITY, {
      readFile,
    });

    expect(plan).toEqual({
      endpoint: "https://openshell.example.test:8443",
      workspace: "default",
      expected_release: "0.0.106",
      lifecycle: "external",
      authentication_kind: "oidc",
      ca_fingerprint: `sha256:${createHash("sha256")
        .update(new X509Certificate(CA_PEM).raw)
        .digest("hex")}`,
    });
    expect(readFile.mock.calls.map(([filePath]) => filePath)).toEqual([CA_FILE, TOKEN_FILE]);
    const rendered = JSON.stringify(plan);
    expect(rendered).not.toContain(CA_FILE);
    expect(rendered).not.toContain(TOKEN_FILE);
    expect(rendered).not.toContain(OIDC_TOKEN);
    expect(rendered).not.toContain("BEGIN CERTIFICATE");
  });

  it.each([
    undefined,
    "not-a-url",
    "http://openshell.example.test:8443",
    "https://user:password@openshell.example.test:8443",
    "https://openshell.example.test:8443/rpc",
    "https://openshell.example.test:8443?workspace=other",
    "https://localhost:8443",
    "https://localhost.:8443",
    "https://127.0.0.1:8443",
    "https://0.0.0.0:8443",
    "https://[::]:8443",
    "https://[::ffff:127.0.0.1]:8443",
  ])("rejects a malformed or non-external HTTPS endpoint before reading files [%s]", (endpoint) => {
    const readFile = reader();
    const target = { ...oidcTarget(), endpoint };

    expect(() =>
      buildSanitizedExternalOpenShellTargetPlan(target, COMPATIBILITY, { readFile }),
    ).toThrow(/endpoint/);
    expect(readFile).not.toHaveBeenCalled();
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
      "OIDC token file",
      (target: Record<string, unknown>) => {
        target.authentication = { kind: "oidc" };
      },
    ],
    [
      "mTLS client key file",
      (target: Record<string, unknown>) => {
        target.authentication = {
          kind: "mtls",
          client_certificate_file: CLIENT_CERTIFICATE_FILE,
        };
      },
    ],
  ] as const)("rejects missing %s before reading files", (_name, corrupt) => {
    const target = { ...oidcTarget() } as Record<string, unknown>;
    corrupt(target);
    const readFile = reader();

    expect(() =>
      buildSanitizedExternalOpenShellTargetPlan(target, COMPATIBILITY, { readFile }),
    ).toThrow(/external OpenShell target/);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects mixed local and external lifecycle input before reading files (#9872)", () => {
    const readFile = reader();
    const target = { ...oidcTarget(), local: { mode: "managed" } };

    expect(() =>
      buildSanitizedExternalOpenShellTargetPlan(target, COMPATIBILITY, { readFile }),
    ).toThrow(/must not combine external and local lifecycle/);
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([
    ["target", null],
    ["target field", { ...oidcTarget(), unsupported: true }],
    ["lifecycle", { ...oidcTarget(), lifecycle: "managed" }],
    ["workspace", { ...oidcTarget(), workspace: "not valid" }],
    ["expected release", { ...oidcTarget(), expected_release: "0.0" }],
    ["authentication", { ...oidcTarget(), authentication: "oidc" }],
    [
      "mTLS authentication field",
      { ...mtlsTarget(), authentication: { ...mtlsTarget().authentication, unsupported: true } },
    ],
    [
      "OIDC authentication field",
      {
        ...oidcTarget(),
        authentication: { ...oidcTarget().authentication, unsupported: true },
      },
    ],
    [
      "relative authentication file",
      { ...oidcTarget(), authentication: { kind: "oidc", token_file: "token.txt" } },
    ],
    ["authentication kind", { ...oidcTarget(), authentication: { kind: "password" } }],
  ])("rejects an unsupported %s before reading files", (_name, target) => {
    const readFile = reader();

    expect(() =>
      buildSanitizedExternalOpenShellTargetPlan(target, COMPATIBILITY, { readFile }),
    ).toThrow(/external OpenShell target/);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects an incompatible expected release before reading files (#9872)", () => {
    const readFile = reader();
    const target = { ...oidcTarget(), expected_release: "0.0.107" };

    expect(() =>
      buildSanitizedExternalOpenShellTargetPlan(target, COMPATIBILITY, { readFile }),
    ).toThrow(/outside the compatible range/);
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([
    ["non-semantic", { minVersion: "current", maxVersion: "0.0.106" }],
    ["unsafe", { minVersion: "0.0.106", maxVersion: "9007199254740992.0.0" }],
    ["reversed", { minVersion: "0.0.107", maxVersion: "0.0.106" }],
  ])("rejects a %s compatibility range before reading files", (_name, compatibility) => {
    const readFile = reader();

    expect(() =>
      buildSanitizedExternalOpenShellTargetPlan(oidcTarget(), compatibility, { readFile }),
    ).toThrow(/compatibility range/);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects invalid trust and authentication without exposing private input (#9872)", () => {
    const privateCaContents = "not-a-certificate private-ca-value";
    const privateTokenContents = "private token with whitespace";
    const invalidCaReader = reader(
      new Map([
        [CA_FILE, privateCaContents],
        [TOKEN_FILE, OIDC_TOKEN],
      ]),
    );
    const invalidTokenReader = reader(
      new Map([
        [CA_FILE, CA_PEM],
        [TOKEN_FILE, privateTokenContents],
      ]),
    );

    const caError = expectError(() =>
      buildSanitizedExternalOpenShellTargetPlan(oidcTarget(), COMPATIBILITY, {
        readFile: invalidCaReader,
      }),
    );
    const tokenError = expectError(() =>
      buildSanitizedExternalOpenShellTargetPlan(oidcTarget(), COMPATIBILITY, {
        readFile: invalidTokenReader,
      }),
    );
    const output = `${caError.message}\n${tokenError.message}`;

    expect(output).not.toContain(CA_FILE);
    expect(output).not.toContain(TOKEN_FILE);
    expect(output).not.toContain(privateCaContents);
    expect(output).not.toContain(privateTokenContents);
    expect(output).not.toContain(OIDC_TOKEN);
  });

  it("validates matching mTLS authentication without returning private input (#9872)", () => {
    const readFile = reader(
      new Map([
        [CA_FILE, CA_PEM],
        [CLIENT_CERTIFICATE_FILE, CLIENT_CERTIFICATE_PEM],
        [CLIENT_KEY_FILE, CLIENT_KEY_PEM],
      ]),
    );

    const plan = buildSanitizedExternalOpenShellTargetPlan(mtlsTarget(), COMPATIBILITY, {
      readFile,
    });

    expect(plan.authentication_kind).toBe("mtls");
    const rendered = JSON.stringify(plan);
    expect(rendered).not.toContain(CLIENT_CERTIFICATE_FILE);
    expect(rendered).not.toContain(CLIENT_KEY_FILE);
    expect(rendered).not.toContain(CLIENT_CERTIFICATE_PEM);
    expect(rendered).not.toContain(CLIENT_KEY_PEM);
  });

  it("rejects a mismatched mTLS key without returning private input (#9872)", () => {
    const readFile = reader(
      new Map([
        [CA_FILE, CA_PEM],
        [CLIENT_CERTIFICATE_FILE, CLIENT_CERTIFICATE_PEM],
        [CLIENT_KEY_FILE, OTHER_CLIENT_KEY_PEM],
      ]),
    );

    const error = expectError(() =>
      buildSanitizedExternalOpenShellTargetPlan(mtlsTarget(), COMPATIBILITY, { readFile }),
    );
    const output = error.message;

    expect(output).toBe("external OpenShell target mTLS authentication files are invalid");
    expect(output).not.toContain(CLIENT_CERTIFICATE_FILE);
    expect(output).not.toContain(CLIENT_KEY_FILE);
    expect(output).not.toContain(CLIENT_CERTIFICATE_PEM);
    expect(output).not.toContain(OTHER_CLIENT_KEY_PEM);
  });

  it("rejects an oversized trust file without returning its path (#9872)", () => {
    const readFile = reader(new Map([[CA_FILE, "x".repeat(1024 * 1024 + 1)]]));

    const error = expectError(() =>
      buildSanitizedExternalOpenShellTargetPlan(oidcTarget(), COMPATIBILITY, { readFile }),
    );

    expect(error.message).toBe(
      "external OpenShell target CA file is empty or exceeds its size limit",
    );
    expect(error.message).not.toContain(CA_FILE);
    expect(readFile).toHaveBeenCalledWith(CA_FILE, 1024 * 1024);
  });

  it("redacts a file-read failure cause (#9872)", () => {
    const readFile = vi.fn((filePath: string) => {
      throw new Error(`credential/private-value from ${filePath}`);
    });

    const error = expectError(() =>
      buildSanitizedExternalOpenShellTargetPlan(oidcTarget(), COMPATIBILITY, { readFile }),
    );

    expect(error.message).toBe("external OpenShell target CA file could not be read");
    expect(error.message).not.toContain(CA_FILE);
    expect(error.message).not.toContain("credential/private-value");
  });

  it.each([
    ["CA FIFO", oidcTarget(), CA_FILE, FIFO_METADATA],
    ["OIDC token FIFO", oidcTarget(), TOKEN_FILE, FIFO_METADATA],
    ["mTLS certificate FIFO", mtlsTarget(), CLIENT_CERTIFICATE_FILE, FIFO_METADATA],
    ["mTLS key FIFO", mtlsTarget(), CLIENT_KEY_FILE, FIFO_METADATA],
    ["CA symbolic link", oidcTarget(), CA_FILE, SYMBOLIC_LINK_METADATA],
  ])("rejects a %s before opening it (#9872)", (_name, target, specialPath, metadata) => {
    specialFileMetadata.set(specialPath, metadata);

    const error = expectError(() =>
      buildSanitizedExternalOpenShellTargetPlan(target, COMPATIBILITY),
    );

    expect(error.message).toMatch(/could not be read/);
    expect(error.message).not.toContain(specialPath);
    expect(fsMocks.lstatSync).toHaveBeenCalledWith(specialPath);
    expect(fsMocks.openSync).not.toHaveBeenCalledWith(specialPath, expect.anything());
  });

  it("recognizes only complete, canonical target shapes", () => {
    expect(isExternalOpenShellTarget(oidcTarget())).toBe(true);
    expect(
      isExternalOpenShellTarget({
        ...mtlsTarget(),
      }),
    ).toBe(true);
    expect(isExternalOpenShellTarget({ ...oidcTarget(), lifecycle: "managed" })).toBe(false);
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
