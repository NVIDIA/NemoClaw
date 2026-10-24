// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { registeredInferenceFixture } from "../../../../test/helpers/registered-inference";
import {
  attachRegisteredInferenceProvider,
  detachRegisteredInferenceProvider,
  resolveRegisteredInferenceProvider,
  verifyRegisteredInferenceProviderAttachment,
} from "./registered";

describe("operator inference provider attachments", () => {
  it.each([false, true])(
    "preserves the provider while selecting an attachment (already attached: %s)",
    async (alreadyAttached) => {
      const f = registeredInferenceFixture(alreadyAttached);
      const selected = await attachRegisteredInferenceProvider({
        adapter: f.adapter,
        expected: f.binding,
      });
      expect(selected.changed).toBe(!alreadyAttached);
      expect(selected.attachment.attachedBySelection).toBe(!alreadyAttached);
      await verifyRegisteredInferenceProviderAttachment({
        adapter: f.adapter,
        expected: selected.attachment,
      });
      await detachRegisteredInferenceProvider({
        adapter: f.adapter,
        expected: selected.attachment,
      });
      expect(f.state.attached).toBe(alreadyAttached);
      expect(f.adapter.attachProvider).toHaveBeenCalledTimes(alreadyAttached ? 0 : 1);
      expect(f.adapter.detachProvider).toHaveBeenCalledTimes(alreadyAttached ? 0 : 1);
      expect(f.adapter.createProvider).not.toHaveBeenCalled();
      expect(f.adapter.updateProvider).not.toHaveBeenCalled();
      expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
      expect(f.adapter.importProviderProfile).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["provider identity", { providerId: "other-id" }],
    ["profile identity", { profileId: "other-profile" }],
    ["profile definition", { profileDigest: "b".repeat(64) }],
    ["destination", { endpointUrl: "https://unrelated.example/v1" }],
    ["credential environment", { credentialEnv: "UNRELATED_KEY" }],
    ["API authentication", { inferenceApi: "anthropic-messages" as const }],
  ])("rejects mismatched %s before attachment", async (_label, changed) => {
    const f = registeredInferenceFixture();
    await expect(
      attachRegisteredInferenceProvider({
        adapter: f.adapter,
        expected: { ...f.binding, ...changed },
      }),
    ).rejects.toThrow();
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
    expect(f.adapter.detachProvider).not.toHaveBeenCalled();
  });

  it("removes only the new attachment when the provider revision changes during attachment", async () => {
    const f = registeredInferenceFixture();
    f.adapter.attachProvider.mockImplementation(async () => {
      f.state.attached = true;
      f.state.revision++;
      return { ok: true };
    });
    await expect(
      attachRegisteredInferenceProvider({ adapter: f.adapter, expected: f.binding }),
    ).rejects.toThrow("changed during attachment");
    expect(f.adapter.detachProvider).toHaveBeenCalledOnce();
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(f.state.attached).toBe(false);
  });

  it("refuses to detach a replaced provider after attachment failure", async () => {
    const f = registeredInferenceFixture();
    f.adapter.attachProvider.mockImplementation(async () => {
      f.state.attached = true;
      f.state.id = "replacement";
      return { ok: true };
    });
    await expect(
      attachRegisteredInferenceProvider({ adapter: f.adapter, expected: f.binding }),
    ).rejects.toThrow("identity changed");
    expect(f.adapter.detachProvider).not.toHaveBeenCalled();
  });

  it("accepts credential rotation while retaining the immutable binding", async () => {
    const f = registeredInferenceFixture(true);
    f.state.revision++;
    await expect(
      resolveRegisteredInferenceProvider({ ...f.binding, adapter: f.adapter, previous: f.binding }),
    ).resolves.toEqual(f.binding);
  });
});

describe("registered provider profile authentication", () => {
  it("accepts a declared Anthropic header credential without changing the provider", async () => {
    const f = registeredInferenceFixture();
    f.profile.credentials[0]!.auth_style = "header";
    f.profile.credentials[0]!.header_name = "x-api-key";
    const binding = await resolveRegisteredInferenceProvider({
      ...f.binding,
      adapter: f.adapter,
      inferenceApi: "anthropic-messages",
    });
    await expect(
      attachRegisteredInferenceProvider({ adapter: f.adapter, expected: binding }),
    ).resolves.toMatchObject({ changed: true });
    expect(f.adapter.updateProvider).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN])(
    "rejects unavailable revision %s before attachment",
    async (revision) => {
      const f = registeredInferenceFixture();
      f.state.revision = revision;
      await expect(
        attachRegisteredInferenceProvider({ adapter: f.adapter, expected: f.binding }),
      ).rejects.toThrow();
      expect(f.adapter.attachProvider).not.toHaveBeenCalled();
    },
  );
});
