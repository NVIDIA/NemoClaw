// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { serializedHostLocalInferenceReceipt } from "../../../../test/helpers/host-local-inference-receipt";
import { cloneSandboxHostLocalInferenceReceipt } from "./host-local-inference";

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
