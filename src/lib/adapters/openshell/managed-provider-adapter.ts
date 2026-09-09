// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellProviderAdapter } from "./provider-adapter";
import { createCliOpenShellProviderAdapter, type RunProviderCommand } from "./provider-adapter-cli";
import type { OpenShellGatewayTarget } from "./sandbox-observer";

export const managedProviderGatewayTarget: OpenShellGatewayTarget = { kind: "selected" };

/** Bind managed recovery consumers to one selected-gateway provider protocol owner. */
export function createManagedProviderAdapter(run?: RunProviderCommand): OpenShellProviderAdapter {
  return createCliOpenShellProviderAdapter(run ? { run } : {});
}
