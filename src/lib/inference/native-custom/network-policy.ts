// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { parseOpenShellPolicy } from "../../adapters/openshell/policy-boundary";
import { profileFromCustomAttachment, type NativeCustomProviderAttachment } from "./index";

export function buildNativeCustomSandboxPolicy(
  basePolicy: string,
  receipt: NativeCustomProviderAttachment,
): string {
  const parsed = { ...parseOpenShellPolicy(basePolicy).policy };
  const { profile } = profileFromCustomAttachment(receipt);
  const key = "native_custom_inference";
  const entry = {
    name: key,
    endpoints: profile.endpoints,
    binaries: profile.binaries.map((path) => ({ path })),
  };
  const existing = parsed.network_policies?.[key];
  if (existing !== undefined && !isDeepStrictEqual(existing, entry)) {
    throw new Error(
      "Native custom inference policy conflicts with the selected endpoint contract.",
    );
  }
  if (existing !== undefined) return basePolicy;
  parsed.network_policies = { ...parsed.network_policies, [key]: entry };
  return YAML.stringify(parsed);
}
