// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { readVerifiedRegisteredCredentialHandle } from "../../actions/inference-set/registered";
import { inspectInferenceProviderProfile } from "../../adapters/openshell/provider-profile";
import { registeredInferenceFixture } from "../../../../test/helpers/registered-inference";
import {
  attachRegisteredInferenceProvider,
  detachRegisteredInferenceProvider,
  recordedRegisteredInferenceProviderAttachment,
  registeredInferenceProviderRevision,
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
  it.each([
    ["**.example", "deep.api.example"],
    ["api.*.example", "api.internal.example"],
    ["*-api.example", "tenant-api.example"],
    ["api?.example", "api1.example"],
    ["api[0-9].example", "api1.example"],
    ["api[!a-z].example", "api1.example"],
  ])("rejects unsafe policy at matching host pattern %s", async (pattern, host) => {
    const f = registeredInferenceFixture();
    f.profile.endpoints[0]!.host = host;
    f.profile.endpoints.push({ ...f.profile.endpoints[0]!, host: pattern, enforcement: "audit" });
    await expect(
      resolveRegisteredInferenceProvider({
        ...f.binding,
        endpointUrl: `https://${host}/v1`,
        adapter: f.adapter,
      }),
    ).rejects.toThrow("enforced REST policy");
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
  });

  it("rejects unsafe policy whose port list includes the selected port", async () => {
    const f = registeredInferenceFixture();
    f.profile.endpoints.push({
      ...f.profile.endpoints[0]!,
      port: 8443,
      enforcement: "audit",
      ...{ ports: [443] },
    });
    await expect(
      resolveRegisteredInferenceProvider({ ...f.binding, adapter: f.adapter }),
    ).rejects.toThrow("enforced REST policy");
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
  });

  it("ignores unsafe policy whose port list excludes the selected port", async () => {
    const f = registeredInferenceFixture();
    f.profile.endpoints.push({
      ...f.profile.endpoints[0]!,
      enforcement: "audit",
      ...{ ports: [8443] },
    });
    await expect(
      resolveRegisteredInferenceProvider({ ...f.binding, adapter: f.adapter }),
    ).resolves.toMatchObject({ providerName: f.binding.providerName });
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
  });

  it("accepts a declared port list without a singular port", async () => {
    const f = registeredInferenceFixture();
    Object.assign(f.profile.endpoints[0]!, { port: undefined, ports: [443] });
    const binding = await resolveRegisteredInferenceProvider({ ...f.binding, adapter: f.adapter });
    const selected = await attachRegisteredInferenceProvider({
      adapter: f.adapter,
      expected: binding,
    });
    await expect(
      detachRegisteredInferenceProvider({ adapter: f.adapter, expected: selected.attachment }),
    ).resolves.toBe(true);
  });

  it("retains owned cleanup for a legacy singular-port binding", async () => {
    const f = registeredInferenceFixture(true);
    Object.assign(f.profile.endpoints[0]!, { ports: [8443] });
    const binding = {
      ...f.binding,
      attachedBySelection: true,
      profileDigest: inspectInferenceProviderProfile(JSON.stringify(f.profile))!.digest,
    };
    await expect(
      attachRegisteredInferenceProvider({ adapter: f.adapter, expected: binding }),
    ).rejects.toThrow("enforced REST policy");
    await expect(
      detachRegisteredInferenceProvider({ adapter: f.adapter, expected: binding }),
    ).resolves.toBe(true);
  });

  it.each([
    ["audit policy", { enforcement: "audit" }],
    ["omitted enforcement", { enforcement: undefined }],
    ["empty enforcement", { enforcement: "" }],
    ["skipped TLS inspection", { tls: "skip" }],
    ["invalid TLS mode", { tls: null }],
    ["uninspected credentials", { allow_uninspected_credentials: true }],
    ["invalid credential inspection flag", { allow_uninspected_credentials: "false" }],
    ["TCP transport", { protocol: "tcp" }],
    ["omitted protocol", { protocol: undefined }],
  ])("rejects %s before active use while permitting owned detach", async (_label, fields) => {
    const f = registeredInferenceFixture(true);
    Object.assign(f.profile.endpoints[0]!, fields);
    const binding = {
      ...f.binding,
      profileDigest: inspectInferenceProviderProfile(JSON.stringify(f.profile))!.digest,
      attachedBySelection: true,
    };
    const input = { adapter: f.adapter, expected: binding };
    await expect(
      resolveRegisteredInferenceProvider({ ...binding, adapter: f.adapter }),
    ).rejects.toThrow("enforced REST policy");
    await expect(attachRegisteredInferenceProvider(input)).rejects.toThrow("enforced REST policy");
    await expect(verifyRegisteredInferenceProviderAttachment(input)).rejects.toThrow(
      "enforced REST policy",
    );
    await expect(registeredInferenceProviderRevision(input)).rejects.toThrow(
      "enforced REST policy",
    );
    const read = vi.fn(async () => f.handle);
    await expect(
      readVerifiedRegisteredCredentialHandle({
        adapter: f.adapter,
        attachment: binding,
        read,
        sleep: async () => {},
      }),
    ).rejects.toThrow("enforced REST policy");
    expect(read).not.toHaveBeenCalled();
    expect(f.adapter.ensureProviderPolicyComposition).not.toHaveBeenCalled();
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
    expect(f.adapter.detachProvider).not.toHaveBeenCalled();
    expect(f.state.attached).toBe(true);
    await expect(detachRegisteredInferenceProvider(input)).resolves.toBe(true);
    expect(f.state.attached).toBe(false);
    expect(f.adapter.updateProvider).not.toHaveBeenCalled();
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
    expect(f.adapter.importProviderProfile).not.toHaveBeenCalled();
  });

  it.each([0, 1])("rejects an unsafe matching wildcard endpoint at index %s", async (index) => {
    const f = registeredInferenceFixture();
    const wildcard = { ...f.profile.endpoints[0]!, host: "*.example", enforcement: "audit" };
    f.profile.endpoints.splice(index, 0, wildcard);
    await expect(
      resolveRegisteredInferenceProvider({ ...f.binding, adapter: f.adapter }),
    ).rejects.toThrow("enforced REST policy");
    expect(f.adapter.attachProvider).not.toHaveBeenCalled();
  });

  it.each(["rest", "REST"])(
    "preserves enforced operator rules and address restrictions with %s",
    async (protocol) => {
      const f = registeredInferenceFixture();
      Object.assign(f.profile.endpoints[0]!, {
        protocol,
        access: "",
        rules: [{ allow: { method: "POST", path: "/v1/chat/completions" } }],
        allowed_ips: ["10.0.0.0/8"],
        tls: "",
        allow_uninspected_credentials: false,
      });
      f.profile.endpoints.push({
        ...f.profile.endpoints[0]!,
        host: "unrelated.example",
        enforcement: "audit",
      });
      const before = JSON.stringify(f.profile);
      const binding = await resolveRegisteredInferenceProvider({
        ...f.binding,
        adapter: f.adapter,
      });
      const selected = await attachRegisteredInferenceProvider({
        adapter: f.adapter,
        expected: binding,
      });
      const read = vi.fn(async () => f.handle);
      await expect(
        readVerifiedRegisteredCredentialHandle({
          adapter: f.adapter,
          attachment: selected.attachment,
          read,
          sleep: async () => {},
        }),
      ).resolves.toBe(f.handle);
      expect(JSON.stringify(f.profile)).toBe(before);
      expect(f.adapter.updateProvider).not.toHaveBeenCalled();
      expect(f.adapter.importProviderProfile).not.toHaveBeenCalled();
      await expect(
        detachRegisteredInferenceProvider({ adapter: f.adapter, expected: selected.attachment }),
      ).resolves.toBe(true);
    },
  );

  it.each([
    ["openai-completions", "bearer", "authorization"],
    ["openai-responses", "bearer", "authorization"],
    ["anthropic-messages", "header", "x-api-key"],
  ] as const)(
    "rejects HTTP before attachment or credential handle access for %s",
    async (inferenceApi, authStyle, headerName) => {
      const f = registeredInferenceFixture();
      f.profile.credentials[0]!.auth_style = authStyle;
      f.profile.credentials[0]!.header_name = headerName;
      const binding = {
        ...f.binding,
        endpointUrl: "http://native.example:443/v1",
        inferenceApi,
        profileDigest: inspectInferenceProviderProfile(JSON.stringify(f.profile))!.digest,
      };
      await expect(
        resolveRegisteredInferenceProvider({ ...binding, adapter: f.adapter }),
      ).rejects.toThrow("HTTPS endpoint");
      await expect(
        attachRegisteredInferenceProvider({ adapter: f.adapter, expected: binding }),
      ).rejects.toThrow("HTTPS endpoint");
      const read = vi.fn(async () => f.handle);
      await expect(
        readVerifiedRegisteredCredentialHandle({
          adapter: f.adapter,
          attachment: binding,
          read,
          sleep: async () => {},
        }),
      ).rejects.toThrow("HTTPS endpoint");
      expect(read).not.toHaveBeenCalled();
      expect(f.adapter.ensureProviderPolicyComposition).not.toHaveBeenCalled();
      expect(f.adapter.attachProvider).not.toHaveBeenCalled();
      expect(f.adapter.detachProvider).not.toHaveBeenCalled();
      expect(f.state.attached).toBe(false);
    },
  );

  it("preserves retained HTTP identity for inspection and owned detachment", async () => {
    const f = registeredInferenceFixture(true);
    const binding = {
      ...f.binding,
      endpointUrl: "http://native.example:443/v1",
      attachedBySelection: true,
    };
    expect(
      recordedRegisteredInferenceProviderAttachment({
        name: binding.sandboxName,
        gatewayName: binding.gatewayName,
        provider: binding.providerName,
        endpointUrl: binding.endpointUrl,
        preferredInferenceApi: binding.inferenceApi,
        credentialEnv: binding.credentialEnv,
        registeredInferenceProviderAttachment: binding,
      }),
    ).toEqual(binding);
    await expect(
      verifyRegisteredInferenceProviderAttachment({ adapter: f.adapter, expected: binding }),
    ).rejects.toThrow("HTTPS endpoint");
    await expect(
      detachRegisteredInferenceProvider({ adapter: f.adapter, expected: binding }),
    ).resolves.toBe(true);
    expect(f.state.attached).toBe(false);
    expect(f.adapter.deleteProvider).not.toHaveBeenCalled();
  });

  it.each(["10.0.0.8", "inference.corp.example"])(
    "preserves operator HTTPS inference at %s",
    async (host) => {
      const f = registeredInferenceFixture();
      f.profile.endpoints[0]!.host = host;
      const binding = await resolveRegisteredInferenceProvider({
        ...f.binding,
        adapter: f.adapter,
        endpointUrl: `https://${host}/v1`,
      });
      await expect(
        attachRegisteredInferenceProvider({ adapter: f.adapter, expected: binding }),
      ).resolves.toMatchObject({ changed: true });
      expect(f.adapter.updateProvider).not.toHaveBeenCalled();
    },
  );

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
