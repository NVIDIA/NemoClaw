// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const OPENCLAW_SANDBOX_BASE_IMAGE = "ghcr.io/nvidia/nemoclaw/sandbox-base";
export const SANDBOX_BASE_TAG = "latest";
export const OPENSHELL_SANDBOX_MIN_GLIBC = "2.39";
export const SANDBOX_BASE_RESOLUTION_LABEL = "com.nvidia.nemoclaw.base-resolution";
export const SANDBOX_BASE_RESOLUTION_KEY_LABEL = "com.nvidia.nemoclaw.base-resolution-key";
export const SANDBOX_BASE_RESOLUTION_SCHEMA = 1;
export const SANDBOX_BASE_IMAGE_RESOLUTION_SOURCES = [
  "override",
  "pinned",
  "version-tag",
  "source-sha",
  "latest",
  "local",
] as const;

export type SandboxBaseImageResolutionSource =
  (typeof SANDBOX_BASE_IMAGE_RESOLUTION_SOURCES)[number];

export type SandboxBaseImageResolutionMetadata = {
  schema: number;
  key: string;
  imageName: string;
  ref: string;
  digest: string | null;
  source: SandboxBaseImageResolutionSource;
  pinnedRemoteRef?: string;
  imageId: string;
  os: string;
  architecture: string;
  glibcVersion: string | null;
  requireOpenshellSandboxAbi: boolean;
  minGlibcVersion: string;
};

export type ResolveBaseImageOptions = {
  imageName: string;
  dockerfilePath: string;
  inputPaths?: string[];
  localTag: string;
  envVar?: string;
  label?: string;
  requireOpenshellSandboxAbi?: boolean;
  minGlibcVersion?: string;
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  pinnedRemoteRef?: string;
  preferPinnedRemoteRef?: boolean;
  validateImage?: (imageRef: string) => boolean;
  validationDescription?: string;
  resolutionHint?: SandboxBaseImageResolutionMetadata | null;
  forceRefresh?: boolean;
};

export type SandboxBaseImageResolution = {
  ref: string;
  digest: string | null;
  source: SandboxBaseImageResolutionSource;
  pinnedRemoteRef?: string;
  glibcVersion: string | null;
  metadata?: SandboxBaseImageResolutionMetadata;
};

export type LocalImageMetadata = {
  Id?: unknown;
  RepoDigests?: unknown;
  Os?: unknown;
  Architecture?: unknown;
  Config?: { Labels?: unknown } | null;
};

export type BaseImageResolutionValidation =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "key_mismatch"
        | "pinned_ref_mismatch"
        | "requirements_changed"
        | "abi_incompatible"
        | "local_image_changed"
        | "repo_digest_missing";
    };
