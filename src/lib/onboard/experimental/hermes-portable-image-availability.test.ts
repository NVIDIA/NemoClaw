// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  createHermesPortableTestInput,
  createHermesPortableTransactionFixture,
  HERMES_PORTABLE_TEST_POLICY,
} from "../../../../test/helpers/hermes-portable-onboarding-fixture";
import { runHermesPortableOnboardingTransaction } from "./hermes-portable-onboarding";

let stateDir: string;
let policyPath: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-image-availability-"));
  policyPath = path.join(stateDir, "create.yaml");
  fs.writeFileSync(policyPath, HERMES_PORTABLE_TEST_POLICY, { mode: 0o600 });
});

afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }));

it("negotiates OCI and Docker manifests when verifying the published image", async () => {
  const input = createHermesPortableTestInput(stateDir, policyPath);
  const fixture = createHermesPortableTransactionFixture(input);
  const { imageAvailable: _imageAvailable, ...withoutImageOverride } = fixture.value;
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 200 }));
  try {
    await expect(
      runHermesPortableOnboardingTransaction(input, withoutImageOverride),
    ).resolves.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/nemoclaw-sandbox-local\/manifests\/[a-f0-9-]+$/u),
      expect.objectContaining({
        method: "HEAD",
        headers: expect.objectContaining({
          Accept: expect.stringContaining("application/vnd.oci.image.manifest.v1+json"),
        }),
      }),
    );
  } finally {
    fetchSpy.mockRestore();
  }
});
