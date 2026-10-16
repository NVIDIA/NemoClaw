// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { geminiSnapshot, verify } from "./export-source-test-fixture";

describe("Gemini config export (#12035)", () => {
  it("refuses a complete Gemini source before writing YAML (#12551)", async () => {
    const result = await exportSnapshots([geminiSnapshot()]);
    expect(result.outcome).toMatchObject({
      ok: false,
      failure: {
        kind: "observation",
        findings: expect.arrayContaining([
          expect.objectContaining({
            field: "spec.inferenceProviders[].provider",
            category: "unsupported",
            diagnostic: expect.stringContaining("V1 cannot consume this provider"),
          }),
        ]),
      },
    });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });

  it.each([
    ["credential reference", { credentialEnv: null }, "unsupported"],
    ["API", { api: "openai-responses" }, "unsupported"],
    ["endpoint", { endpoint: "https://other.example/v1" }, "drifted"],
  ])("rejects incorrect %s", (_name, change, category) => {
    const original = geminiSnapshot();
    const result = verify({ ...original, inference: { ...original.inference, ...change } });
    expect(result).toMatchObject({
      kind: "rejected",
      findings: expect.arrayContaining([expect.objectContaining({ category })]),
    });
  });

  it("refuses route drift before writing YAML", async () => {
    const original = geminiSnapshot();
    const changed = { ...original, registry: { ...original.registry, model: "other-model" } };
    const result = await exportSnapshots([changed]);
    expect(result.outcome).toMatchObject({ ok: false, failure: { kind: "observation" } });
    expect(result.writeStdout).not.toHaveBeenCalled();
  });

  it("refuses an unsafe endpoint without writing YAML", async () => {
    const original = geminiSnapshot();
    const endpoint =
      "https://user:credential-canary-value@generativelanguage.googleapis.com/v1beta/openai/";
    const changed = {
      ...original,
      registry: { ...original.registry, endpointUrl: endpoint },
      inference: {
        ...original.inference,
        endpoint,
        endpointEvidence: { ...original.inference.endpointEvidence!, endpoint },
      },
    };
    const result = await exportSnapshots([changed]);
    expect(result.outcome).toMatchObject({ ok: false, failure: { kind: "observation" } });
    expect(JSON.stringify(result.outcome)).not.toContain("credential-canary-value");
    expect(result.writeStdout).not.toHaveBeenCalled();
  });

  it("refuses a credential value without writing it (#12035)", async () => {
    const original = geminiSnapshot();
    const changed = {
      ...original,
      registry: { ...original.registry, credentialEnv: "credential-canary-value" },
      inference: { ...original.inference, credentialEnv: "credential-canary-value" },
    };
    const result = await exportSnapshots([changed]);
    expect(result.outcome).toMatchObject({ ok: false, failure: { kind: "observation" } });
    expect(JSON.stringify(result.outcome)).not.toContain("credential-canary-value");
    expect(result.writeStdout).not.toHaveBeenCalled();
  });
});
