// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { HERMES_PROVIDER_NAME } from "../../hermes-provider-auth";
import { LLAMA_CPP_PROVIDER_NAME } from "../../inference/llama-cpp/contract";
import { OPENROUTER_PROVIDER_NAME } from "../../inference/openrouter";
import { providerNameToOptionKey } from "../provider-recovery";

const { REMOTE_PROVIDER_CONFIG } = require("../providers") as {
  REMOTE_PROVIDER_CONFIG: Record<string, { providerName: string }>;
};

describe("provider selection identities", () => {
  it.each(Object.entries(REMOTE_PROVIDER_CONFIG))(
    "maps declared provider %s back from its persisted name (#11041)",
    (key, provider) => {
      expect(providerNameToOptionKey(REMOTE_PROVIDER_CONFIG, provider.providerName)).toBe(key);
    },
  );

  it("uses the established runtime provider identities (#11041)", () => {
    expect(REMOTE_PROVIDER_CONFIG.openrouter.providerName).toBe(OPENROUTER_PROVIDER_NAME);
    expect(REMOTE_PROVIDER_CONFIG["llama-cpp"].providerName).toBe(LLAMA_CPP_PROVIDER_NAME);
    expect(REMOTE_PROVIDER_CONFIG.hermesProvider.providerName).toBe(HERMES_PROVIDER_NAME);
  });
});
