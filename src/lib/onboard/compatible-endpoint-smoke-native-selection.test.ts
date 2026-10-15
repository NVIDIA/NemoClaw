// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeLocalIdentity, type NativeLocalBinding } from "../inference/native-local/contract";
import * as profile from "../inference/native-local/profile";
import {
  createCompatibleEndpointSmoke,
  verifyCompatibleEndpointSandboxSmoke,
} from "./compatible-endpoint-smoke";

const binding: NativeLocalBinding = {
  provider: "vllm-local",
  endpointUrl: "http://host.openshell.internal:8000/v1",
  gatewayName: "selected",
  sandboxName: "alice",
  credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  authMode: "authenticated",
};
const receipt = {
  ...binding,
  ...nativeLocalIdentity(binding),
  schemaVersion: 1 as const,
  providerId: "owned",
};
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const verification = vi
    .spyOn(profile, "verifyNativeLocalProviderAttachment")
    .mockRejectedValue(new Error("attachment proof attempted"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  const runOpenshell = vi.fn();
  const executor = { runBuffered: vi.fn() };
  const smoke = createCompatibleEndpointSmoke(
    runOpenshell,
    executor,
    (value) => value,
    () => ({ name: "alice", provider: "vllm-local", nativeLocalProviderAttachment: receipt }),
  );
  return { smoke, verification, runOpenshell, executor };
}

describe("native-local smoke selection", () => {
  it.each(["onboard", "rebuild"])(
    "rejects a mismatched provider during %s before verification",
    async (flow) => {
      const { smoke, verification, runOpenshell, executor } = fixture();
      const selection = { sandboxName: "alice", provider: "llama-cpp-local", model: "model-a" };
      await expect(async () =>
        flow === "onboard"
          ? smoke.verify(selection)
          : smoke.verifyRebuilt({ ...selection, environment: {} }),
      ).rejects.toThrow("does not match the selected provider");
      expect(verification).not.toHaveBeenCalled();
      expect(runOpenshell).not.toHaveBeenCalled();
      expect(executor.runBuffered).not.toHaveBeenCalled();
    },
  );

  it("rejects a mismatched provider for direct smoke callers before verification", async () => {
    const { verification, runOpenshell, executor } = fixture();
    await expect(
      verifyCompatibleEndpointSandboxSmoke({
        sandboxName: "alice",
        provider: "llama-cpp-local",
        model: "model-a",
        nativeLocalProviderAttachment: receipt,
        runOpenshell,
        sandboxCommandExecutor: executor,
        redact: (value) => value,
      }),
    ).rejects.toThrow("does not match the selected provider");
    expect(verification).not.toHaveBeenCalled();
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(executor.runBuffered).not.toHaveBeenCalled();
  });

  it("requires attachment verification for a matching provider", async () => {
    const { smoke, verification } = fixture();
    await expect(
      smoke.verify({ sandboxName: "alice", provider: "vllm-local", model: "model-a" }),
    ).rejects.toThrow("attachment proof attempted");
    expect(verification).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ expected: receipt }),
    );
  });
});
