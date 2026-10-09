// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { expectNoSandboxDelete } from "../../../../test/helpers/rebuild-delete-assertions";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../../../../test/helpers/rebuild-flow-generic-harness";
import {
  rebuildCustomImagePreflight,
  rebuildProviderPreflight,
} from "../../../../test/helpers/rebuild-flow-harness";
import type { preflightRebuildImage } from "./rebuild-custom-image-preflight";
import type { HostCredentialTarget } from "./rebuild-provider-preflight";

function createRemoteRebuildHarness() {
  const selection = {
    provider: "compatible-endpoint",
    model: "test/model",
    credentialEnv: "COMPATIBLE_API_KEY",
    endpointUrl: "https://inference.example.test/v1",
  };
  const harness = createRebuildFlowHarness({
    sandboxEntry: selection,
    hydrateCredentialEnv: (name) => (name === selection.credentialEnv ? "host-provider-key" : null),
    runOpenshell: (args) => {
      const stdout =
        args[1] === "list"
          ? JSON.stringify([
              { name: selection.provider, credential_keys: [selection.credentialEnv] },
            ])
          : [
              `Name: ${selection.provider}`,
              "Type: openai",
              `Credential keys: ${selection.credentialEnv}`,
              "Config keys: OPENAI_BASE_URL",
            ].join("\n");
      return args[0] === "provider" ? { status: 0, stdout, output: stdout, stderr: "" } : undefined;
    },
  });
  Object.assign(harness.session, {
    sandboxName: "alpha",
    ...selection,
    preferredInferenceApi: "openai-responses",
  });
  return harness;
}

describe("rebuildSandbox flow: host credential target", () => {
  installRebuildFlowTestHooks();

  it("rebuilds a legacy row with the inference API recovered from its matching session", async () => {
    const harness = createRemoteRebuildHarness();
    const validate = vi.mocked(rebuildProviderPreflight.validateRebuildHostInferenceCredential);
    validate.mockImplementation(
      async (target: HostCredentialTarget) => target.preferredInferenceApi === "openai-responses",
    );

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
    expect(harness.onboardSpy).toHaveBeenCalledOnce();
    expect(harness.session.preferredInferenceApi).toBe("openai-responses");
    expect(validate).toHaveBeenCalledWith(
      expect.objectContaining({ preferredInferenceApi: "openai-responses" }),
      "host-provider-key",
    );
  });

  it.each([
    ["ordinary", ["--yes"]],
    ["forced", ["--yes", "--force"]],
  ])(
    "rejects a credential revoked during image preparation before backup for a %s rebuild",
    async (_mode, flags) => {
      const harness = createRemoteRebuildHarness();
      let credentialAccepted = true;
      vi.mocked(rebuildProviderPreflight.validateRebuildHostInferenceCredential).mockImplementation(
        async () => credentialAccepted,
      );
      const prepareImage = vi.mocked(rebuildCustomImagePreflight.preflightRebuildImage);
      const originalPrepareImage = prepareImage.getMockImplementation()!;
      prepareImage.mockImplementation(async (...args: Parameters<typeof preflightRebuildImage>) => {
        const prepared = await originalPrepareImage(...args);
        credentialAccepted = false;
        return prepared;
      });

      await expect(harness.rebuildSandbox("alpha", flags, { throwOnError: true })).rejects.toThrow(
        "Host inference credential validation failed",
      );

      expect(prepareImage).toHaveBeenCalledOnce();
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expectNoSandboxDelete(harness.runOpenshellSpy);
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    },
  );
});
