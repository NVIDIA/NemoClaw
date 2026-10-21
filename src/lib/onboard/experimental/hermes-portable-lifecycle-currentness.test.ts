// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadAgent } from "../../agent/defs";
import { withMcpLifecycleLock } from "../../state/mcp-lifecycle-lock";
import { publishHermesPortableSuccessorReceipt } from "./hermes-portable-receipt";
import {
  assertHermesPortableAgentLifecycleAuthority,
  HermesPortableLifecycleAuthorityError,
  qualifyPortableAgentLifecycleAuthority,
} from "./portable-agent-lifecycle";
import {
  createHermesPortableLifecycleTestReceipt,
  createHermesPortableLifecycleTestDeps,
  SANDBOX,
  GATEWAY,
  GENERATION,
  CONTAINER_ID,
  IMAGE,
  SANDBOX_ID,
  POLICY,
  LABELS,
} from "./hermes-portable-lifecycle.test-fixture";

import { hermesPortableLifecycleInternals } from "./hermes-portable-lifecycle";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    path: "/state/active.json",
    identity: { dev: 1n, ino: 2n },
    sha256: "a".repeat(64),
    bytes: Buffer.from("active"),
    receipt: { policy: { intendedSemanticSha256: "b".repeat(64) } },
    successor: {
      path: "/state/authority.json",
      identity: { dev: 1n, ino: 3n },
      sha256: "c".repeat(64),
      bytes: Buffer.from("authority"),
    },
    ...overrides,
  };
}

describe("Hermes portable requalified authority currentness", () => {
  it("retains the exact receipt and operation-local authority generation", () => {
    const published = snapshot();
    const assertOperatingAuthority = vi.fn();
    const assertCurrent = hermesPortableLifecycleInternals.retainRequalifiedOperatingAuthority(
      "alpha",
      "/state",
      published as never,
      assertOperatingAuthority,
      vi.fn(() => published) as never,
    );

    expect(() => assertCurrent()).not.toThrow();
    expect(assertOperatingAuthority).toHaveBeenCalledOnce();
  });

  it("rejects receipt replacement before checking operation-local authority", () => {
    const published = snapshot();
    const assertOperatingAuthority = vi.fn();
    const assertCurrent = hermesPortableLifecycleInternals.retainRequalifiedOperatingAuthority(
      "alpha",
      "/state",
      published as never,
      assertOperatingAuthority,
      vi.fn(() => snapshot({ identity: { dev: 1n, ino: 4n } })) as never,
    );

    expect(() => assertCurrent()).toThrow(
      "receipt authority changed after schema-6 requalification",
    );
    expect(assertOperatingAuthority).not.toHaveBeenCalled();
  });

  it("rejects same-content successor inode replacement", () => {
    const published = snapshot();
    const assertOperatingAuthority = vi.fn();
    const replacement = snapshot({
      successor: {
        path: "/state/authority.json",
        identity: { dev: 1n, ino: 4n },
        sha256: "c".repeat(64),
        bytes: Buffer.from("authority"),
      },
    });
    const assertCurrent = hermesPortableLifecycleInternals.retainRequalifiedOperatingAuthority(
      "alpha",
      "/state",
      published as never,
      assertOperatingAuthority,
      vi.fn(() => replacement) as never,
    );

    expect(() => assertCurrent()).toThrow(
      "receipt authority changed after schema-6 requalification",
    );
    expect(assertOperatingAuthority).not.toHaveBeenCalled();
  });

  it("propagates socket or executable drift after the receipt remains current", () => {
    const published = snapshot();
    const assertOperatingAuthority = vi.fn(() => {
      throw new Error("operation-local filesystem or runtime identity changed");
    });
    const assertCurrent = hermesPortableLifecycleInternals.retainRequalifiedOperatingAuthority(
      "alpha",
      "/state",
      published as never,
      assertOperatingAuthority,
      vi.fn(() => published) as never,
    );

    expect(() => assertCurrent()).toThrow("operation-local filesystem or runtime identity changed");
  });
});

describe("Hermes portable registry authority", () => {
  it.each(["0.0.115", undefined])(
    "classifies OpenShell version %s as an authority failure",
    async (openshellVersion) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-authority-"));
      try {
        const policyPath = path.join(stateDir, "policy.yaml");
        fs.writeFileSync(policyPath, POLICY, { mode: 0o600 });
        const receipt = createHermesPortableLifecycleTestReceipt({
          agent: loadAgent("hermes"),
          stateDir,
          policyPath,
          homeDir: "/home/test",
          sandboxName: SANDBOX,
          gatewayName: GATEWAY,
          lifecycleGeneration: GENERATION,
          containerId: CONTAINER_ID,
          imageDigest: IMAGE,
          sandboxId: SANDBOX_ID,
          labels: LABELS,
        });
        const lockOptions = { stateDir: path.join(stateDir, "state") };
        await withMcpLifecycleLock(
          SANDBOX,
          () => publishHermesPortableSuccessorReceipt(SANDBOX, stateDir),
          lockOptions,
        );
        const fixture = createHermesPortableLifecycleTestDeps(stateDir, receipt, true, {
          registry: { openshellVersion },
        });
        const authority = qualifyPortableAgentLifecycleAuthority(SANDBOX, fixture.deps);
        expect(authority.kind).toBe("hermes");
        const entry = fixture.deps.readRegistry();
        const operation = withMcpLifecycleLock(
          SANDBOX,
          () =>
            assertHermesPortableAgentLifecycleAuthority(
              SANDBOX,
              {
                agent: entry.agent,
                gatewayName: GATEWAY,
                lifecycleGeneration: entry.lifecycleGeneration,
                openshellDriver: entry.openshellDriver,
                provider: entry.provider,
              },
              fixture.deps,
            ),
          lockOptions,
        );
        await expect(operation).rejects.toBeInstanceOf(HermesPortableLifecycleAuthorityError);
        await expect(operation).rejects.toMatchObject({ reason: "receipt-registry-disagreement" });
        expect(fixture.launchOpenShell).not.toHaveBeenCalled();
        expect(fixture.podman).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );
});
