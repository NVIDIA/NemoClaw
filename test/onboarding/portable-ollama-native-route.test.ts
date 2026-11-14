// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDirectSetupInferenceHarnessFactory } from "../support/setup-inference-test-harness";
import { createHermesPortableInferenceFixture } from "../helpers/hermes-portable-onboarding-fixture";
import type { SetupInferenceDeps, SetupInference } from "../../src/lib/onboard/setup-inference";
import { prepareHermesPortableOllamaProviderRetirement } from "../../src/lib/onboard/experimental/hermes-portable-ollama-gateway-transaction";
import type { NativeLocalProviderAttachment } from "../../src/lib/inference/native-local/profile";
import { nativeLocalIdentity } from "../../src/lib/inference/native-local/contract";

const onboard = require("../../src/lib/onboard") as {
  createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
};
const createHarness = createDirectSetupInferenceHarnessFactory(onboard.createSetupInference);
const input = {
  gatewayName: "nemoclaw",
  sandboxName: "portable-hermes",
  provider: "ollama-local",
  model: "qwen3-vl:4b",
  providerBaseUrl: "http://host.openshell.internal:11434/v1",
} as const;
function journalFile(fixture: ReturnType<typeof createHermesPortableInferenceFixture>) {
  const root = path.join(fixture.homeDir, "state", "portable-inference");
  return path.join(root, fs.readdirSync(root)[0]!, "portable-gateway-provider.json");
}

describe("Portable Ollama native publication", () => {
  it("publishes the transaction-owned native attachment through complete inference setup", async () => {
    const fixture = createHermesPortableInferenceFixture();
    const selection = fixture.resolve()!;
    const updateSandbox = vi.fn<SetupInferenceDeps["updateSandbox"]>(() => true);
    const harness = createHarness({ overrides: { updateSandbox } });
    await expect(
      harness.setupInference(input.sandboxName, input.model, input.provider, null, null, null, [], {
        agentName: "hermes",
        hostLocalInference: selection,
      }),
    ).resolves.toEqual({ ok: true });
    const journal = JSON.parse(fs.readFileSync(journalFile(fixture), "utf8"));
    const row = updateSandbox.mock.calls.at(-1)![1];
    const attachment = row.nativeLocalProviderAttachment!;
    expect(attachment).toMatchObject({
      ...nativeLocalIdentity(attachment),
      transactionId: journal.intent.transactionId,
      providerId: journal.providerAuthority.id,
      credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
      endpointUrl: input.providerBaseUrl,
      agent: "hermes",
      authMode: "sentinel",
    });
    expect(journal.phase).toBe("committed");
    expect(harness.verifyInferenceRoute).not.toHaveBeenCalled();
    expect(harness.commands.some(({ command }) => command.includes("inference set"))).toBe(false);
    expect(
      fixture.events.some((event) => event.includes("--publish 169.254.2.2:11434:11434")),
    ).toBe(true);
  });

  it("rolls back a failed setup through its journal without generic native retirement", async () => {
    const fixture = createHermesPortableInferenceFixture();
    const selection = fixture.resolve()!;
    const genericRetirement = vi.fn(() => {
      throw new Error("unowned generic cleanup");
    });
    const harness = createHarness({
      overrides: { clearNativeLocalProviderAuthority: genericRetirement },
    });
    const ownedSelection = {
      ...selection,
      prepareGatewayMutation: async (
        value: Parameters<typeof selection.prepareGatewayMutation>[0],
      ) => {
        const mutation = await selection.prepareGatewayMutation(value);
        return {
          ...mutation,
          commit() {
            throw new Error("injected prepublication failure");
          },
        };
      },
    };
    await expect(
      harness.setupInference(input.sandboxName, input.model, input.provider, null, null, null, [], {
        agentName: "hermes",
        hostLocalInference: ownedSelection,
      }),
    ).rejects.toThrow("EXIT_CALLED:1");
    expect(genericRetirement).not.toHaveBeenCalled();
    expect(fixture.gatewayProvider.isPresent()).toBe(false);
    expect(fixture.harness.container()).toBeNull();
    expect(JSON.parse(fs.readFileSync(journalFile(fixture), "utf8")).phase).toBe("rolled-back");
  });

  it.each([
    {
      change: "profile",
      mutate: (
        fixture: ReturnType<typeof createHermesPortableInferenceFixture>,
        _attachment: NativeLocalProviderAttachment,
      ) => fixture.gatewayProvider.setProfileState("incompatible"),
    },
    {
      change: "id",
      mutate: (
        fixture: ReturnType<typeof createHermesPortableInferenceFixture>,
        attachment: NativeLocalProviderAttachment,
      ) =>
        fixture.gatewayProvider.setIdentity(
          attachment.providerName,
          attachment.profileId,
          "replacement",
        ),
    },
    {
      change: "name",
      mutate: (
        fixture: ReturnType<typeof createHermesPortableInferenceFixture>,
        attachment: NativeLocalProviderAttachment,
      ) => fixture.gatewayProvider.setIdentity("foreign-provider", attachment.profileId),
    },
    {
      change: "revision",
      mutate: (
        fixture: ReturnType<typeof createHermesPortableInferenceFixture>,
        _attachment: NativeLocalProviderAttachment,
      ) => fixture.gatewayProvider.bumpResourceVersion(),
    },
  ])("preserves a changed native $change during rollback", async ({ mutate }) => {
    const fixture = createHermesPortableInferenceFixture();
    const mutation = await fixture.resolve()!.prepareGatewayMutation(input);
    const attachment = await mutation.registerNativeProvider!();
    mutate(fixture, attachment);
    await expect(mutation.rollback()).rejects.toThrow();
    expect(fixture.gatewayProvider.isPresent()).toBe(true);
    expect(fixture.events.some((event) => event.includes("provider delete"))).toBe(false);
  });

  it("retains legacy credential-key proof for uninstall and refuses native adoption", async () => {
    const fixture = createHermesPortableInferenceFixture();
    const mutation = await fixture.resolve()!.prepareGatewayMutation(input);
    await mutation.registerNativeProvider!();
    const file = journalFile(fixture);
    const journal = JSON.parse(fs.readFileSync(file, "utf8"));
    journal.phase = "committed";
    journal.intent.type = "openai";
    journal.intent.providerCredentialEnv = `${journal.intent.credentialEnv}_${journal.intent.transactionId.toUpperCase()}`;
    fs.writeFileSync(file, `${JSON.stringify(journal)}\n`);
    fixture.gatewayProvider.setIdentity("ollama-local", "openai");
    fixture.gatewayProvider.setCredentialEnv(journal.intent.providerCredentialEnv);
    expect(() => fixture.resolve()).toThrow();
    const options = {
      directory: path.dirname(file),
      ...input,
      transactionId: journal.intent.transactionId,
      targetSha256: journal.intent.targetSha256,
      credentialEnv: journal.intent.credentialEnv,
      runGatewayOpenshell: fixture.gatewayProvider.run,
    };
    fixture.gatewayProvider.setCredentialEnv("FOREIGN_LEGACY_TOKEN");
    expect(() => prepareHermesPortableOllamaProviderRetirement(options)).toThrow();
    fixture.gatewayProvider.setCredentialEnv(journal.intent.providerCredentialEnv);
    const retirement = prepareHermesPortableOllamaProviderRetirement(options);
    await retirement.removeAndVerify();
    retirement.verifyAbsent();
    expect(fixture.gatewayProvider.isPresent()).toBe(false);
  });
});
