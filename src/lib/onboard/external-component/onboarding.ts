// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { inspectPolicyMutationContext } from "../../policy";
import { configureDockerDriverGatewayExternalComponent } from "../docker-driver-gateway-env";
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
  } | null,
): PreparedExternalComponent | null {
  if (session?.externalComponentActivation) {
    throw new ExternalComponentContractError("lifecycle_unsupported");
  }
  return loadExternalComponentDeclaration();
}

export function initialFlowDeps(
  readiness: { collectGatewayReadiness(): Promise<unknown> },
  getDockerDriverGatewayEnv: () => Record<string, string>,
) {
  return {
    assertGatewayReadiness: () => readiness.collectGatewayReadiness().then(() => undefined),
    configureExternalComponentGateway: (externalComponent: {
      readonly componentId: string;
      readonly interceptorSocketPath: string;
    }) =>
      configureDockerDriverGatewayExternalComponent(getDockerDriverGatewayEnv(), externalComponent),
    prepareExternalComponent,
  };
}

type ExternalComponentActivationEvidence = {
  readonly schemaVersion: 1;
  readonly activationId: string;
  readonly componentId: string;
  readonly lifecycleGeneration: string;
  readonly sandboxIdentityFingerprint: string;
  readonly resultClass: "failed" | "ambiguous";
};

interface OnboardSessionAccess {
  updateSession(
    mutator: (session: {
      externalComponentActivation: ExternalComponentActivationEvidence | null;
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
      evidence: ExternalComponentActivationEvidence | null,
    ) => {
      onboardSession.updateSession((session) => {
        session.externalComponentActivation = evidence;
      });
    },
    setDefaultSandbox: registry.setDefault,
  };
}
