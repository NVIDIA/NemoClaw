// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { serializedHostLocalInferenceReceipt } from "../../../../test/helpers/host-local-inference-receipt";
import { OLLAMA_PROXY_PORT } from "../../core/ollama-proxy-port";
import { VLLM_PORT } from "../../core/vllm-port";
import { OLLAMA_LOCAL_CREDENTIAL_ENV } from "../../inference/ollama/contract";
import {
  cloneSandboxHostLocalInferenceReceipt,
  nativeLocalAttachmentMatchesHostLocalReceipt,
  nativeLocalAttachmentMatchesSelectedEndpoint,
} from "./host-local-inference";

describe("sandbox host-local inference receipt transport", () => {
  it("clones only complete canonical receipt transports", () => {
    const valid = serializedHostLocalInferenceReceipt();

    expect(cloneSandboxHostLocalInferenceReceipt(valid)).toBe(valid);
    expect(cloneSandboxHostLocalInferenceReceipt(null)).toBeNull();
    expect(cloneSandboxHostLocalInferenceReceipt(undefined)).toBeUndefined();
    expect(cloneSandboxHostLocalInferenceReceipt(valid.trimEnd())).toBeUndefined();
    expect(cloneSandboxHostLocalInferenceReceipt("[]\n")).toBeUndefined();
    expect(cloneSandboxHostLocalInferenceReceipt('{"providerId": "mxc"}\n')).toBeUndefined();
    expect(
      cloneSandboxHostLocalInferenceReceipt('{"apiKey":"must-not-persist"}\n'),
    ).toBeUndefined();
    expect(
      cloneSandboxHostLocalInferenceReceipt(`{"value":"${"a".repeat(33 * 1024)}"}\n`),
    ).toBeUndefined();
  });
});

it.each([
  {
    name: "exact bridge",
    application: "https://inference.local/v1",
    endpoint: "http://mxc.internal:8000/v1",
    receipt: serializedHostLocalInferenceReceipt(),
    expected: true,
  },
  {
    name: "foreign endpoint",
    application: "https://inference.local/v1",
    endpoint: "http://sibling.internal:8000/v1",
    receipt: serializedHostLocalInferenceReceipt(),
    expected: false,
  },
  {
    name: "unpublished application",
    application: "http://127.0.0.1:8000/v1",
    endpoint: "http://mxc.internal:8000/v1",
    receipt: serializedHostLocalInferenceReceipt(),
    expected: false,
  },
  {
    name: "missing receipt",
    application: "https://inference.local/v1",
    endpoint: "http://mxc.internal:8000/v1",
    receipt: undefined,
    expected: false,
  },
  {
    name: "malformed receipt",
    application: "https://inference.local/v1",
    endpoint: "http://mxc.internal:8000/v1",
    receipt: "{}",
    expected: false,
  },
])("matches native attachment only for $name", ({ application, endpoint, receipt, expected }) => {
  expect(nativeLocalAttachmentMatchesHostLocalReceipt(application, endpoint, receipt)).toBe(
    expected,
  );
  expect(
    nativeLocalAttachmentMatchesSelectedEndpoint("vllm-local", application, endpoint, receipt),
  ).toBe(expected);
});

it.each([
  {
    name: "canonical endpoint",
    provider: "compatible-endpoint",
    selected: "http://host.openshell.internal:11434/v1",
    expected: true,
  },
  {
    name: "canonical trailing slash",
    provider: "compatible-endpoint",
    selected: "http://host.openshell.internal:11434/v1/",
    expected: true,
  },
  {
    name: "loopback gateway mapping",
    provider: "compatible-endpoint",
    selected: "http://127.0.0.1:11434/v1/",
    expected: true,
  },
  {
    name: "wrong provider mapping",
    provider: "ollama-local",
    selected: "http://127.0.0.1:11434/v1",
    expected: false,
  },
  {
    name: "unsupported loopback port",
    provider: "compatible-endpoint",
    selected: "http://localhost:11436/v1",
    expected: false,
  },
  {
    name: "wrong route path",
    provider: "compatible-endpoint",
    selected: "http://localhost:11434/other",
    expected: false,
  },
  {
    name: "endpoint credentials",
    provider: "compatible-endpoint",
    selected: "http://secret@host.openshell.internal:11434/v1",
    expected: false,
  },
  {
    name: "endpoint query",
    provider: "compatible-endpoint",
    selected: "http://host.openshell.internal:11434/v1?token=secret",
    expected: false,
  },
  {
    name: "endpoint fragment",
    provider: "compatible-endpoint",
    selected: "http://host.openshell.internal:11434/v1#fragment",
    expected: false,
  },
  {
    name: "missing selection",
    provider: "compatible-endpoint",
    selected: undefined,
    expected: false,
  },
])("matches selected native endpoint only for $name", ({ provider, selected, expected }) => {
  expect(
    nativeLocalAttachmentMatchesSelectedEndpoint(
      provider,
      selected,
      "http://host.openshell.internal:11434/v1",
      undefined,
    ),
  ).toBe(expected);
});

