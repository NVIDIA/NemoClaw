// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { V1ALPHA1_RUNTIME_DEFAULTS_REVISION } from "./v1alpha1-runtime-defaults";
import { validateConfigExportWithPinnedV1 } from "../../../../test/support/v1-config-consumer";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
import { geminiSnapshot, verify } from "./export-source-test-fixture";

describe("Gemini config export (#12035)", () => {
  it("exports verified OpenClaw Gemini without a credential value", async () => {
    const result = await exportSnapshots([geminiSnapshot()]);
    expect(result.outcome).toMatchObject({
      ok: true,
      completion: { kind: "stdout", v1Support: "pending" },
    });
    const raw = String(result.writeStdout.mock.calls[0]?.[0]);
    const fixture = readFileSync(
      new URL("../../../../test/fixtures/v1-config-consumer/pending-gemini.yaml", import.meta.url),
      "utf8",
    );
    expect(raw).toBe(fixture);
    expect(YAML.parse(raw)).toMatchObject({
      spec: {
        inferenceProviders: [
          {
            provider: "google",
            api: "openai-completions",
            endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/",
            credential: { env: "GEMINI_API_KEY" },
          },
        ],
        sandboxes: [
          { agent: { inference: { routes: [{ overrides: { model: "gemini-3.6-flash" } }] } } },
        ],
      },
    });
    expect(raw).not.toContain("credential-canary-value");
  });

  it.runIf(process.env.NEMOCLAW_RUN_V1_CONFIG_COMPATIBILITY === "1")(
    "records pending V1 validation at the pinned revision (#12035)",
    testTimeoutOptions(12 * 60_000),
    () => {
      const fixture = readFileSync(
        new URL(
          "../../../../test/fixtures/v1-config-consumer/pending-gemini.yaml",
          import.meta.url,
        ),
        "utf8",
      );
      expect(V1ALPHA1_RUNTIME_DEFAULTS_REVISION).toBe("88c6600c06b0937907290362eef86912052c4ad0");
      expect(() => validateConfigExportWithPinnedV1(fixture)).toThrow(
        /provider requires a lowercase name and openai or anthropic implementation/u,
      );
    },
  );

  it.each([
    ["credential reference", { credentialEnv: null }, "missing-provenance"],
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
