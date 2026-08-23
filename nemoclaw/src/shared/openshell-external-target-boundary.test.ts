// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";

import { describe, expect, it, vi } from "vitest";

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
const COMPATIBILITY = { minVersion: "0.0.106", maxVersion: "0.0.106" };

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

function reader(files?: ReadonlyMap<string, string>) {
  const contents =
    files ??
    new Map([
      [CA_FILE, CA_PEM],
      [TOKEN_FILE, OIDC_TOKEN],
    ]);
  return vi.fn((filePath: string) => {
    return contents.get(filePath) ?? missingFile(filePath);
  });
}

function missingFile(filePath: string): never {
  throw new Error(`private read failure at ${filePath}`);
}

describe("external OpenShell target boundary", () => {
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
      compatibility: "compatible",
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
    "https://127.0.0.1:8443",
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

  it("rejects an incompatible expected release before reading files (#9872)", () => {
    const readFile = reader();
    const target = { ...oidcTarget(), expected_release: "0.0.107" };

    expect(() =>
      buildSanitizedExternalOpenShellTargetPlan(target, COMPATIBILITY, { readFile }),
    ).toThrow(/outside the compatible range/);
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

  it("recognizes only complete, canonical target shapes", () => {
    expect(isExternalOpenShellTarget(oidcTarget())).toBe(true);
    expect(
      isExternalOpenShellTarget({
        ...oidcTarget(),
        authentication: {
          kind: "mtls",
          client_certificate_file: CLIENT_CERTIFICATE_FILE,
          client_key_file: CLIENT_KEY_FILE,
        },
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
