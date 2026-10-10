// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import YAML from "yaml";
import type { PolicyMutationContext } from "../../policy";
import { prepareNativeCustomProfile, customAttachmentFromPrepared } from "./index";
import {
  buildNativeCustomSandboxPolicy,
  reconcileNativeCustomSandboxPolicy,
} from "./network-policy";

async function fixture() {
  const receipt = async (endpointUrl: string) => {
    const prepared = await prepareNativeCustomProfile({
      sandboxName: "alpha",
      provider: "compatible-endpoint",
      endpointUrl,
      api: "openai-completions",
    });
    return customAttachmentFromPrepared(prepared, {
      schemaVersion: 1,
      profileId: prepared.profile.id,
      providerName: prepared.providerName,
      providerId: `id-${prepared.providerName}`,
    });
  };
  const previous = await receipt("http://8.8.8.8/v1");
  const next = await receipt("http://12.12.12.12/v1");
  let document = buildNativeCustomSandboxPolicy("version: 1\nnetwork_policies: {}\n", previous);
  const inspectPolicyMutationContext = vi.fn(
    async () =>
      ({ basePolicyDocument: document, gatewayName: "nemoclaw" }) as PolicyMutationContext,
  );
  const setPolicyDocument = vi.fn(async (_sandbox: string, requested: string) => {
    document = requested;
    return true;
  });
  return {
    previous,
    next,
    backend: { inspectPolicyMutationContext, setPolicyDocument },
    input: { sandboxName: "alpha", gatewayName: "nemoclaw", previous, next },
    get document() {
      return document;
    },
    set document(value: string) {
      document = value;
    },
  };
}

it("replaces only owned endpoint egress and preserves concurrent unrelated policy during rollback (#12636)", async () => {
  const f = await fixture();
  const rollback = await reconcileNativeCustomSandboxPolicy(f.input, f.backend);
  expect(f.document).toContain("12.12.12.12");
  expect(f.document).not.toContain("8.8.8.8");
  const concurrent = YAML.parse(f.document);
  concurrent.network_policies.unrelated = {
    name: "unrelated",
    endpoints: [{ host: "other.example", port: 443 }],
    binaries: [],
  };
  f.document = YAML.stringify(concurrent);
  await rollback();
  expect(f.document).toContain("8.8.8.8");
  expect(f.document).not.toContain("12.12.12.12");
  expect(YAML.parse(f.document).network_policies.unrelated).toEqual(
    concurrent.network_policies.unrelated,
  );
  expect(f.backend.inspectPolicyMutationContext).toHaveBeenCalledWith(
    "alpha",
    "reconcile native custom inference policy",
    "nemoclaw",
  );
  expect(f.backend.setPolicyDocument).toHaveBeenCalledWith(
    "alpha",
    expect.any(String),
    expect.objectContaining({
      nonFatal: true,
      gatewayName: "nemoclaw",
      context: expect.objectContaining({ gatewayName: "nemoclaw" }),
    }),
  );
});

it("removes the custom policy on departure and restores it for rejected publication (#12636)", async () => {
  const f = await fixture();
  const rollback = await reconcileNativeCustomSandboxPolicy(
    { ...f.input, next: undefined },
    f.backend,
  );
  expect(YAML.parse(f.document).network_policies.native_custom_inference).toBeUndefined();
  await rollback();
  expect(f.document).toContain("8.8.8.8");
});

it("verifies a no-op without resubmitting policy (#12636)", async () => {
  const f = await fixture();
  const rollback = await reconcileNativeCustomSandboxPolicy(
    { ...f.input, next: f.previous },
    f.backend,
  );
  await rollback();
  expect(f.backend.setPolicyDocument).not.toHaveBeenCalled();
});

it("rejects conflicting endpoint policy without overwriting it (#12636)", async () => {
  const f = await fixture();
  f.document = f.document.replaceAll("8.8.8.8", "9.9.9.9");
  await expect(reconcileNativeCustomSandboxPolicy(f.input, f.backend)).rejects.toThrow(
    /recovery could not be verified/,
  );
  expect(f.backend.setPolicyDocument).not.toHaveBeenCalled();
  expect(f.document).toContain("9.9.9.9");
});

it("reconciles an ambiguous update to the prior owned policy and still rejects success (#12636)", async () => {
  const f = await fixture();
  f.backend.setPolicyDocument.mockImplementationOnce(async (_sandbox, requested) => {
    f.document = requested;
    return false;
  });
  await expect(reconcileNativeCustomSandboxPolicy(f.input, f.backend)).rejects.toThrow(
    /previous policy was verified/,
  );
  expect(f.document).toContain("8.8.8.8");
  expect(f.document).not.toContain("12.12.12.12");
  expect(f.backend.setPolicyDocument).toHaveBeenCalledTimes(2);
});

it("retains an explicit recovery error when rollback cannot be verified (#12636)", async () => {
  const f = await fixture();
  f.backend.setPolicyDocument.mockImplementation(async (_sandbox, requested) => {
    f.document = requested;
    return false;
  });
  await expect(reconcileNativeCustomSandboxPolicy(f.input, f.backend)).rejects.toThrow(
    /provider authority is retained/,
  );
});

it("rejects another sandbox's receipt before reading policy (#12636)", async () => {
  const f = await fixture();
  await expect(
    reconcileNativeCustomSandboxPolicy({ ...f.input, sandboxName: "other" }, f.backend),
  ).rejects.toThrow(/another sandbox/);
  expect(f.backend.inspectPolicyMutationContext).not.toHaveBeenCalled();
});
