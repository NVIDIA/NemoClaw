// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type OpenShellPolicyMapping = Record<string, unknown>;

export interface ParsedOpenShellPolicy {
  readonly yamlBody: string;
  readonly policy: OpenShellPolicyMapping;
}

export interface ParseOpenShellPolicyOptions {
  /** Preserve the root CLI's legacy acceptance of versionless policy mappings. */
  readonly allowUnmarkedPolicyBody?: boolean;
}

export function parseOpenShellPolicy(
  raw: string,
  options?: ParseOpenShellPolicyOptions,
): ParsedOpenShellPolicy;

export function withoutProviderComposedPolicies<T>(
  policies: Record<string, T>,
): Record<string, T>;

export function stripProviderComposedPolicies(policy: string): string;
