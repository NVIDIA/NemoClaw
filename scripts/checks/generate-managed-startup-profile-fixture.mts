#!/usr/bin/env -S node --experimental-strip-types

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  encodeManagedStartupProfile,
  MANAGED_STARTUP_AGENTS,
  MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
  type ManagedStartupAgent,
  type ManagedStartupProfile,
} from "../../src/lib/onboard/managed-startup/profile.ts";

const AGENTS = new Set<ManagedStartupAgent>(MANAGED_STARTUP_AGENTS);

export const MANAGED_STARTUP_E2E_HTTP_PROXY = "http://fixture-http-proxy.example.test:18080";
export const MANAGED_STARTUP_E2E_HTTPS_PROXY = "http://fixture-https-proxy.example.test:18443";
export const MANAGED_STARTUP_E2E_NO_PROXY = ["localhost", "127.0.0.1", ".example.test"] as const;

// Real self-signed X.509 CA used by the no-network managed-image lifecycle
// gate. DCode additionally proves its hardened fetch transport selects the
// root-owned merged bundle containing these exact bytes.
export const MANAGED_STARTUP_E2E_CORPORATE_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUL3YNpyohvjOEzlwisLKfyiU3dRwwDQYJKoZIhvcNAQEL
BQAwJTEjMCEGA1UEAwwaTmVtb0NsYXcgVGVzdCBDb3Jwb3JhdGUgQ0EwHhcNMjYw
NzA2MDQwMjM2WhcNMzYwNzAzMDQwMjM2WjAlMSMwIQYDVQQDDBpOZW1vQ2xhdyBU
ZXN0IENvcnBvcmF0ZSBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
ALVbV5tyMc65jEH39ejvQvBk7dvI8rz8rSZl+5BWSK2a4TzKm3jD3U+qCDZPicrA
ETCDcO09bN6YIAgpB6rYg5BIURJWxFuljBIBMCZEdO6AVlbURPaGsw6RKLA3cmhx
ZekT0qMcoOKm3N+Hb5MHXsWZ8EUf0co2LsWwJgDZrdwY26gF6w+9wr3iGLE92ZbO
LHhjHUYR1oWXmkXS3YW8MN2h5I+oyL71jBiwLHUi59wogxA/LTAD97/GqwJ6DC4C
UERbIpGYhZfrbiKmT+ASJuKRXaUp/0My3IzH90RqqY70d1E/pkAsd5M8SQ332qAZ
OgW4GgO3n7gAlaN/ILwunZ8CAwEAAaNTMFEwHQYDVR0OBBYEFMa5M8bvDm85eFQi
1D5fNATE/rawMB8GA1UdIwQYMBaAFMa5M8bvDm85eFQi1D5fNATE/rawMA8GA1Ud
EwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8NR/0HBUH1WbbDOmGNDzge
o+4Pz0KWR5fPDSx9CrmvUk8ijKpJQcSjQcmrXuhCoRs6aExXLh+wImKkOyMIVXfd
YFWjCffSJzeBQfDlMVW+wiAjUh7xaIqpA6Z8EmpdfyoNWd30AuHjs9m8dAa8M/lP
0qhzCbjDiHNHfYSrAuBHlMJ5RsUrNVtSZGpg1dtaSBa+8XFWWNBeJrUANxb8i7Ax
MAhrfNQcxSkZH2lVY+TA2JO83v12nKXzaW1dC94SlsFf0tVSvM3QTeWVgijpr0q+
J0N7VBg2CdK6jRjKLQOSOPq3ySCicHhVRI8hxIWotif7mK3jj6D8NRalwmlHgNM=
-----END CERTIFICATE-----
`;

export function managedStartupE2eProfile(
  agent: ManagedStartupAgent,
  changed = false,
  withCorporateCa = false,
  withoutHostProxy = false,
): ManagedStartupProfile {
  const model = changed ? "nvidia/nemotron-3-super-120b-a12b" : "nvidia/nemotron-3-ultra-550b-a55b";
  const common = {
    schemaVersion: MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
    inference: {
      routeProvider: "inference",
      upstreamProvider: "nvidia",
      model,
      routedBaseUrl: "https://inference.local/v1",
      upstreamEndpointUrl: null,
      api: "openai-completions" as const,
    },
    proxy: {
      managedHost: "10.200.0.1",
      managedPort: 3128,
      hostHttpUrl: withoutHostProxy ? null : MANAGED_STARTUP_E2E_HTTP_PROXY,
      hostHttpsUrl: withoutHostProxy ? null : MANAGED_STARTUP_E2E_HTTPS_PROXY,
      hostNoProxy: withoutHostProxy ? [] : MANAGED_STARTUP_E2E_NO_PROXY,
    },
    tools: {
      disclosure: "progressive" as const,
      enabledGateways: [],
    },
    messaging: { plan: null },
    corporateCa: {
      bundleSha256: withCorporateCa
        ? createHash("sha256").update(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM).digest("hex")
        : null,
    },
  };

  switch (agent) {
    case "openclaw":
      return {
        ...common,
        agent,
        agentConfig: {
          agent,
          webSearch: { enabled: false, provider: "brave" },
          otel: {
            enabled: false,
            endpointUrl: "http://host.openshell.internal:4318",
            serviceName: "openclaw-gateway",
            sampleRate: 1,
          },
          agentTimeoutSeconds: 600,
          heartbeatEvery: null,
          extraAgents: { agents: [], defaults: {}, main: {} },
          deviceAuth: { disabled: true, optOutSource: "managed-onboard" },
          minimalBootstrap: true,
        },
        inference: {
          ...common.inference,
          primaryModelRef: `inference/${model}`,
          compatibility: {},
          inputModalities: ["text"],
        },
        dashboard: {
          agent,
          mode: "loopback",
          url: "http://127.0.0.1:18789",
          port: 18_789,
          bindAddress: "127.0.0.1",
          wslExposure: false,
        },
        tuning: {
          contextWindow: 131_072,
          maxTokens: 8192,
          reasoning: false,
          reasoningEffort: "default",
        },
      };
    case "hermes":
      return {
        ...common,
        agent,
        agentConfig: {
          agent,
          webSearch: { enabled: false, provider: "tavily" },
        },
        inference: {
          ...common.inference,
          primaryModelRef: null,
          compatibility: null,
          inputModalities: null,
        },
        dashboard: {
          agent,
          mode: "disabled",
          url: "http://127.0.0.1:18789",
          publicPort: null,
          internalPort: null,
          tuiEnabled: false,
        },
        tuning: {
          contextWindow: 131_072,
          maxTokens: null,
          reasoning: null,
          reasoningEffort: null,
        },
      };
    case "langchain-deepagents-code":
      return {
        ...common,
        agent,
        agentConfig: {
          agent,
          autoApprovalMode: "disabled",
          observabilityEnabled: false,
        },
        inference: {
          ...common.inference,
          upstreamEndpointUrl: "https://integrate.api.nvidia.com/v1",
          primaryModelRef: null,
          compatibility: null,
          inputModalities: null,
        },
        dashboard: {
          agent,
          mode: "disabled",
        },
        tuning: {
          contextWindow: null,
          maxTokens: null,
          reasoning: null,
          reasoningEffort: null,
        },
      };
    case "pi":
      return {
        ...common,
        agent,
        agentConfig: { agent },
        inference: {
          ...common.inference,
          primaryModelRef: null,
          compatibility: null,
          inputModalities: null,
        },
        dashboard: {
          agent,
          mode: "disabled",
        },
        tuning: {
          contextWindow: null,
          maxTokens: null,
          reasoning: null,
          reasoningEffort: null,
        },
      };
  }
}

function readAgent(value: string | undefined): ManagedStartupAgent {
  if (value && AGENTS.has(value as ManagedStartupAgent)) {
    return value as ManagedStartupAgent;
  }
  throw new Error("--agent must identify a shipped managed-image agent");
}

function main(argv: readonly string[]): void {
  if (argv.length === 1 && argv[0] === "--corporate-ca-b64") {
    process.stdout.write(
      `${Buffer.from(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM, "utf8").toString("base64")}\n`,
    );
    return;
  }
  const agentIndex = argv.indexOf("--agent");
  if (agentIndex < 0) throw new Error("--agent is required");
  const unexpected = argv.filter(
    (value, index) =>
      index !== agentIndex &&
      index !== agentIndex + 1 &&
      value !== "--changed" &&
      value !== "--corporate-ca" &&
      value !== "--without-host-proxy",
  );
  if (unexpected.length > 0) {
    throw new Error(`unsupported arguments: ${unexpected.join(" ")}`);
  }
  const agent = readAgent(argv[agentIndex + 1]);
  process.stdout.write(
    `${encodeManagedStartupProfile(
      managedStartupE2eProfile(
        agent,
        argv.includes("--changed"),
        argv.includes("--corporate-ca"),
        argv.includes("--without-host-proxy"),
      ),
    )}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
