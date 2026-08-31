// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellGatewayTarget } from "./sandbox-observer";

export type OpenShellProviderCommandReason =
  | "already_exists"
  | "attached"
  | "failed"
  | "invalid_request"
  | "not_found"
  | "profile_export_failed"
  | "profile_import_failed"
  | "profile_incompatible";

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

export type OpenShellProviderRequest = Readonly<{
  target: OpenShellGatewayTarget;
  timeoutMs?: number;
}>;

export type OpenShellProviderInventory = Readonly<{
  names: readonly string[];
}>;

export type OpenShellProviderMetadata = Readonly<{
  name: string;
  type: string;
  credentialKeys: readonly string[];
  configKeys: readonly string[];
  revision?: Readonly<{
    id: string;
    resourceVersion: number;
  }> | null;
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

export type GetOpenShellProviderRequest = OpenShellProviderRequest &
  Readonly<{
    providerName: string;
  }>;

export type UpdateOpenShellProviderRequest = GetOpenShellProviderRequest &
  Readonly<{
    credentials: readonly Readonly<{ name: string; value: string }>[];
    config: readonly Readonly<{ key: string; value: string }>[];
  }>;

export type ImportOpenShellProviderProfileRequest = OpenShellProviderRequest &
  Readonly<{
    profilePath: string;
  }>;

export type EnsureOpenShellEndpointlessProviderProfileRequest =
  ImportOpenShellProviderProfileRequest &
    Readonly<{
      profileType: string;
      inferenceCapable: boolean;
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

export type OpenShellProviderProfileImport = Readonly<{
  state: "already_present" | "imported";
}>;

export type OpenShellEndpointlessProviderProfile = Readonly<{
  state: "ready";
}>;

export type OpenShellProviderCreate = Readonly<{
  state: "created";
}>;

export type OpenShellProviderUpdate = Readonly<{
  state: "updated";
}>;

export type OpenShellProviderDelete = Readonly<{
  state: "deleted";
}>;

export type OpenShellProviderDetach = Readonly<{
  state: "absent" | "detached";
}>;

/** Transport-neutral provider operations used by NemoClaw consumers. */
export interface OpenShellProviderAdapter {
  listProviders(
    request: OpenShellProviderRequest,
  ): Promise<OpenShellProviderResult<OpenShellProviderInventory>>;

  createProvider(
    request: CreateOpenShellProviderRequest,
  ): Promise<OpenShellProviderResult<OpenShellProviderCreate>>;

  getProvider(
    request: GetOpenShellProviderRequest,
  ): Promise<OpenShellProviderResult<OpenShellProviderMetadata>>;

  updateProvider(
    request: UpdateOpenShellProviderRequest,
  ): Promise<OpenShellProviderResult<OpenShellProviderUpdate>>;

  importProviderProfile(
    request: ImportOpenShellProviderProfileRequest,
  ): Promise<OpenShellProviderResult<OpenShellProviderProfileImport>>;

  ensureEndpointlessProviderProfile(
    request: EnsureOpenShellEndpointlessProviderProfileRequest,
  ): Promise<OpenShellProviderResult<OpenShellEndpointlessProviderProfile>>;

  inspectProviderProfile(
    request: InspectOpenShellProviderProfileRequest,
  ): Promise<OpenShellProviderResult<OpenShellProviderProfileInspection>>;

  deleteProvider(
    request: DeleteOpenShellProviderRequest,
  ): Promise<OpenShellProviderResult<OpenShellProviderDelete>>;

  detachProvider(
    request: DetachOpenShellProviderRequest,
  ): Promise<OpenShellProviderResult<OpenShellProviderDetach>>;
}
