// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, expect, it, vi } from "vitest";
import { resolveHermesLocalSwitchRuntime, resolveLocalSwitchRuntime } from "./local-runtime";

const mocks = vi.hoisted(() => ({
  managed: vi.fn(),
  proxy: vi.fn(),
  front: vi.fn(),
  credential: vi.fn(),
  endpoint: vi.fn(),
}));
vi.mock("../../inference/local", () => ({
  getLocalProviderBaseUrl: mocks.endpoint,
  getManagedVllmProviderBinding: mocks.managed,
  shouldFrontOllamaWithProxy: mocks.front,
}));
vi.mock("../../inference/ollama/proxy", () => ({ getOllamaProxyToken: mocks.proxy }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.front.mockReturnValue(false);
  mocks.endpoint.mockReturnValue("http://host.openshell.internal:8000/v1");
});

it("keeps managed vLLM's endpoint and credential together", () => {
  mocks.managed.mockReturnValue({ baseUrl: "http://10.1.2.3:8123/v1", apiKey: "managed-test-key" });
  expect(resolveLocalSwitchRuntime("vllm-local", mocks.credential)).toMatchObject({
    endpointUrl: "http://10.1.2.3:8123/v1",
    credentialValue: "managed-test-key",
    authMode: "authenticated",
  });
  expect(mocks.credential).not.toHaveBeenCalled();
});

it("does not fall back to a sentinel after managed vLLM credential failure", () => {
  mocks.managed.mockImplementation(() => {
    throw new Error("unsafe authentication");
  });
  expect(() => resolveLocalSwitchRuntime("vllm-local", mocks.credential)).toThrow(
    "unsafe authentication",
  );
  expect(mocks.endpoint).not.toHaveBeenCalled();
});

it("uses the existing standalone vLLM sentinel without host cloud credentials", () => {
  expect(resolveLocalSwitchRuntime("vllm-local", mocks.credential)).toMatchObject({
    credentialValue: "dummy",
    authMode: "sentinel",
  });
  expect(mocks.credential).not.toHaveBeenCalled();
});

it("requires the existing Ollama proxy key when the proxy owns its route", () => {
  mocks.front.mockReturnValue(true);
  expect(() => resolveLocalSwitchRuntime("ollama-local", mocks.credential)).toThrow(
    "proxy credential is unavailable",
  );
  mocks.proxy.mockReturnValue("proxy-test-key");
  expect(resolveLocalSwitchRuntime("ollama-local", mocks.credential)).toMatchObject({
    credentialValue: "proxy-test-key",
    authMode: "authenticated",
    ownedProxy: true,
  });
});

it("uses only the named llama.cpp credential", () => {
  expect(() => resolveLocalSwitchRuntime("llama-cpp-local", mocks.credential)).toThrow(
    "llama.cpp credential is unavailable",
  );
  mocks.credential.mockReturnValue("llama-test-key");
  expect(resolveLocalSwitchRuntime("llama-cpp-local", mocks.credential)).toMatchObject({
    endpointUrl: "http://host.openshell.internal:8081/v1",
    credentialValue: "llama-test-key",
    authMode: "authenticated",
  });
  expect(mocks.credential).toHaveBeenLastCalledWith("NEMOCLAW_LLAMACPP_LOCAL_TOKEN");
});

const hermesBinding = {
  baseUrl: "http://host.openshell.internal:8123/v1",
  credentialEnv: "COMPATIBLE_API_KEY",
  token: "bound-test-key",
  providerType: "openai" as const,
};

it("keeps Hermes explicit vLLM binding credentials ahead of managed runtime values", () => {
  mocks.managed.mockReturnValue({ baseUrl: "http://10.1.2.3:8000/v1", apiKey: "managed-key" });
  expect(resolveHermesLocalSwitchRuntime("vllm-local", hermesBinding, mocks.credential)).toEqual({
    endpointUrl: hermesBinding.baseUrl,
    credentialValue: hermesBinding.token,
    authMode: "authenticated",
    ownedProxy: false,
  });
  expect(mocks.managed).toHaveBeenCalledOnce();
  expect(mocks.credential).not.toHaveBeenCalled();
});

it("retains Hermes owned proxy identity when an explicit binding supplies its credential", () => {
  mocks.front.mockReturnValue(true);
  expect(resolveHermesLocalSwitchRuntime("ollama-local", hermesBinding, mocks.credential)).toEqual({
    endpointUrl: hermesBinding.baseUrl,
    credentialValue: hermesBinding.token,
    authMode: "authenticated",
    ownedProxy: true,
  });
  expect(mocks.proxy).not.toHaveBeenCalled();
});

it.each([
  ["ollama-local", "ollama"],
  ["vllm-local", "dummy"],
])(
  "preserves the Hermes %s unmanaged sentinel without reading host credentials",
  (provider, sentinel) => {
    expect(resolveHermesLocalSwitchRuntime(provider, null, mocks.credential)).toMatchObject({
      credentialValue: sentinel,
      authMode: "sentinel",
      ownedProxy: false,
    });
    expect(mocks.credential).not.toHaveBeenCalled();
  },
);

it("does not replace an empty explicit Hermes credential with a managed secret", () => {
  mocks.managed.mockReturnValue({ baseUrl: "http://10.1.2.3:8000/v1", apiKey: "managed-key" });
  expect(
    resolveHermesLocalSwitchRuntime(
      "vllm-local",
      { ...hermesBinding, token: "" },
      mocks.credential,
    ),
  ).toMatchObject({
    credentialValue: "",
    authMode: "authenticated",
  });
});

it("keeps missing Hermes proxy credentials authenticated for the selection owner to reject", () => {
  mocks.front.mockReturnValue(true);
  mocks.proxy.mockReturnValue(null);
  expect(resolveHermesLocalSwitchRuntime("ollama-local", null, mocks.credential)).toMatchObject({
    credentialValue: null,
    authMode: "authenticated",
    ownedProxy: true,
  });
});

it("rejects an unavailable Hermes endpoint before reading credentials", () => {
  mocks.endpoint.mockReturnValue(null);
  expect(() =>
    resolveHermesLocalSwitchRuntime("compatible-endpoint", null, mocks.credential),
  ).toThrow("local inference endpoint is unavailable");
  expect(mocks.credential).not.toHaveBeenCalled();
});
