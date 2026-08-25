// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// sourceOfTruth: nemoclaw/src/shared/openshell-observation-boundary.cts
// generatedBoundary: build:cli emits the canonical .cjs/.d.cts before this
// implementation-free CLI wrapper is compiled.
export {
  externalOpenShellGateway,
  namedOpenShellGateway,
  observeExternalOpenShellTarget,
  selectedOpenShellGateway,
} from "../../../../nemoclaw/dist/shared/openshell-observation-boundary.cjs";

export type {
  AuthenticatedOpenShellExternalTargetObserver,
  ExternalOpenShellTargetObservation,
  ListOpenShellSandboxesRequest,
  LookupOpenShellSandboxRequest,
  ObserveExternalOpenShellTargetRequest,
  OpenShellCurrentUserObservation,
  OpenShellExternalGatewayTarget,
  OpenShellExternalTargetError,
  OpenShellExternalTargetObserver,
  OpenShellExternalTargetResult,
  OpenShellGatewayHealthObservation,
  OpenShellGatewayHealthStatus,
  OpenShellGatewayTarget,
  OpenShellSandboxError,
  OpenShellSandboxErrorKind,
  OpenShellSandboxInventory,
  OpenShellSandboxLookup,
  OpenShellSandboxObservation,
  OpenShellSandboxObserver,
  OpenShellSandboxReadiness,
  OpenShellSandboxResult,
  OpenShellSandboxTransportReason,
  OpenShellWorkspaceObservation,
  OpenShellWorkspacePhase,
} from "../../../../nemoclaw/dist/shared/openshell-observation-boundary.cjs";
