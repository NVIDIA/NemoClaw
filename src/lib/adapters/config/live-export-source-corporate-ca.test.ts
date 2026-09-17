// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  raw,
  mockSupportedLiveSource,
  exportLiveSource,
} from "../../../../test/support/config-export-harness";
import { describe, expect, it, vi } from "vitest";
import { PEM } from "../../onboard/__test-helpers__/corporate-ca-fixtures";
import { buildManagedStartupProfile } from "../../onboard/managed-startup/profile-builder";
import { entry, provider, startupInput } from "./live-export-source-test-fixture";

describe("corporate CA export observation", () => {
  it("omits valid retained CA trust without reading credentials or changing the source", async () => {
    mockSupportedLiveSource();
    const baseline = await exportLiveSource();
    expect(baseline.result.ok).toBe(true);

    const built = buildManagedStartupProfile({
      ...startupInput,
      corporateCa: {
        pem: PEM,
        sourcePath: "/host/corporate-ca.pem",
        sourceEnv: "NEMOCLAW_CORPORATE_CA_BUNDLE",
      },
    });
    const source = {
      ...entry,
      workload: {
        ...entry.workload,
        encodedProfile: built.encodedProfile,
        startupProfileSha256: built.startupProfileSha256,
        corporateCaB64: built.corporateCaB64,
      },
    };
    const original = structuredClone(source);
    mockSupportedLiveSource(3, 3, source);
    const readCredential = vi.fn(() => {
      throw new Error("credential-canary-value");
    });
    const liveProvider = provider();
    Object.defineProperty(liveProvider.provider.credentials, "NVIDIA_INFERENCE_API_KEY", {
      enumerable: true,
      get: readCredential,
    });
    raw.getProvider.mockResolvedValue(liveProvider);

    const exported = await exportLiveSource();

    expect(exported.result).toEqual({ ok: true, completion: { kind: "stdout" } });
    expect(exported.writeStdout.mock.calls).toEqual(baseline.writeStdout.mock.calls);
    expect(exported.writeStdout.mock.calls[0]![0]).not.toMatch(
      /corporateCa|BEGIN CERTIFICATE|credential-canary-value/u,
    );
    expect(readCredential).not.toHaveBeenCalled();
    expect(exported.publish).not.toHaveBeenCalled();
    expect(source).toEqual(original);
  });
});
