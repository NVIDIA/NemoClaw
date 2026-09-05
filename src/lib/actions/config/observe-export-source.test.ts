// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportSnapshotReader, RawExportSnapshot } from "../../domain/config/export-evidence";

const mocks = vi.hoisted(() => ({ verifyExportSource: vi.fn() }));

vi.mock("../../domain/config/verify-export-source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../domain/config/verify-export-source")>()),
  verifyExportSource: mocks.verifyExportSource,
}));

import { observeStableExportSource, qualifyEffectivePolicy } from "./observe-export-source";

const policy =
  "version: 1\nprocess:\n  run_as_user: sandbox\n  run_as_group: sandbox\nnetwork_policies:\n  api:\n    name: api\n    endpoints: [{host: api.example.com, port: 443}]\n    binaries: [{path: /usr/bin/curl}]\nfilesystem_policy:\n  include_workdir: false\n  read_only: [/usr]\n  read_write: [/sandbox]\n";

function missing(sandboxName: string): RawExportSnapshot {
  return { kind: "not-found", sandboxName };
}

function reader(
  sequence: readonly RawExportSnapshot[],
): ExportSnapshotReader & { read: ReturnType<typeof vi.fn> } {
  let call = 0;
  const read = vi.fn(async () => sequence[Math.min(call++, sequence.length - 1)]!);
  return { read };
}

function findings(result: Awaited<ReturnType<typeof observeStableExportSource>>) {
  return result.ok ? [] : result.findings;
}

function qualifiedPolicy(result: ReturnType<typeof qualifyEffectivePolicy>) {
  expect(result.kind).toBe("verified");
  return (result as Extract<typeof result, { kind: "verified" }>).canonical;
}

function observedPolicy(document: string) {
  return { sandboxId: "sandbox-id", revision: "3", document };
}

