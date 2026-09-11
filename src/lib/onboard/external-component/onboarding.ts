// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { inspectPolicyMutationContext } from "../../policy";
import type { ExternalComponentActivationIncomplete } from "../../state/onboard-session";
import { configureDockerDriverGatewayExternalComponent } from "../docker-driver-gateway-env";
import type { SandboxLifecycleHelpers } from "../sandbox-lifecycle";
import {
  ExternalComponentContractError,
  loadExternalComponentDeclaration,
  type PreparedExternalComponent,
} from "./index";
import { activateExternalComponent, createExternalComponentActivationId } from "./activation";
import { createExternalComponentActivationProof } from "./proof";

export function prepareExternalComponent(
  session: {
    externalComponentActivation?: unknown;
    apfInterceptorRequested?: boolean | null;
  } | null,
): PreparedExternalComponent | null {
  assertNoIncompleteExternalComponentActivation(session);
  return loadExternalComponentDeclaration();
}

export function assertNoIncompleteExternalComponentActivation(
  session: { externalComponentActivation?: unknown } | null,
): void {
  if (session?.externalComponentActivation) {
    throw new ExternalComponentContractError("lifecycle_unsupported");
  }
}

export function assertExternalComponentFreshSandbox(
  requestedSandboxName: string | null,
  inspectSandboxForCreate: SandboxLifecycleHelpers["inspectSandboxForCreate"],
): void {
  if (!requestedSandboxName) {
    throw new ExternalComponentContractError("lifecycle_unsupported");
  }
  const inspected = inspectSandboxForCreate(requestedSandboxName);
  if (inspected.existingEntry || inspected.liveExists) {
    throw new ExternalComponentContractError("lifecycle_unsupported");
  }
}

export function flowDeps(
  readiness: { collectGatewayReadiness(): Promise<unknown> },
  getDockerDriverGatewayEnv: () => Record<string, string>,
  inspectSandboxForCreate: SandboxLifecycleHelpers["inspectSandboxForCreate"],
) {
  return {
    assertGatewayReadiness: () => readiness.collectGatewayReadiness().then(() => undefined),
    assertExternalComponentFreshSandbox: (requestedSandboxName: string | null) =>
      assertExternalComponentFreshSandbox(requestedSandboxName, inspectSandboxForCreate),
    configureExternalComponentGateway: (
      externalComponent: {
        readonly componentId: string;
        readonly interceptorSocketPath: string;
      } | null,
    ) =>
      configureDockerDriverGatewayExternalComponent(getDockerDriverGatewayEnv(), externalComponent),
    prepareExternalComponent,
  };
}

interface OnboardSessionAccess {
  updateSession(
    mutator: (session: {
      externalComponentActivation: ExternalComponentActivationIncomplete | null;
    }) => void,
  ): unknown;
}

interface RegistryAccess {
  getSandbox(name: string): {
    readonly name: string;
    readonly gatewayName?: string | null;
    readonly gatewayPort?: number | null;
    readonly lifecycleGeneration?: string;
    readonly lifecycleLiveIdentityFingerprint?: string;
  } | null;
  setDefault(name: string): void;
}

type CaptureOpenShell = (args: string[], options?: { ignoreError?: boolean }) => string;

export function finalDeps(
  gatewayName: string,
  onboardSession: OnboardSessionAccess,
  registry: RegistryAccess,
  runCaptureOpenshell: CaptureOpenShell,
) {
  return {
    createExternalComponentActivationProof: (sandboxName: string) =>
      createExternalComponentActivationProof(sandboxName, gatewayName, {
        getSandbox: registry.getSandbox,
        inspectPolicy: inspectPolicyMutationContext,
        listSandboxes: (selectedGatewayName: string) =>
          runCaptureOpenshell(["sandbox", "list", "-g", selectedGatewayName, "--output", "json"], {
            ignoreError: false,
          }),
      }),
    createExternalComponentActivationId,
    activateExternalComponent: (
      component: PreparedExternalComponent,
      proof: import("./activation").ExternalComponentActivationProof,
      activationId: string,
    ) => activateExternalComponent(component, proof, undefined, activationId),
    setExternalComponentActivationEvidence: (
      evidence: ExternalComponentActivationIncomplete | null,
    ) => {
      onboardSession.updateSession((session) => {
        session.externalComponentActivation = evidence;
      });
    },
    setDefaultSandbox: registry.setDefault,
  };
}
