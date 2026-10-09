// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { nativeCompatibleSnapshot } from "../../domain/config/export-source-test-fixture";
import { exportSnapshots } from "../../actions/config/export-test-fixture";

type Snapshot = ReturnType<typeof nativeCompatibleSnapshot>;
describe("native compatible export evidence", () => {
  it.each(["openai-completions", "anthropic-messages"] as const)(
    "exports the selected %s endpoint from pinned attachment evidence",
    async (api) => {
      const result = await exportSnapshots([nativeCompatibleSnapshot(api)]);
      expect(result.outcome, JSON.stringify(result.outcome)).toMatchObject({ ok: true });
      expect(result.writeStdout.mock.calls[0]?.[0]).toContain(
        nativeCompatibleSnapshot(api).inference.endpoint,
      );
    },
  );
  it.each([
    [
      "attachment",
      (x: Snapshot) => {
        x.sandbox.providerNames = ["nc-compat-different-v1"];
      },
    ],
    [
      "profile",
      (x: Snapshot) => {
        x.inference.endpointEvidence.source.profileId = "nc-compat-different-v1";
      },
    ],
    [
      "endpoint",
      (x: Snapshot) => {
        x.inference.endpointEvidence.endpoint = "https://different.example/v1";
      },
    ],
    [
      "credential",
      (x: Snapshot) => {
        x.inference.credentialEnv = "OTHER_API_KEY";
      },
    ],
    [
      "provider",
      (x: Snapshot) => {
        x.inference.provider = "other-provider";
      },
    ],
  ] as const)("refuses export after %s drift", async (_label, mutate) => {
    const observed = nativeCompatibleSnapshot();
    mutate(observed);
    const result = await exportSnapshots([observed]);
    expect(result.outcome.ok).toBe(false);
    expect(result.writeStdout).not.toHaveBeenCalled();
  });
});
