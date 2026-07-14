// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireValue } from "../core/require-value";
import type { SetupNimSelectionState } from "./setup-nim-flow";
import {
  buildDgxSparkExistingVllmHeadroomWarning,
  createSetupNimVllmHandler,
  type SetupNimVllmDeps,
} from "./setup-nim-vllm";

function state(model: string | null): SetupNimSelectionState {
  return {
    model,
    provider: "nvidia-prod",
    endpointUrl: null,
    credentialEnv: null,
    hermesAuthMethod: null,
    hermesToolGateways: [],
    preferredInferenceApi: null,
    nimContainer: null,
    allowToolsIncompatible: false,
  };
}

function deps(overrides: Partial<SetupNimVllmDeps> = {}): SetupNimVllmDeps {
  return {
    VLLM_PORT: 8000,
    runCapture: () => JSON.stringify({ data: [{ id: "served/model" }] }),
    getLocalProviderBaseUrl: () => "http://host.openshell.internal:8000/v1",
    getLocalProviderValidationBaseUrl: () => "http://127.0.0.1:8000/v1",
    isSafeModelId: () => true,
    requireValue,
    validateOpenAiLikeSelection: async () => ({ ok: true, api: "openai-completions" }),
    applyVllmRuntimeContextWindow: vi.fn(),
    isDgxSparkHost: () => false,
    isNemoClawManagedVllmRunning: () => false,
    exitProcess: (code) => {
      throw new Error(`exit ${code}`);
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("setupNim vLLM route containment", () => {
  it("preflights before discovery and exact-checks the detected model before validation (#6315)", async () => {
    const events: string[] = [];
    const selection = state(null);
    selection.assertRouteCompatible = () => {
      events.push(selection.model ? "exact" : "preflight");
      return { requiredModel: null, requiredEndpointUrl: null, requiredInferenceApi: null };
    };
    const handler = createSetupNimVllmHandler(
      deps({
        runCapture: () => {
          events.push("probe");
          return JSON.stringify({ data: [{ id: "served/model" }] });
        },
        validateOpenAiLikeSelection: async () => {
          events.push("validate");
          return { ok: true, api: "openai-completions" };
        },
      }),
    );

    await expect(handler(selection)).resolves.toBe("selected");
    expect(events).toEqual(["preflight", "probe", "exact", "validate"]);
  });

  it("rejects a detected model that differs from the durable shared route before validation", async () => {
    const validate = vi.fn(async () => ({ ok: true }));
    const selection = state("required/model");
    selection.assertRouteCompatible = () => ({
      requiredModel: "required/model",
      requiredEndpointUrl: null,
      requiredInferenceApi: null,
    });
    const handler = createSetupNimVllmHandler(deps({ validateOpenAiLikeSelection: validate }));

    await expect(handler(selection)).rejects.toThrow("exit 1");
    expect(validate).not.toHaveBeenCalled();
  });

  it("warns on DGX Spark identified via GPU name (firmware-unknown GB10 host)", async () => {
    const selection = state(null);
    const handler = createSetupNimVllmHandler(
      deps({
        isDgxSparkHost: () => false, // firmware says linux — should be overridden by sparkHost
        runCapture: () =>
          JSON.stringify({
            data: [
              {
                id: "served-model",
                root: "Qwen/Qwen3-30B-A3B",
                max_model_len: 32768,
              },
            ],
          }),
      }),
    );

    await expect(handler(selection, { sparkHost: true })).resolves.toBe("selected");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Existing vLLM on DGX Spark"),
    );
  });

  it("warns on DGX Spark when metadata reports a large model without quantization", async () => {
    const selection = state(null);
    const handler = createSetupNimVllmHandler(
      deps({
        isDgxSparkHost: () => true,
        runCapture: () =>
          JSON.stringify({
            data: [
              {
                id: "Qwen/Qwen3.6-35B-A3B",
                root: "Qwen/Qwen3.6-35B-A3B",
                max_model_len: 32768,
              },
            ],
          }),
      }),
    );

    await expect(handler(selection)).resolves.toBe("selected");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Existing vLLM on DGX Spark"),
    );
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("NV_ERR_NO_MEMORY"));
  });

  it("does not warn on DGX Spark for the managed vLLM handoff", async () => {
    const selection = state("Qwen/Qwen3.6-35B-A3B");
    const handler = createSetupNimVllmHandler(
      deps({
        isDgxSparkHost: () => true,
        runCapture: () =>
          JSON.stringify({
            data: [
              {
                id: "Qwen/Qwen3.6-35B-A3B",
                root: "Qwen/Qwen3.6-35B-A3B",
                max_model_len: 131072,
              },
            ],
          }),
      }),
    );

    await expect(handler(selection, { managedInstall: true })).resolves.toBe("selected");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("recognizes a running labeled managed container on re-onboard", async () => {
    const selection = state(null);
    const isNemoClawManagedVllmRunning = vi.fn(() => true);
    const handler = createSetupNimVllmHandler(
      deps({
        isDgxSparkHost: () => true,
        isNemoClawManagedVllmRunning,
        runCapture: () =>
          JSON.stringify({
            data: [
              {
                id: "managed-alias",
                root: "Qwen/Qwen3.6-35B-A3B",
                max_model_len: 131072,
              },
            ],
          }),
      }),
    );

    await expect(handler(selection)).resolves.toBe("selected");
    expect(isNemoClawManagedVllmRunning).toHaveBeenCalledOnce();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("DGX Spark existing vLLM headroom warning", () => {
  it("uses root and config metadata instead of the arbitrary served alias", () => {
    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        {
          data: [
            {
              id: "anything-at-all",
              root: "nvidia/Qwen3.6-35B-A3B-NVFP4",
              max_model_len: 32768,
              config: { quantization: "modelopt" },
            },
          ],
        },
        "anything-at-all",
      ),
    ).toBeNull();
  });

  it("does not accept a quantized-looking alias as proof of quantization", () => {
    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        {
          data: [
            {
              id: "safe-looking-NVFP4",
              root: "company/finetune-70b-v2",
              max_model_len: 32768,
            },
          ],
        },
        "safe-looking-NVFP4",
      ),
    ).toContain("without reported quantization configuration");
  });

  it("does not accept a root suffix as proof of quantization", () => {
    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        {
          data: [
            {
              id: "served-model",
              root: "nvidia/Qwen3.6-35B-A3B-NVFP4",
              max_model_len: 32768,
            },
          ],
        },
        "served-model",
      ),
    ).toContain("without reported quantization configuration");
  });

  it("warns for a configured quantized model with very long context", () => {
    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        {
          data: [
            {
              id: "served-model",
              root: "nvidia/Qwen3.6-35B-A3B-NVFP4",
              max_model_len: 262144,
              model_config: { quantization: "fp8" },
            },
          ],
        },
        "served-model",
      ),
    ).toContain("High-context configurations");
  });

  it("warns for a known-small model at the long-context threshold", () => {
    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        {
          data: [
            {
              id: "served-model",
              root: "Qwen/Qwen2.5-14B-Instruct",
              max_model_len: 131072,
            },
          ],
        },
        "served-model",
      ),
    ).toContain("High-context configurations");
  });

  it("does not warn for small model just under the long-context threshold", () => {
    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        {
          data: [
            {
              id: "served-model",
              root: "Qwen/Qwen2.5-14B-Instruct",
              max_model_len: 131071,
            },
          ],
        },
        "served-model",
      ),
    ).toBeNull();
  });

  it("warns conservatively when an arbitrary alias has no root metadata", () => {
    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        { data: [{ id: "my-custom-model", max_model_len: 32768 }] },
        "my-custom-model",
      ),
    ).toContain("did not report enough model metadata");
  });

  it("uses a reported small root even when the served alias looks large", () => {
    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        {
          data: [
            {
              id: "company/finetune-70b-v2",
              root: "Qwen/Qwen2.5-14B-Instruct",
              max_model_len: 32768,
            },
          ],
        },
        "company/finetune-70b-v2",
      ),
    ).toBeNull();
  });

  it("includes the reported max_model_len when available", () => {
    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        {
          data: [
            {
              id: "served-model",
              root: "nvidia/nemotron-3-super",
              max_model_len: 262144,
            },
          ],
        },
        "served-model",
      ),
    ).toContain("max_model_len=262144");
  });

  it("warns for numeric model sizes at or above the large-model threshold", () => {
    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        {
          data: [
            {
              id: "served-model",
              root: "Qwen/Qwen2.5-72B-Instruct",
              max_model_len: 32768,
            },
          ],
        },
        "served-model",
      ),
    ).toContain("Qwen/Qwen2.5-72B-Instruct");
  });

  it("includes the threshold-sized model identifier in large-model warnings", () => {
    const model = "Qwen/Qwen3-30B-A3B";

    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        {
          data: [
            {
              id: "served-model",
              root: model,
              max_model_len: 32768,
            },
          ],
        },
        "served-model",
      ),
    ).toContain(model);
  });

  it("warns for numeric model sizes at the large-model threshold", () => {
    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        {
          data: [
            {
              id: "served-model",
              root: "Qwen/Qwen3-30B-A3B",
              max_model_len: 32768,
            },
          ],
        },
        "served-model",
      ),
    ).toContain("without reported quantization configuration");
  });

  it("does not warn for a reported smaller model below the context threshold", () => {
    expect(
      buildDgxSparkExistingVllmHeadroomWarning(
        {
          data: [
            {
              id: "served-model",
              root: "Qwen/Qwen2.5-14B-Instruct",
              max_model_len: 32768,
            },
          ],
        },
        "served-model",
      ),
    ).toBeNull();
  });
});
