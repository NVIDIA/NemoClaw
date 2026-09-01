// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayTarget } from "./sandbox-observer";

export type OpenShellProviderCommandReason =
  | "already_exists"
  | "attached"
  | "failed"
  | "invalid_request"
  | "not_found"
  | "profile_incompatible"
  | "uncertain";

export type OpenShellProviderTransportReason =
  | "identity_mismatch"
  | "process_start"
  | "unreachable";

export type OpenShellProviderError =
  | Readonly<{
      kind: "authentication" | "schema" | "timeout" | "validation";
      message: string;
    }>
  | Readonly<{
      kind: "transport";
      reason: OpenShellProviderTransportReason;
      message: string;
    }>
  | Readonly<{
      kind: "command";
      reason: OpenShellProviderCommandReason;
      message: string;
      attachedSandboxes?: readonly string[];
    }>;

export type OpenShellProviderResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: OpenShellProviderError }>;

export type OpenShellProviderMutationResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: OpenShellProviderError }>;

export type OpenShellProviderRequest = Readonly<{
  target: OpenShellGatewayTarget;
  timeoutMs?: number;
}>;

export type OpenShellProviderInventory = Readonly<{
  names: readonly string[];
}>;

export type OpenShellProviderProfileInspection = Readonly<{
  credentialKeys: readonly string[];
}>;

export type CreateOpenShellProviderRequest = OpenShellProviderRequest &
  Readonly<{
    name: string;
    type: string;
    credentials: readonly Readonly<{ name: string; value: string }>[];
    config: readonly Readonly<{ key: string; value: string }>[];
    fromExisting: boolean;
  }>;

export type ImportOpenShellProviderProfileRequest = OpenShellProviderRequest &
  Readonly<{
    profilePath: string;
  }>;

export type InspectOpenShellProviderProfileRequest = OpenShellProviderRequest &
  Readonly<{
    profileType: string;
  }>;

export type DeleteOpenShellProviderRequest = OpenShellProviderRequest &
  Readonly<{
    providerName: string;
  }>;

export type DetachOpenShellProviderRequest = DeleteOpenShellProviderRequest &
  Readonly<{
    sandboxName: string;
  }>;

/** Transport-neutral provider capabilities used by NemoClaw credential actions. */
export interface OpenShellProviderAdapter {
  listProviders(
    request: OpenShellProviderRequest,
  ): Promise<OpenShellProviderResult<OpenShellProviderInventory>>;

  createProvider(request: CreateOpenShellProviderRequest): Promise<OpenShellProviderMutationResult>;

  importProviderProfile(
    request: ImportOpenShellProviderProfileRequest,
  ): Promise<OpenShellProviderMutationResult>;

  inspectProviderProfile(
    request: InspectOpenShellProviderProfileRequest,
  ): Promise<OpenShellProviderResult<OpenShellProviderProfileInspection>>;

  deleteProvider(request: DeleteOpenShellProviderRequest): Promise<OpenShellProviderMutationResult>;

  detachProvider(request: DetachOpenShellProviderRequest): Promise<OpenShellProviderMutationResult>;
}
