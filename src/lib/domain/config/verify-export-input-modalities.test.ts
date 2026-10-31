// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";
import { publishExportFile } from "../../adapters/fs/config-export-file";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { formatConfigExportFailure } from "../../cli/config-export-diagnostics";
import { resolveManagedStartupInferenceRoute } from "../../inference/gateway/route-contract";
import {
  NVIDIA_HOSTED_CREDENTIAL_ENV,
  NVIDIA_HOSTED_LOGICAL_PROVIDER,
  NVIDIA_HOSTED_NATIVE_ENDPOINT,
  NVIDIA_HOSTED_NATIVE_PROFILE_ID,
  NVIDIA_HOSTED_NATIVE_PROVIDER,
} from "../../inference/native-nvidia/contract";
import { maybePromptForInferenceInputCapability } from "../../onboard/inference-input-capability";
import {
  changeRetainedProfile,
  entry,
  managedWorkload,
  profileInput,
  snapshot,
  tunedSnapshot,
} from "./export-source-test-fixture";

const defaultModel = "nvidia/nemotron-3.5-super-vl-120b-a12b";

async function defaultNvidiaSnapshot(inputs?: string) {
  const environment: NodeJS.ProcessEnv =
    inputs === undefined ? {} : { NEMOCLAW_INFERENCE_INPUTS: inputs };
  const prompt = vi.fn(async () => "1");
  await maybePromptForInferenceInputCapability(defaultModel, {
    env: environment,
    isNonInteractive: () => true,
    prompt,
  });
  expect(prompt).not.toHaveBeenCalled();
  const route = resolveManagedStartupInferenceRoute(
    "openclaw",
    NVIDIA_HOSTED_LOGICAL_PROVIDER,
    defaultModel,
    "openai-completions",
    true,
    NVIDIA_HOSTED_NATIVE_ENDPOINT,
  );
  const original = snapshot();
  return snapshot({
    registry: entry({
      provider: NVIDIA_HOSTED_LOGICAL_PROVIDER,
      model: defaultModel,
      preferredInferenceApi: "openai-completions",
      endpointUrl: NVIDIA_HOSTED_NATIVE_ENDPOINT,
      credentialEnv: NVIDIA_HOSTED_CREDENTIAL_ENV,
      nativeNvidiaProviderAttachment: {
        schemaVersion: 1,
        profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID,
        providerName: NVIDIA_HOSTED_NATIVE_PROVIDER,
        providerId: "native-provider-id",
      },
      workload: managedWorkload(
        profileInput({
          environment,
          inference: {
            routeProvider: route.providerKey,
            upstreamProvider: NVIDIA_HOSTED_LOGICAL_PROVIDER,
            model: defaultModel,
            routedBaseUrl: route.inferenceBaseUrl,
            upstreamEndpointUrl: null,
            api: "openai-completions",
            primaryModelRef: route.primaryModelRef,
            compatibility: route.inferenceCompat ?? {},
          },
        }),
      ),
    }),
    sandbox: { ...original.sandbox, providerNames: [NVIDIA_HOSTED_NATIVE_PROVIDER] },
    inference: {
      ...original.inference,
      provider: NVIDIA_HOSTED_LOGICAL_PROVIDER,
      model: defaultModel,
      api: "openai-completions",
      endpoint: NVIDIA_HOSTED_NATIVE_ENDPOINT,
      credentialEnv: NVIDIA_HOSTED_CREDENTIAL_ENV,
      endpointEvidence: {
        endpoint: NVIDIA_HOSTED_NATIVE_ENDPOINT,
        provider: {
          gatewayName: original.gateway.name,
          workspace: original.sandbox.workspace,
          name: NVIDIA_HOSTED_NATIVE_PROVIDER,
          id: "native-provider-id",
          resourceVersion: "8",
        },
        source: { kind: "managed-profile", profileId: NVIDIA_HOSTED_NATIVE_PROFILE_ID },
      },
    },
  });
}

