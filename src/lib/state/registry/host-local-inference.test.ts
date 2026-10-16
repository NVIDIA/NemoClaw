// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { serializedHostLocalInferenceReceipt } from "../../../../test/helpers/host-local-inference-receipt";
import {
  cloneSandboxHostLocalInferenceReceipt,
  nativeLocalAttachmentMatchesHostLocalReceipt,
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
});