describe("no-authentication proxy attachment", () => {
  const proxyUrl = `http://host.openshell.internal:${String(OLLAMA_PROXY_PORT)}/v1`;

  it.each([
    { name: "the default vLLM port", selected: `http://localhost:${String(VLLM_PORT)}/v1` },
    { name: "an IPv4 loopback address", selected: `http://127.0.0.1:${String(VLLM_PORT)}/v1` },
    { name: "a trailing slash", selected: `http://localhost:${String(VLLM_PORT)}/v1/` },
    { name: "the Ollama port", selected: "http://localhost:11434/v1" },
  ])("accepts the proxy route for $name", ({ selected }) => {
    expect(
      nativeLocalAttachmentMatchesSelectedEndpoint(
        "compatible-endpoint",
        selected,
        proxyUrl,
        undefined,
        OLLAMA_LOCAL_CREDENTIAL_ENV,
      ),
    ).toBe(true);
  });

  it.each([
    {
      name: "an authenticated selection",
      provider: "compatible-endpoint",
      selected: `http://localhost:${String(VLLM_PORT)}/v1`,
      credentialEnv: "COMPATIBLE_API_KEY",
    },
    {
      name: "a selection without a recorded credential",
      provider: "compatible-endpoint",
      selected: `http://localhost:${String(VLLM_PORT)}/v1`,
      credentialEnv: null,
    },
    {
      name: "another provider",
      provider: "vllm-local",
      selected: `http://localhost:${String(VLLM_PORT)}/v1`,
      credentialEnv: OLLAMA_LOCAL_CREDENTIAL_ENV,
    },
    {
      name: "a remote endpoint",
      provider: "compatible-endpoint",
      selected: "http://example.com:8000/v1",
      credentialEnv: OLLAMA_LOCAL_CREDENTIAL_ENV,
    },
    {
      name: "a loopback port the proxy does not front",
      provider: "compatible-endpoint",
      selected: "http://localhost:9999/v1",
      credentialEnv: OLLAMA_LOCAL_CREDENTIAL_ENV,
    },
    {
      name: "a missing selection",
      provider: "compatible-endpoint",
      selected: undefined,
      credentialEnv: OLLAMA_LOCAL_CREDENTIAL_ENV,
    },
  ])("rejects the proxy route for $name", ({ provider, selected, credentialEnv }) => {
    expect(
      nativeLocalAttachmentMatchesSelectedEndpoint(
        provider,
        selected,
        proxyUrl,
        undefined,
        credentialEnv,
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: "another port",
      attachment: `http://host.openshell.internal:${String(OLLAMA_PROXY_PORT + 1)}/v1`,
    },
    {
      name: "another path",
      attachment: `http://host.openshell.internal:${String(OLLAMA_PROXY_PORT)}/other`,
    },
    {
      name: "another host alias",
      attachment: `http://host.docker.internal:${String(OLLAMA_PROXY_PORT)}/v1`,
    },
  ])("rejects a proxy attachment on $name", ({ attachment }) => {
    expect(
      nativeLocalAttachmentMatchesSelectedEndpoint(
        "compatible-endpoint",
        `http://localhost:${String(VLLM_PORT)}/v1`,
        attachment,
        undefined,
        OLLAMA_LOCAL_CREDENTIAL_ENV,
      ),
    ).toBe(false);
  });
});
