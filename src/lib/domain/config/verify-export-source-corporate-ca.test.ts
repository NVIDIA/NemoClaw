// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { LEAF_PEM, PEM, PRIVATE_KEY } from "../../onboard/__test-helpers__/corporate-ca-fixtures";
import type { ManagedStartupProfileBuilderInput } from "../../onboard/managed-startup/profile-builder";
import type { ObservedExportSnapshot } from "./export-evidence";
import {
  changeRetainedProfile,
  hermesProfileInput,
  hermesSnapshot,
  managedWorkload,
  profileInput,
  snapshot,
} from "./export-source-test-fixture";

function withCaTransport(observed: ObservedExportSnapshot, corporateCaB64: string | undefined) {
  return {
    ...observed,
    registry: {
      ...observed.registry,
      workload: { ...observed.registry.workload!, corporateCaB64 },
    },
  };
}

function withCorporateCa(
  observed = snapshot(),
  input: ManagedStartupProfileBuilderInput = profileInput(),
): ObservedExportSnapshot {
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
  ])("exports $agent without carrying corporate CA state into v1", async (fixture) => {
    const baseline = fixture.snapshot();
    const observed = withCorporateCa(baseline, fixture.profileInput());
    const original = structuredClone(observed);
    const withoutCa = await exportSnapshots([baseline]);
    const result = await exportSnapshots([observed]);

    expect(result.outcome).toEqual({ ok: true, completion: { kind: "stdout" } });
    expect(withoutCa.outcome.ok).toBe(true);
    expect(result.writeStdout).toHaveBeenCalledOnce();
    expect(result.writeStdout.mock.calls).toEqual(withoutCa.writeStdout.mock.calls);
    expect(observed).toEqual(original);
  });

  it.each([
    { label: "missing", encoded: undefined },
    { label: "invalid base64", encoded: "invalid-ca-canary" },
    { label: "mismatched digest", encoded: Buffer.from(PEM + PEM).toString("base64") },
  ])("rejects $label CA transport without publishing", async ({ encoded }) => {
    const result = await exportSnapshots([withCaTransport(withCorporateCa(), encoded)]);

    expect(result.outcome).toMatchObject({
      ok: false,
      failure: {
        kind: "observation",
        findings: [
          expect.objectContaining({ field: "source.workload", category: "missing-provenance" }),
        ],
      },
    });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
    expect(JSON.stringify(result.outcome)).not.toContain("invalid-ca-canary");
  });

  it.each([
    { label: "leaf certificate", pem: LEAF_PEM },
    { label: "private key", pem: PEM + PRIVATE_KEY },
  ])("rejects a $label even when its digest matches", async ({ pem }) => {
    const observed = changeRetainedProfile(withCorporateCa(), (profile) => {
      profile.corporateCa!.bundleSha256 = createHash("sha256").update(pem).digest("hex");
    });
    const result = await exportSnapshots([
      withCaTransport(observed, Buffer.from(pem).toString("base64")),
    ]);

    expect(result.outcome).toMatchObject({ ok: false, failure: { kind: "observation" } });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
    expect(JSON.stringify(result.outcome)).not.toContain(pem);
  });

  it("rejects a CA bundle when the profile declares no CA", async () => {
    const result = await exportSnapshots([
      withCaTransport(snapshot(), Buffer.from(PEM).toString("base64")),
    ]);

    expect(result.outcome).toMatchObject({ ok: false, failure: { kind: "observation" } });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });

  it("rejects unsupported profile settings alongside a valid CA", async () => {
    const observed = changeRetainedProfile(withCorporateCa(), (profile) => {
      profile.proxy!.hostNoProxy = ["internal.example"];
    });
    const result = await exportSnapshots([observed]);

    expect(result.outcome).toMatchObject({
      ok: false,
      failure: {
        kind: "observation",
        findings: [
          expect.objectContaining({
            field: "source.workload.startupProfile",
            category: "unsupported",
          }),
        ],
      },
    });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });

  it("rejects changing CA state even though v1 omits it", async () => {
    const observed = withCorporateCa();
    const result = await exportSnapshots([observed, snapshot(), observed, snapshot()]);

    expect(result.outcome).toMatchObject({
      ok: false,
      failure: {
        kind: "observation",
        findings: [expect.objectContaining({ category: "unstable-source" })],
      },
    });
    expect(result.read).toHaveBeenCalledTimes(4);
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });
});
