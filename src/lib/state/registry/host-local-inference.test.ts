// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { serializedHostLocalInferenceReceipt } from "../../../../test/helpers/host-local-inference-receipt";
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
