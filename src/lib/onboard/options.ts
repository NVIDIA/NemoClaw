// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HermesDashboardConfig } from "../hermes-dashboard";
import type { WebSearchConfig } from "../inference/web-search";
import type { ResourceProfile } from "../resources-cmd";
import type { CustomPolicyEntry } from "../state/registry";
import type { PreparedSandboxBuildContext } from "./build-context-stage";
import type { FatalRuntimePreflightResult } from "./fatal-runtime-preflight";
import type { InitialSandboxPolicy } from "./initial-policy";

export type AuthoritativeMessagingReuse = {
  providers: string[];
  channels: string[];
  disabledChannels: string[];
  detachProviders: string[];
  extraProviders: string[];
  extraPlaceholderKeys: string[];
};

export type OnboardOptions = {
  nonInteractive?: boolean;
  recreateSandbox?: boolean;
  authoritativeResumeConfig?: boolean;
  /** Internal persisted policy replay; ambient policy-tier env is ignored. */
  authoritativePolicyTier?: string | null;
  /** Internal exact CPU/RAM replay; null explicitly keeps the default resources. */
  authoritativeResourceProfile?: ResourceProfile | null;
  /** Internal persisted Hermes dashboard replay. */
  authoritativeHermesDashboardConfig?: HermesDashboardConfig | null;
  /** Internal exact web-search replay; null explicitly keeps it disabled. */
  authoritativeWebSearchConfig?: WebSearchConfig | null;
  /** True only after rebuild validated the retained Brave credential. */
  authoritativeWebSearchValidated?: boolean;
  /** True only after rebuild ran messaging conflict hooks for the staged plan. */
  authoritativeMessagingPrevalidated?: boolean;
  /** Exact provider attachments validated for rebuild; ambient tokens are ignored. */
  authoritativeMessagingReuse?: AuthoritativeMessagingReuse;
  /** Exact fatal-runtime result prepared while the original sandbox existed. */
  authoritativeRuntimePreflight?: FatalRuntimePreflightResult;
  /** Exact boot policy prepared and parsed before destructive rebuild work. */
  authoritativeInitialPolicy?: InitialSandboxPolicy;
  /** Exact custom policy metadata already merged into the prepared boot policy. */
  authoritativeCustomPolicies?: CustomPolicyEntry[];
  /** Internal authoritative rebuild target; never exposed as a public option. */
  targetGatewayName?: string | null;
  /** Internal authoritative rebuild target; must match targetGatewayName. */
  targetGatewayPort?: number | null;
  /** Internal rebuild handoff: the outer lifecycle owns the onboard lock. */
  onboardLockAlreadyHeld?: boolean;
  /** Exact staged + patched context already built before the old sandbox was removed. */
  preparedBuildContext?: PreparedSandboxBuildContext;
  /** GPU patch network mode produced by the retained Dockerfile preparation. */
  authoritativeDockerGpuPatchNetwork?: string | null;
  resume?: boolean;
  fresh?: boolean;
  fromDockerfile?: string | null;
  sandboxName?: string | null;
  sandboxGpu?: "enable" | "disable" | null;
  sandboxGpuDevice?: string | null;
  acceptThirdPartySoftware?: boolean;
  agent?: string | null;
  controlUiPort?: number | null;
  gpu?: boolean;
  noGpu?: boolean;
  autoYes?: boolean;
};