describe("stable config export source observation (#10938)", () => {
  beforeEach(() => {
    mocks.verifyExportSource.mockReset();
  });

  it("verifies two equal observed snapshots on the first attempt", async () => {
    const observed = {
      kind: "observed",
      sandboxName: "alpha",
      policy: { sandboxId: "sandbox-id", revision: "3", document: policy },
    } as unknown as RawExportSnapshot;
    const source = { sandboxName: "alpha" } as never;
    mocks.verifyExportSource.mockReturnValue({ kind: "verified", source });
    const sourceReader = reader([observed, observed]);

    await expect(observeStableExportSource("alpha", sourceReader)).resolves.toEqual({
      ok: true,
      source,
      attempts: 1,
    });
    expect(sourceReader.read).toHaveBeenCalledTimes(2);
    expect(mocks.verifyExportSource).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        kind: "observed",
        sandboxName: "alpha",
        policy: expect.objectContaining({
          kind: "verified",
          sandboxId: "sandbox-id",
          revision: "3",
        }),
      }),
    );
  });

  it("retries one structurally changed snapshot pair", async () => {
    const sourceReader = reader([
      missing("alpha"),
      missing("beta"),
      missing("alpha"),
      missing("alpha"),
    ]);

    await expect(observeStableExportSource("alpha", sourceReader)).resolves.toMatchObject({
      ok: false,
      attempts: 2,
      findings: [expect.objectContaining({ category: "not-found" })],
    });
    expect(sourceReader.read).toHaveBeenCalledTimes(4);
  });

  it("owns each read before an untrusted reader can mutate and reuse it", async () => {
    const shared = { kind: "not-found", sandboxName: "alpha" } as {
      kind: "not-found";
      sandboxName: string;
    };
    const stable = missing("alpha");
    const sourceReader = {
      read: vi
        .fn()
        .mockResolvedValueOnce(shared)
        .mockImplementationOnce(async () => {
          shared.sandboxName = "beta";
          return shared;
        })
        .mockResolvedValue(stable),
    };

    await expect(observeStableExportSource("alpha", sourceReader)).resolves.toMatchObject({
      ok: false,
      attempts: 2,
      findings: [expect.objectContaining({ category: "not-found" })],
    });
    expect(sourceReader.read).toHaveBeenCalledTimes(4);
  });

  it("returns unstable-source after two changed snapshot pairs", async () => {
    const result = await observeStableExportSource(
      "alpha",
      reader([missing("alpha"), missing("beta"), missing("gamma"), missing("delta")]),
    );

    expect(result).toMatchObject({ ok: false, attempts: 2 });
    expect(findings(result)).toContainEqual(
      expect.objectContaining({ category: "unstable-source" }),
    );
  });

  it("binds a not-found result to the requested name", async () => {
    const result = await observeStableExportSource(
      "alpha",
      reader([missing("beta"), missing("beta")]),
    );

    expect(findings(result)).toContainEqual(
      expect.objectContaining({
        field: "source.sandbox.name",
        category: "live-verification-failed",
      }),
    );
  });

  it("maps a typed concrete read failure to a controlled finding", async () => {
    const result = await observeStableExportSource(
      "alpha",
      reader([{ kind: "read-failed", stage: "provider-metadata" }]),
    );

    expect(result).toMatchObject({ ok: false, attempts: 1 });
    expect(findings(result)).toContainEqual(
      expect.objectContaining({
        field: "source.live",
        category: "live-verification-failed",
        diagnostic: "The live inference provider metadata could not be read or verified.",
      }),
    );
  });

  it("lets unexpected reader defects escape the observer", async () => {
    const sourceReader = {
      read: vi.fn(async () => {
        throw new Error("programmer-defect-canary");
      }),
    };

    await expect(observeStableExportSource("alpha", sourceReader)).rejects.toThrow(
      "programmer-defect-canary",
    );
  });

  it("canonicalizes policy independently of mapping insertion order", () => {
    const first = qualifiedPolicy(
      qualifyEffectivePolicy(
        observedPolicy(
          "version: 1\nnetwork_policies:\n  ä:\n    name: ä\n    endpoints: [{host: z.example.com, port: 443}]\n    binaries: [{path: /usr/bin/z}]\n  z:\n    name: z\n    endpoints: [{host: a.example.com, port: 443}]\n    binaries: [{path: /usr/bin/a}]\n",
        ),
      ),
    );
    const second = qualifiedPolicy(
      qualifyEffectivePolicy(
        observedPolicy(
          "network_policies:\n  z:\n    binaries: [{path: /usr/bin/a}]\n    endpoints: [{port: 443, host: a.example.com}]\n    name: z\n  ä:\n    binaries: [{path: /usr/bin/z}]\n    endpoints: [{port: 443, host: z.example.com}]\n    name: ä\nversion: 1\n",
        ),
      ),
    );

    expect(second).toEqual(first);
  });

  it("canonicalizes policy losslessly and rejects malformed policy", () => {
    expect(qualifiedPolicy(qualifyEffectivePolicy(observedPolicy(policy)))).toEqual({
      filesystem_policy: { include_workdir: false, read_only: ["/usr"], read_write: ["/sandbox"] },
      network_policies: {
        api: {
          binaries: [{ path: "/usr/bin/curl" }],
          endpoints: [{ host: "api.example.com", port: 443 }],
          name: "api",
        },
      },
      process: { run_as_group: "sandbox", run_as_user: "sandbox" },
      version: 1,
    });
    expect(qualifyEffectivePolicy(observedPolicy("network_policies: [not-a-map]"))).toEqual({
      kind: "not-representable",
      revision: "3",
      sandboxId: "sandbox-id",
    });
  });

  it("rejects credential-bearing policy without exposing its value", () => {
    const canary = "credential-canary-value";
    const result = qualifyEffectivePolicy(
      observedPolicy(`version: 1\nprocess:\n  password: ${canary}\nnetwork_policies: {}\n`),
    );

    expect(result).toEqual({
      kind: "not-representable",
      revision: "3",
      sandboxId: "sandbox-id",
    });
    expect(JSON.stringify(result)).not.toContain(canary);
  });
});