function expectUnsupportedInputs(result: Awaited<ReturnType<typeof exportSnapshots>>) {
  assert(!result.outcome.ok);
  assert(result.outcome.failure.kind === "observation");
  expect(result.outcome.failure.findings.map(({ category }) => category)).toContain("unsupported");
  const finding = result.outcome.failure.findings.find(
    ({ field }) => field === "source.workload.startupProfile.inference.inputModalities",
  );
  assert(finding);
  expect(finding.category).toBe("unsupported");
  expect(finding.diagnostic).toMatch(/image input/iu);
  expect(finding.diagnostic).toContain("NEMOCLAW_INFERENCE_INPUTS=text");
  expect(finding.diagnostic).toMatch(/new (?:text-only )?sandbox/iu);
  expect(finding.diagnostic).not.toMatch(/--recreate-sandbox|rebuild|destroy/iu);
  expect(result.writeStdout).not.toHaveBeenCalled();
  expect(result.publish).not.toHaveBeenCalled();
  return result.outcome.failure;
}

describe("config export input modalities (#13731)", () => {
  it("identifies automatic image input without reporting drift", async () => {
    const result = await exportSnapshots([await defaultNvidiaSnapshot()]);
    const failure = expectUnsupportedInputs(result);
    expect(failure.findings).not.toContainEqual(expect.objectContaining({ category: "drifted" }));
    expect(formatConfigExportFailure(failure)).toContain("Config export failed (unsupported).");
  });

  it.each(["text,image", "image,text", "image"])(
    "identifies unsupported %s input before writing YAML",
    async (inputs) => {
      const result = await exportSnapshots([await defaultNvidiaSnapshot(inputs)]);
      expectUnsupportedInputs(result);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "preserves existing file bytes when forced export rejects image input",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-image-input-export-"));
      try {
        const outputPath = path.join(root, "existing.yaml");
        const originalBytes = Buffer.from("# Keep this existing export.\r\nexisting: true\r\n");
        fs.writeFileSync(outputPath, originalBytes);
        const target = { kind: "file", outputPath, force: true } as const;

        const rejected = await exportSnapshots(
          [await defaultNvidiaSnapshot()],
          target,
          publishExportFile,
        );
        expectUnsupportedInputs(rejected);
        expect(fs.readFileSync(outputPath)).toEqual(originalBytes);

        const accepted = await exportSnapshots(
          [await defaultNvidiaSnapshot("text")],
          target,
          publishExportFile,
        );
        expect(accepted.outcome).toMatchObject({
          ok: true,
          completion: { kind: "file", result: { outputPath } },
        });
        expect(accepted.publish).toHaveBeenCalledOnce();
        expect(accepted.publish).toHaveBeenCalledWith(outputPath, expect.any(String), true);
        expect(accepted.writeStdout).not.toHaveBeenCalled();
        const replacement = fs.readFileSync(outputPath);
        expect(replacement).not.toEqual(originalBytes);
        expect(replacement.toString("utf8")).toContain("kind: NemoClawConfig");
        expect(replacement.toString("utf8")).toContain(defaultModel);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("exports the same native NVIDIA model with text-only input", async () => {
    const result = await exportSnapshots([await defaultNvidiaSnapshot("text")]);
    expect(result.outcome).toEqual({ ok: true, completion: { kind: "stdout" } });
    expect(result.writeStdout).toHaveBeenCalledOnce();
    expect(result.writeStdout.mock.calls[0]![0]).toContain(defaultModel);
    expect(result.publish).not.toHaveBeenCalled();
  });

  it("keeps model drift visible when image input is unsupported", async () => {
    const observed = changeRetainedProfile(await defaultNvidiaSnapshot(), (profile) => {
      profile.inference.model = "different-model";
      profile.inference.primaryModelRef = "inference/different-model";
    });
    const failure = expectUnsupportedInputs(await exportSnapshots([observed]));
    expect(failure.findings).toContainEqual(
      expect.objectContaining({ field: "spec.inferenceProviders", category: "drifted" }),
    );
  });

  it("identifies image input on another OpenClaw provider", async () => {
    const result = await exportSnapshots([
      tunedSnapshot({ NEMOCLAW_INFERENCE_INPUTS: "text,image" }),
    ]);
    const failure = expectUnsupportedInputs(result);
    expect(failure.findings).not.toContainEqual(expect.objectContaining({ category: "drifted" }));
  });
});
