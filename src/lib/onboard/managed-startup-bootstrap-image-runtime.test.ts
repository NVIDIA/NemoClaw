// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  serializeManagedBootstrapEnvelope,
  serializeManagedBootstrapImageCompletion,
} from "./managed-bootstrap/envelope";
import {
  readManagedBootstrapEnvelope,
  verifyManagedBootstrapImageCompletion,
} from "./managed-bootstrap/image-runtime";
import {
  MANAGED_STARTUP_COMPLETION_SCHEMA_VERSION,
  serializeManagedStartupCompletionMarker,
} from "./managed-startup/image-runtime";
import {
  encodeManagedStartupProfile,
  fingerprintManagedStartupProfile,
} from "./managed-startup/profile";
import { createManagedStartupRootApplyRequest } from "./managed-startup/root-apply";

const temporaryDirectories: string[] = [];
const BOOTSTRAP_IDENTITY = "b".repeat(64);

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bootstrap-image-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

function mockRootFileOwnership(): void {
  const realFstatSync = fs.fstatSync.bind(fs);
  const rootOwnership = new Map<PropertyKey, unknown>([
    ["uid", 0n],
    ["gid", 0n],
  ]);
  const rootOwned = (stat: fs.BigIntStats): fs.BigIntStats =>
    new Proxy(stat, {
      get(inner, property) {
        const value = rootOwnership.has(property)
          ? rootOwnership.get(property)
          : (Reflect.get(inner, property, inner) as unknown);
        return typeof value === "function" ? value.bind(inner) : value;
      },
    });
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  vi.spyOn(fs, "fstatSync").mockImplementation(((descriptor: number, options: { bigint: true }) =>
    rootOwned(realFstatSync(descriptor, options))) as typeof fs.fstatSync);
}

function writeProtectedFile(target: string, contents: string, mode: number): void {
  fs.writeFileSync(target, contents, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(target, mode);
}

function requestFixture() {
  const profile = managedStartupE2eProfile("openclaw");
  const rootApplyRequest = createManagedStartupRootApplyRequest({
    agent: profile.agent,
    encodedProfile: encodeManagedStartupProfile(profile),
  });
  return {
    expected: {
      agent: profile.agent,
      profileFingerprint: rootApplyRequest.profileFingerprint,
      bootstrapIdentity: BOOTSTRAP_IDENTITY,
    } as const,
    rootApplyRequest,
  };
}

function completionFixture(directory: string) {
  const profile = managedStartupE2eProfile("openclaw");
  const profileFingerprint = fingerprintManagedStartupProfile(profile);
  const runtimeEnvironment = "export NEMOCLAW_MANAGED_STARTUP_APPLIED='1'\n";
  const completionFile = path.join(directory, "managed-bootstrap-completion.json");
  const startupCompletionFile = path.join(directory, "managed-startup-complete.json");
  const runtimeEnvironmentFile = path.join(directory, "managed-startup-runtime.env");
  writeProtectedFile(runtimeEnvironmentFile, runtimeEnvironment, 0o444);
  writeProtectedFile(
    startupCompletionFile,
    serializeManagedStartupCompletionMarker({
      schemaVersion: MANAGED_STARTUP_COMPLETION_SCHEMA_VERSION,
      agent: profile.agent,
      profileFingerprint,
      runtimeEnvironmentSha256: createHash("sha256").update(runtimeEnvironment).digest("hex"),
      corporateCaMerged: false,
    }),
    0o444,
  );
  writeProtectedFile(
    completionFile,
    serializeManagedBootstrapImageCompletion({
      agent: profile.agent,
      bootstrapIdentity: BOOTSTRAP_IDENTITY,
      profileFingerprint,
      transactionPending: true,
    }),
    0o444,
  );
  return {
    completionFile,
    expected: {
      agent: profile.agent,
      profileFingerprint,
      bootstrapIdentity: BOOTSTRAP_IDENTITY,
    } as const,
    runtimeEnvironmentFile,
    startupCompletionFile,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("managed bootstrap image runtime", () => {
  it("validates one exact root-owned bootstrap envelope without ending retry authority", () => {
    const directory = temporaryDirectory();
    const requestFile = path.join(directory, "request.json");
    const fixture = requestFixture();
    writeProtectedFile(
      requestFile,
      serializeManagedBootstrapEnvelope({
        bootstrapIdentity: BOOTSTRAP_IDENTITY,
        rootApplyRequest: fixture.rootApplyRequest,
      }),
      0o400,
    );
    mockRootFileOwnership();

    expect(readManagedBootstrapEnvelope(fixture.expected, requestFile)).toEqual(
      fixture.rootApplyRequest,
    );
    expect(fs.existsSync(requestFile)).toBe(true);
  });

  it.each([
    ["wrong replacement identity", "c".repeat(64), 0o400, /identity does not match/u],
    ["writable request", BOOTSTRAP_IDENTITY, 0o600, /root:root mode 0400/u],
  ] as const)("rejects a %s without consuming the request", (_label, identity, mode, message) => {
    const directory = temporaryDirectory();
    const requestFile = path.join(directory, "request.json");
    const fixture = requestFixture();
    writeProtectedFile(
      requestFile,
      serializeManagedBootstrapEnvelope({
        bootstrapIdentity: BOOTSTRAP_IDENTITY,
        rootApplyRequest: fixture.rootApplyRequest,
      }),
      mode,
    );
    mockRootFileOwnership();

    expect(() =>
      readManagedBootstrapEnvelope(
        { ...fixture.expected, bootstrapIdentity: identity },
        requestFile,
      ),
    ).toThrow(message);
    expect(fs.existsSync(requestFile)).toBe(true);
  });

  it("authenticates the bootstrap marker and nested startup handoff together", () => {
    const fixture = completionFixture(temporaryDirectory());
    mockRootFileOwnership();

    expect(
      verifyManagedBootstrapImageCompletion(
        fixture.expected,
        fixture.completionFile,
        fixture.startupCompletionFile,
        fixture.runtimeEnvironmentFile,
      ),
    ).toMatchObject({
      ...fixture.expected,
      transactionPending: true,
    });
  });

  it.each([
    ["another bootstrap identity", "c".repeat(64), 0o444, /identity does not match/u],
    ["a writable bootstrap marker", BOOTSTRAP_IDENTITY, 0o640, /root:root mode 0444/u],
  ] as const)("rejects %s", (_label, bootstrapIdentity, mode, message) => {
    const fixture = completionFixture(temporaryDirectory());
    fs.chmodSync(fixture.completionFile, mode);
    mockRootFileOwnership();

    expect(() =>
      verifyManagedBootstrapImageCompletion(
        { ...fixture.expected, bootstrapIdentity },
        fixture.completionFile,
        fixture.startupCompletionFile,
        fixture.runtimeEnvironmentFile,
      ),
    ).toThrow(message);
  });
});
