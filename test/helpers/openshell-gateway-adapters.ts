// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type { OpenShellGatewayMutationResult } from "../../src/lib/adapters/openshell/gateway-lifecycle";
import type { OpenShellGatewayReuseObservation } from "../../src/lib/adapters/openshell/gateway-reuse";

export function gatewayAdaptersForTest(
  observation: Partial<OpenShellGatewayReuseObservation> = {},
) {
  const completed: OpenShellGatewayMutationResult = { ok: true, state: "completed" };
  return {
    lifecycle: {
      supportsLegacyLifecycle: vi.fn(async () => true),
      selectGateway: vi.fn(
        async (_request: unknown): Promise<OpenShellGatewayMutationResult> => completed,
      ),
      registerGateway: vi.fn(
        async (_request: unknown): Promise<OpenShellGatewayMutationResult> => completed,
      ),
      removeGateway: vi.fn(
        async (_request: unknown): Promise<OpenShellGatewayMutationResult> => completed,
      ),
      destroyGateway: vi.fn(
        async (_request: unknown): Promise<OpenShellGatewayMutationResult> => completed,
      ),
      listGateways: vi.fn(async (_request: unknown) => ({
        ok: true as const,
        names: [] as string[],
      })),
    },
    observer: {
      observeGatewayReuse: vi.fn(
        async (_request: unknown): Promise<OpenShellGatewayReuseObservation> => ({
          gatewayReuseState: "healthy",
          healthy: true,
          namedMetadata: true,
          shouldSelect: false,
          endpoints: [],
          endpointBinding: "unknown",
          ...observation,
        }),
      ),
    },
  };
}
