// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { PodmanBoundContainerEngine } from "../../../src/lib/adapters/podman/index.ts";
import { nativeRuntimeQualificationCaseInternals } from "../live/native-runtime-qualification-case-executor.ts";

const NETWORK_ID = "a".repeat(64);
const NETWORK_NAME = "nemoclaw-q-0123456789ab";
const CASE_ID = "podman-openclaw-linux-amd64-cpu-ollama";
const QUALIFICATION_LABEL = "ai.nvidia.nemoclaw.qualification";

function inspection(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      id: NETWORK_ID,
      labels: { [QUALIFICATION_LABEL]: CASE_ID },
      name: NETWORK_NAME,
      subnets: [{ gateway: "10.89.0.1" }],
      ...overrides,
    },
  ]);
}

type EngineOutput =
  | string
  | { readonly status: number; readonly stdout?: string; readonly stderr?: string };

function engine(outputs: readonly EngineOutput[]): {
  readonly capture: ReturnType<typeof vi.fn>;
  readonly value: PodmanBoundContainerEngine;
} {
  let index = 0;
  const capture = vi.fn((args: readonly string[]) => {
    const output = outputs[index++];
    return typeof output === "object"
      ? { status: output.status, stdout: output.stdout ?? "", stderr: output.stderr ?? "" }
      : {
          status: output === undefined && args[0] === "network" && args[1] === "exists" ? 1 : 0,
          stdout: output ?? "",
          stderr: "",
        };
  });
  return {
    capture,
    value: {
      operation: "host-local-inference",
      engineId: "podman",
      displayName: "Podman",
      authorityId: `podman-sha256:${"b".repeat(64)}`,
      endpointAuthorityId: `podman-sha256:${"c".repeat(64)}`,
      capture,
      captureHost: vi.fn(),
      assertAuthority: vi.fn(),
    } as unknown as PodmanBoundContainerEngine,
  };
}

describe("native runtime provider-network authority", () => {
  it("resolves Podman 6.1 name output to one immutable labeled network ID", () => {
    const runtime = engine([NETWORK_NAME, inspection(), inspection()]);

    expect(
      nativeRuntimeQualificationCaseInternals.createProviderNetwork(
        runtime.value,
        NETWORK_NAME,
        CASE_ID,
      ),
    ).toEqual({ id: NETWORK_ID, name: NETWORK_NAME, gateway: "10.89.0.1" });
    expect(runtime.capture.mock.calls.map(([args]) => args)).toEqual([
      ["network", "create", "--label", `${QUALIFICATION_LABEL}=${CASE_ID}`, NETWORK_NAME],
      ["network", "inspect", NETWORK_NAME],
      ["network", "inspect", NETWORK_ID],
    ]);
  });

  it("also binds an implementation that returns the immutable network ID", () => {
    const runtime = engine([NETWORK_ID, inspection(), inspection()]);

    expect(
      nativeRuntimeQualificationCaseInternals.createProviderNetwork(
        runtime.value,
        NETWORK_NAME,
        CASE_ID,
      ).id,
    ).toBe(NETWORK_ID);
  });

  it("rejects creation output outside the requested name or immutable-ID forms", () => {
    const runtime = engine(["unexpected-network"]);

    expect(() =>
      nativeRuntimeQualificationCaseInternals.createProviderNetwork(
        runtime.value,
        NETWORK_NAME,
        CASE_ID,
      ),
    ).toThrow("Provider network creation returned an unexpected identity");
    expect(runtime.capture.mock.calls.map(([args]) => args)).toEqual([
      ["network", "create", "--label", `${QUALIFICATION_LABEL}=${CASE_ID}`, NETWORK_NAME],
      ["network", "rm", "--force", NETWORK_NAME],
      ["network", "exists", NETWORK_NAME],
    ]);
  });

  it("rejects label or immutable re-inspection drift", () => {
    const missingLabel = engine([NETWORK_NAME, inspection({ labels: {} }), inspection()]);
    expect(() =>
      nativeRuntimeQualificationCaseInternals.createProviderNetwork(
        missingLabel.value,
        NETWORK_NAME,
        CASE_ID,
      ),
    ).toThrow("Provider network inspection lacks exact identity");

    const changedGateway = engine([
      NETWORK_NAME,
      inspection(),
      inspection({ subnets: [{ gateway: "10.90.0.1" }] }),
    ]);
    expect(() =>
      nativeRuntimeQualificationCaseInternals.createProviderNetwork(
        changedGateway.value,
        NETWORK_NAME,
        CASE_ID,
      ),
    ).toThrow("Provider network identity changed after immutable-ID resolution");
    expect(changedGateway.capture).toHaveBeenNthCalledWith(
      4,
      ["network", "rm", "--force", NETWORK_NAME],
      60_000,
    );
    expect(changedGateway.capture).toHaveBeenLastCalledWith(
      ["network", "exists", NETWORK_NAME],
      60_000,
    );
  });

  it("reports validation and cleanup together when network removal cannot be proven", () => {
    const runtime = engine([
      "unexpected-network",
      { status: 1, stderr: "remove failed" },
      { status: 0 },
    ]);

    expect(() =>
      nativeRuntimeQualificationCaseInternals.createProviderNetwork(
        runtime.value,
        NETWORK_NAME,
        CASE_ID,
      ),
    ).toThrow(
      "Provider network creation returned an unexpected identity; provider network cleanup could not prove removal (remove exit 1; exists exit 0)",
    );
    expect(runtime.capture.mock.calls.map(([args]) => args)).toEqual([
      ["network", "create", "--label", `${QUALIFICATION_LABEL}=${CASE_ID}`, NETWORK_NAME],
      ["network", "rm", "--force", NETWORK_NAME],
      ["network", "exists", NETWORK_NAME],
    ]);
  });

  it("removes an exported snapshot without replacing the case failure", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-runtime-snapshot-cleanup-"));
    const snapshot = path.join(root, "nemoclaw-q-fixture.tar");
    const original = new Error("failure after export");
    fs.writeFileSync(snapshot, "snapshot");

    const failAfterExport = () => {
      try {
        throw original;
      } finally {
        nativeRuntimeQualificationCaseInternals.removeQualificationSnapshot(snapshot);
      }
    };

    expect(failAfterExport).toThrow(original);
    expect(fs.existsSync(snapshot)).toBe(false);
    fs.rmSync(root, { force: true, recursive: true });
  });
});
