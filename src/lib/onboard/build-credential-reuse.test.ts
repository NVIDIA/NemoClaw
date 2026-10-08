// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, it, vi } from "vitest";
import * as credentials from "../credentials/store";
import { resolveNonInteractiveBuildCredential } from "./build-credential-reuse";

afterEach(() => vi.restoreAllMocks());

it("reuses the native NVIDIA registration during keyless recreation", async () => {
  vi.spyOn(credentials, "resolveProviderCredential").mockReturnValue(null);
  const providerExistsInGateway = vi.fn((name: string) => name === "nemoclaw-nvidia-prod-v1");
  const result = await resolveNonInteractiveBuildCredential({
    provider: "nvidia-prod",
    helpUrl: "https://build.nvidia.com/settings/api-keys",
    recoveredFromSandbox: true,
    providerExistsInGateway,
  });
  expect(result).toBe(true);
  expect(providerExistsInGateway).toHaveBeenCalledExactlyOnceWith("nemoclaw-nvidia-prod-v1");
});
