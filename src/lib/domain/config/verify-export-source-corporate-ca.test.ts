// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { PEM } from "../../onboard/__test-helpers__/corporate-ca-fixtures";
import type { ManagedStartupProfileBuilderInput } from "../../onboard/managed-startup/profile-builder";
import {
  hermesProfileInput,
  hermesSnapshot,
  managedWorkload,
  profileInput,
  snapshot,
} from "./export-source-test-fixture";

function withCorporateCa(
  observed = snapshot(),
  input: ManagedStartupProfileBuilderInput = profileInput(),
) {
  const workload = managedWorkload(
    {
      ...input,
      corporateCa: {
        pem: PEM,
        sourcePath: "/host/corporate-ca.pem",
        sourceEnv: "NEMOCLAW_CORPORATE_CA_BUNDLE",
      },
    },
    observed.sandbox.imageRef,
  );
  return { ...observed, registry: { ...observed.registry, workload } };
}

describe("config export with corporate CA trust", () => {
  it.each([
    { agent: "OpenClaw", snapshot, profileInput },
    { agent: "Hermes", snapshot: hermesSnapshot, profileInput: hermesProfileInput },
  ])("reports omitted corporate CA without changing $agent YAML (#12146)", async (fixture) => {
    const baseline = fixture.snapshot();
    const observed = withCorporateCa(baseline, fixture.profileInput());
    const original = structuredClone(observed);
    const withoutCa = await exportSnapshots([baseline]);
    const result = await exportSnapshots([observed]);

    expect(result.outcome).toEqual({
      ok: true,
      completion: { kind: "stdout" },
      corporateCaOmitted: true,
    });
    expect(withoutCa.outcome).toEqual({ ok: true, completion: { kind: "stdout" } });
    expect(result.writeStdout).toHaveBeenCalledOnce();
    expect(result.writeStdout.mock.calls).toEqual(withoutCa.writeStdout.mock.calls);
    expect(observed).toEqual(original);
  });

  it.each([false, true])(
    "reports only the stable CA omission after a changed snapshot pair: %s (#12146)",
    async (retainedCa) => {
      const plain = snapshot();
      const withCa = withCorporateCa(plain);
      const stable = retainedCa ? withCa : plain;
      const changed = retainedCa ? plain : withCa;
      const baseline = await exportSnapshots([stable]);
      const result = await exportSnapshots([changed, stable, stable, stable]);

      expect(result.read).toHaveBeenCalledTimes(4);
      expect(result.outcome).toEqual(baseline.outcome);
      expect(result.writeStdout.mock.calls).toEqual(baseline.writeStdout.mock.calls);
    },
  );

  it("withholds the CA omission report when both snapshot pairs change (#12146)", async () => {
    const plain = snapshot();
    const withCa = withCorporateCa(plain);
    const result = await exportSnapshots([withCa, plain, withCa, plain]);

    expect(result.outcome).toMatchObject({
      ok: false,
      failure: {
        kind: "observation",
        attempts: 2,
        findings: [expect.objectContaining({ category: "unstable-source" })],
      },
    });
    expect(result.outcome).not.toHaveProperty("corporateCaOmitted");
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });

  it("rejects a mismatched CA digest before publication", async () => {
    const observed = withCorporateCa();
    const result = await exportSnapshots([
      {
        ...observed,
        registry: {
          ...observed.registry,
          workload: {
            ...observed.registry.workload,
            corporateCaB64: Buffer.from(PEM + PEM).toString("base64"),
          },
        },
      },
    ]);

    expect(result.outcome).toMatchObject({
      ok: false,
      failure: {
        kind: "observation",
        findings: [
          expect.objectContaining({ field: "source.workload", category: "missing-provenance" }),
        ],
      },
    });
    expect(result.outcome).not.toHaveProperty("corporateCaOmitted");
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });
});
