// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellRuntimeSelection } from "../../adapters/openshell/runtime-selection";
import type { OpenShellGatewayLifecycle } from "../../adapters/openshell/gateway-lifecycle";
import type { OpenShellGatewayReuseObserver } from "../../adapters/openshell/gateway-reuse";

export interface GatewayRegistrationDeps {
  gatewayName(): string;
  gatewayPort(): number;
  getDockerDriverGatewayEndpointArg(): string;
  getGatewayLocalEndpoint(): string;
  isLinuxDockerDriverGatewayEnabled(): boolean;
  lifecycle: OpenShellGatewayLifecycle;
  observer: OpenShellGatewayReuseObserver;
  revalidateAuthority(): void;
}

export interface GatewayRegistration {
  attachGatewayMetadataIfNeeded(options?: { forceRefresh?: boolean }): Promise<boolean>;
  registerDockerDriverGatewayEndpoint(
    runtimeSelection?: OpenShellRuntimeSelection,
  ): Promise<boolean>;
}

export function createGatewayRegistration(deps: GatewayRegistrationDeps): GatewayRegistration {
  async function registerDockerDriverGatewayEndpoint(
    runtimeSelection?: OpenShellRuntimeSelection,
  ): Promise<boolean> {
    const gatewayName = deps.gatewayName();
    if (runtimeSelection && runtimeSelection.gatewayName !== gatewayName) {
      throw new Error(
        `Gateway registration target '${gatewayName}' does not match runtime selection '${runtimeSelection.gatewayName}'`,
      );
    }
    const request = { target: { kind: "named" as const, gatewayName }, runtimeSelection };
    const existing = await deps.observer.observeGatewayReuse({
      ...request,
      expectedGatewayPort: deps.gatewayPort(),
    });
    if (existing.error) return false;
    if (existing.namedMetadata && existing.endpointBinding === "match") {
      const selected = await deps.lifecycle.selectGateway(request);
      if (!selected.ok) return false;
      process.env.OPENSHELL_GATEWAY = gatewayName;
      return true;
    }
    const added = await deps.lifecycle.registerGateway({
      ...request,
      endpoint: deps.getDockerDriverGatewayEndpointArg(),
    });
    if (!added.ok) {
      deps.revalidateAuthority();
      // An unsuccessful add can already have changed registration. Observe it,
      // retain ownership evidence, and stop without removal or a second add.
      await deps.observer.observeGatewayReuse(request);
      return false;
    }
    const selected = await deps.lifecycle.selectGateway(request);
    if (!selected.ok) return false;
    process.env.OPENSHELL_GATEWAY = gatewayName;
    return true;
  }

  async function attachGatewayMetadataIfNeeded({
    forceRefresh = false,
  }: { forceRefresh?: boolean } = {}): Promise<boolean> {
    const request = { target: { kind: "named" as const, gatewayName: deps.gatewayName() } };
    const existing = await deps.observer.observeGatewayReuse(request);
    if (existing.error) return false;
    if (!forceRefresh && existing.namedMetadata) return true;
    if (deps.isLinuxDockerDriverGatewayEnabled()) return registerDockerDriverGatewayEndpoint();
    const added = await deps.lifecycle.registerGateway({
      ...request,
      endpoint: deps.getGatewayLocalEndpoint(),
    });
    if (!added.ok) {
      deps.revalidateAuthority();
      await deps.observer.observeGatewayReuse(request);
      return false;
    }
    console.log("  ✓ Gateway metadata reattached");
    return true;
  }
  return { attachGatewayMetadataIfNeeded, registerDockerDriverGatewayEndpoint };
}
