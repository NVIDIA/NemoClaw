// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { parseCheckedInProviderProfileContract } from "../../src/lib/adapters/openshell/provider-profile";
import { nativeProviderLifecycle } from "../../src/lib/inference/native-provider";
import { switchyardProviderDefinition } from "../../src/lib/onboard/switchyard/bindings";
import {
  fingerprintHermesSwitchyardRouting,
  serializeHermesSwitchyardRouting,
  type SwitchyardBindingState,
} from "../../src/lib/hermes-switchyard-routing";
import type { OpenShellPolicyInspection } from "../../src/lib/adapters/openshell/policy-boundary";
import type { SwitchyardPreflightDeps } from "../../src/lib/onboard/switchyard/preflight";

export function switchyardPreflightFixture(state: SwitchyardBindingState) {
  const policy = {
    policySource: "sandbox",
    policyIdentity: { hash: "1".repeat(64), activeVersion: 1 },
    effectivePolicy: {
      version: 1,
      network_policies: Object.fromEntries(
        state.bindings.providers.map((binding) => {
          const profile = parseCheckedInProviderProfileContract(
            readFileSync(
              nativeProviderLifecycle(
                switchyardProviderDefinition(binding.logicalProvider),
              ).nativeProviderProfilePath(),
              "utf8",
            ),
          )!;
          return [
            `_provider_${binding.providerName.replaceAll("-", "_")}`,
            {
              endpoints: profile.boundary.endpoints,
              binaries: profile.boundary.binaries.map((path) => ({ path })),
            },
          ];
        }),
      ),
    },
  } satisfies OpenShellPolicyInspection;
  const runtime = {
    version: 1,
    configuration: fingerprintHermesSwitchyardRouting(
      serializeHermesSwitchyardRouting(state.routing, state.bindings),
    ),
    package: "2".repeat(64),
    gateway: { pid: 123, startTime: 456 },
    credentialReferences: Object.fromEntries(
      state.bindings.providers.map((p) => [p.credentialEnv, "3".repeat(64)]),
    ),
  };
  const inspectSandboxPolicy = vi.fn(async () => ({
    ok: true as const,
    value: structuredClone(policy),
  }));
  const execute = vi.fn<NonNullable<SwitchyardPreflightDeps["execute"]>>(() => ({
    status: 0,
    signal: null,
    stdout: Buffer.from(JSON.stringify({ ok: true, evidence: runtime })),
    stderr: Buffer.alloc(0),
  }));
  return {
    policy,
    runtime,
    execute,
    inspectSandboxPolicy,
    deps: {
      execute,
      policyReader: {
        inspectSandboxPolicy,
        readSandboxPolicy: vi.fn(),
        readSandboxPolicyRevision: vi.fn(),
      },
    },
  };
}
