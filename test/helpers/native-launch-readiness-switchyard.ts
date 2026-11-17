// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { createSwitchyardProviderFixture } from "../support/switchyard-provider-adapter";
import { createHermesSwitchyardRoutingIntent } from "../../src/lib/hermes-switchyard-routing";
import { managedStartupE2eProfile } from "../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../../src/lib/onboard/managed-startup/profile";
import { entry } from "./native-launch-readiness.ts";
import type { SandboxEntry } from "../../src/lib/state/registry";

export async function createSwitchyardReadinessFixture(gatewayName: string, sandboxName: string) {
  const routing = createHermesSwitchyardRoutingIntent({
    efficient: { provider: "nvidia-prod", model: "nvidia/nano" },
    capable: { provider: "openai-api", model: "gpt-5" },
  });
  const f = createSwitchyardProviderFixture(routing, gatewayName, sandboxName);
  const { bindings } = await f.setup();
  const encodedProfile = encodeManagedStartupProfile({
    ...managedStartupE2eProfile("hermes"),
    agentConfig: {
      agent: "hermes",
      webSearch: { enabled: false, provider: "tavily" },
      switchyardRouting: routing,
      switchyardBindings: bindings,
    },
  });
  const routedEntry = {
    ...entry("hermes"),
    provider: routing.capable.provider,
    model: routing.capable.model,
    credentialEnv: "OPENAI_API_KEY",
    endpointUrl: "https://api.openai.com/v1",
    hermesSwitchyard: { routing, bindings },
    workload: {
      schemaVersion: 1,
      kind: "managed-image",
      reference: `ghcr.io/nvidia/nemoclaw/hermes-sandbox@sha256:${"1".repeat(64)}`,
      release: "v0.1.0",
      sourceRevision: "2".repeat(40),
      sourceCohort: "ghrun-1-1",
      capabilityContractVersion: 1,
      startupProfileContractVersion: 1,
      encodedProfile,
      startupProfileSha256: createHash("sha256").update(encodedProfile).digest("hex"),
      credentialProxyReplayRequired: false,
      shared: true,
    },
  } satisfies SandboxEntry;
  return { f, routedEntry };
}
