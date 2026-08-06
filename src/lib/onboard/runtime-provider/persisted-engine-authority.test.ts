// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  type ContainerEngineOperationScope,
  createContainerEngineCommand,
} from "../../adapters/container-engine";
import {
  createFilePersistedEngineAuthorityStore,
  createPersistedEngineAuthority,
  normalizePersistedEngineAuthority,
  PERSISTED_ENGINE_AUTHORITY_DIRECTORY,
  parsePersistedEngineAuthority,
  persistedEngineAuthorityPath,
  requirePersistedEngineAuthority,
  serializePersistedEngineAuthority,
} from "./persisted-engine-authority";

const BINDING_SHA256 = "1".repeat(64);
const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-engine-authority-"));
  roots.push(root);
  return root;
}

function engine(
  operation: ContainerEngineOperationScope = "sandbox-lifecycle",
  authorityId = `mxc-endpoint:${"2".repeat(64)}`,
) {
  return createContainerEngineCommand({
    operation,
    engineId: "mxc",
    displayName: "MXC test engine",
    authorityId,
    executable: "mxcctl",
    endpointArgs: ["--endpoint", "unix:///run/mxc/runtime.sock"],
    capture: () => ({ status: 0, stdout: "", stderr: "" }),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

describe("persisted engine authority", () => {
  it("round-trips an MXC-style provider without a Podman-specific switch", () => {
    const qualified = engine();
    const authority = createPersistedEngineAuthority("mxc", qualified, BINDING_SHA256);
    const serialized = serializePersistedEngineAuthority(authority);

    expect(parsePersistedEngineAuthority(serialized)).toEqual(authority);
    expect(requirePersistedEngineAuthority(authority, "mxc", qualified, BINDING_SHA256)).toEqual(
      authority,
    );
    expect(authority).toEqual({
      schemaVersion: 1,
      providerId: "mxc",
      operation: "sandbox-lifecycle",
      engineId: "mxc",
      authorityId: `mxc-endpoint:${"2".repeat(64)}`,
      bindingSha256: BINDING_SHA256,
    });
  });

  it("writes one private canonical record and accepts an exact retry", () => {
    const root = temporaryRoot();
    const authority = createPersistedEngineAuthority("mxc", engine(), BINDING_SHA256);
    const store = createFilePersistedEngineAuthorityStore(root);

    expect(store.record(authority)).toEqual(authority);
    expect(store.record(authority)).toEqual(authority);
    expect(store.load("sandbox-lifecycle")).toEqual(authority);

    const directory = path.join(root, PERSISTED_ENGINE_AUTHORITY_DIRECTORY);
    const target = persistedEngineAuthorityPath(root, "sandbox-lifecycle");
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      expect(fs.fstatSync(descriptor).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(descriptor, "utf8")).toBe(
        serializePersistedEngineAuthority(authority),
      );
    } finally {
      fs.closeSync(descriptor);
    }
  });

  it("persists a host-local inference engine independently of lifecycle authority", () => {
    const store = createFilePersistedEngineAuthorityStore(temporaryRoot());
    const inference = createPersistedEngineAuthority(
      "mxc",
      engine("host-local-inference"),
      BINDING_SHA256,
    );
    const lifecycle = createPersistedEngineAuthority(
      "mxc",
      engine("sandbox-lifecycle"),
      BINDING_SHA256,
    );

    expect(store.record(inference)).toEqual(inference);
    expect(store.record(lifecycle)).toEqual(lifecycle);
    expect(store.load("host-local-inference")).toEqual(inference);
    expect(store.load("sandbox-lifecycle")).toEqual(lifecycle);
  });

  it.each([
    {
      label: "provider",
      providerId: "other",
      operation: "sandbox-lifecycle" as const,
      engineId: "mxc",
      authorityId: `mxc-endpoint:${"2".repeat(64)}`,
      bindingSha256: BINDING_SHA256,
      message: "provider does not match",
    },
    {
      label: "operation",
      providerId: "mxc",
      operation: "workload-cleanup" as const,
      engineId: "mxc",
      authorityId: `mxc-endpoint:${"2".repeat(64)}`,
      bindingSha256: BINDING_SHA256,
      message: "operation does not match",
    },
    {
      label: "engine",
      providerId: "mxc",
      operation: "sandbox-lifecycle" as const,
      engineId: "other",
      authorityId: `mxc-endpoint:${"2".repeat(64)}`,
      bindingSha256: BINDING_SHA256,
      message: "identity does not match",
    },
    {
      label: "endpoint authority",
      providerId: "mxc",
      operation: "sandbox-lifecycle" as const,
      engineId: "mxc",
      authorityId: `mxc-endpoint:${"3".repeat(64)}`,
      bindingSha256: BINDING_SHA256,
      message: "endpoint does not match",
    },
    {
      label: "binding",
      providerId: "mxc",
      operation: "sandbox-lifecycle" as const,
      engineId: "mxc",
      authorityId: `mxc-endpoint:${"2".repeat(64)}`,
      bindingSha256: "4".repeat(64),
      message: "binding does not match",
    },
  ])("fails closed when qualified $label differs", (candidate) => {
    const persisted = createPersistedEngineAuthority("mxc", engine(), BINDING_SHA256);
    const qualified = createContainerEngineCommand({
      operation: candidate.operation,
      engineId: candidate.engineId,
      displayName: "candidate",
      authorityId: candidate.authorityId,
      executable: "mxcctl",
      capture: () => ({ status: 0, stdout: "", stderr: "" }),
    });

    expect(() =>
      requirePersistedEngineAuthority(
        persisted,
        candidate.providerId,
        qualified,
        candidate.bindingSha256,
      ),
    ).toThrow(candidate.message);
  });

  it("rejects malformed, extended, and noncanonical records", () => {
    const authority = createPersistedEngineAuthority("mxc", engine(), BINDING_SHA256);
    expect(() => normalizePersistedEngineAuthority({ ...authority, extra: true })).toThrow(
      "schema is unsupported",
    );
    expect(() =>
      normalizePersistedEngineAuthority({ ...authority, authorityId: "not-an-authority" }),
    ).toThrow("endpoint authority identity is malformed");
    expect(() => parsePersistedEngineAuthority(JSON.stringify(authority))).toThrow("not canonical");
    expect(() =>
      parsePersistedEngineAuthority(`{\"value\":\"${"x".repeat(17 * 1024)}\"}\n`),
    ).toThrow("too large");
  });

  it("rejects a conflicting record for the same operation", () => {
    const store = createFilePersistedEngineAuthorityStore(temporaryRoot());
    const authority = createPersistedEngineAuthority("mxc", engine(), BINDING_SHA256);
    store.record(authority);

    expect(() =>
      store.record(
        createPersistedEngineAuthority(
          "mxc",
          engine("sandbox-lifecycle", `mxc-endpoint:${"5".repeat(64)}`),
          BINDING_SHA256,
        ),
      ),
    ).toThrow("already exists for 'sandbox-lifecycle'");
    expect(store.load("sandbox-lifecycle")).toEqual(authority);
  });

  it("rejects a symlink or shared-permission authority file", () => {
    const root = temporaryRoot();
    const store = createFilePersistedEngineAuthorityStore(root);
    const target = persistedEngineAuthorityPath(root, "sandbox-lifecycle");
    const outside = path.join(root, "outside.json");
    const authority = createPersistedEngineAuthority("mxc", engine(), BINDING_SHA256);
    fs.writeFileSync(outside, serializePersistedEngineAuthority(authority), { mode: 0o600 });
    fs.symlinkSync(outside, target);
    expect(() => store.load("sandbox-lifecycle")).toThrow("must not be a symbolic link");

    fs.unlinkSync(target);
    fs.writeFileSync(target, serializePersistedEngineAuthority(authority), { mode: 0o644 });
    fs.chmodSync(target, 0o644);
    expect(() => store.load("sandbox-lifecycle")).toThrow("failed ownership, mode, link, or size");
  });
});
