// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, onTestFinished } from "vitest";
import { managedBraveProfile } from "../../../../test/fixtures/openshell-provider-profile";
import {
  hostedNativeProvider,
  HOSTED_NATIVE_PROVIDERS,
  type HostedProviderDefinition,
} from "../../inference/native-provider/hosted";
import { nativeProviderLifecycle } from "../../inference/native-provider";
import { boundHermesNativeProfile } from "../../inference/native-provider/hermes-profile";
import {
  customNativeProvider,
  boundCustomNativeProfile,
} from "../../inference/native-provider/custom";
import { parseCheckedInProviderProfileContract } from "./provider-profile";
import { isManagedNativeHostedProfileResponse } from "./native-hosted-profile-response";

function response(definition: HostedProviderDefinition) {
  const profilePath = nativeProviderLifecycle(definition).nativeProviderProfilePath();
  const contract = parseCheckedInProviderProfileContract(
    definition.custom
      ? boundCustomNativeProfile(definition, profilePath)
      : definition.endpointUrl
        ? boundHermesNativeProfile(definition)
        : fs.readFileSync(profilePath, "utf8"),
  )!;
  const base = managedBraveProfile();
  const credential = contract.boundary.credentials[0];
  const endpoint = contract.boundary.endpoints[0] as {
    host: string;
    port: number;
    allowed_ips?: string[];
    rules: { allow: { method: string; path: string } }[];
  };
  return {
    profile: {
      ...base,
      id: definition.profileId,
      inferenceCapable: true,
      credentials: [
        {
          ...base.credentials[0],
          envVars: credential.env_vars,
          authStyle: credential.auth_style,
          headerName: credential.header_name,
        },
      ],
      endpoints: [
        {
          ...base.endpoints[0],
          host: endpoint.host,
          port: endpoint.port,
          tls: 0,
          allowedIps: endpoint.allowed_ips ?? [],
          access: 0,
          rules: endpoint.rules.map((rule) => ({
            allow: {
              ...rule.allow,
              command: "",
              query: {},
              operationType: "",
              operationName: "",
              fields: [],
              params: {},
            },
          })),
        },
      ],
      binaries: contract.boundary.binaries.map((path) => ({ path })),
    },
  };
}

describe.each(HOSTED_NATIVE_PROVIDERS)("native $label profile read boundary", (definition) => {
  it("accepts the checked-in credential, endpoint, executable and request restrictions", () => {
    const value = response(definition);
    expect(isManagedNativeHostedProfileResponse(value, definition.profileId)).toBe(value);
  });
  it.each([
    ["disabled TLS inspection", { tls: 1 }],
    ["removed explicit TLS termination", { tls: 2 }],
    ["removed TLS passthrough", { tls: 3 }],
    ["audit-only enforcement", { enforcement: 2 }],
    ["unspecified enforcement", { enforcement: 0 }],
    ["unrestricted read-write access", { access: 2 }],
    ["an unknown access preset", { access: 999 }],
    ["legacy string enums", { tls: "", enforcement: "enforce", access: "" }],
  ])("rejects %s", (_label, mutation) => {
    const value = response(definition);
    const profile = {
      ...value.profile,
      endpoints: [{ ...value.profile.endpoints[0], ...mutation }],
    };
    expect(isManagedNativeHostedProfileResponse({ profile }, definition.profileId)).toBeUndefined();
  });
  it.each(["/usr/bin/python3*", "/usr/bin/python3.12", "/unapproved"])(
    "rejects replacing the Hermes interpreter with %s",
    (path) => {
      const value = response(definition);
      value.profile.binaries = value.profile.binaries.map((binary) =>
        binary.path === "/usr/bin/python3.13" ? { path } : binary,
      );
      expect(isManagedNativeHostedProfileResponse(value, definition.profileId)).toBeUndefined();
    },
  );
  it("rejects extra egress or executable access", () => {
    const value = response(definition);
    expect(
      isManagedNativeHostedProfileResponse(
        {
          profile: {
            ...value.profile,
            endpoints: [...value.profile.endpoints, value.profile.endpoints[0]],
          },
        },
        definition.profileId,
      ),
    ).toBeUndefined();
    expect(
      isManagedNativeHostedProfileResponse(
        {
          profile: {
            ...value.profile,
            binaries: [...value.profile.binaries, { path: "/unapproved" }],
          },
        },
        definition.profileId,
      ),
    ).toBeUndefined();
  });
  it("rejects altered authentication or destination authority", () => {
    const value = response(definition);
    expect(
      isManagedNativeHostedProfileResponse(
        {
          profile: {
            ...value.profile,
            credentials: [{ ...value.profile.credentials[0], envVars: ["UNRELATED_API_KEY"] }],
          },
        },
        definition.profileId,
      ),
    ).toBeUndefined();
    expect(
      isManagedNativeHostedProfileResponse(
        {
          profile: {
            ...value.profile,
            endpoints: [{ ...value.profile.endpoints[0], host: "unrelated.example" }],
          },
        },
        definition.profileId,
      ),
    ).toBeUndefined();
  });
});

it.each([
  ["compatible-endpoint", "openai-completions", "http://custom.example/team/v1", ["8.8.8.8"]],
  ["compatible-endpoint", "openai-responses", "https://custom.example/team/v1", ["8.8.8.8"]],
  [
    "compatible-anthropic-endpoint",
    "anthropic-messages",
    "https://custom.example/team",
    ["10.0.0.8"],
  ],
] as const)(
  "verifies custom %s %s against its complete binding",
  (provider, api, endpointUrl, allowedIps) => {
    const definition = customNativeProvider({
      provider,
      api,
      endpointUrl,
      allowedIps,
      credentialEnv: "TEAM_KEY",
    });
    const value = response(definition);
    const read = (observed: unknown, binding = definition.custom) =>
      isManagedNativeHostedProfileResponse(
        observed,
        definition.profileId,
        definition.endpointUrl,
        definition.allowedIps,
        binding,
      );
    expect(read(value)).toBe(value);
    expect(
      read({
        profile: {
          ...value.profile,
          endpoints: [
            {
              ...value.profile.endpoints[0],
              tls: 1,
            },
          ],
        },
      }),
    ).toBeUndefined();
    expect(
      read(value, { ...definition.custom!, credentialEnv: "DIFFERENT_SOURCE" }),
    ).toBeUndefined();
    expect(
      read({
        profile: {
          ...value.profile,
          endpoints: [{ ...value.profile.endpoints[0], allowedIps: ["1.1.1.1"] }],
        },
      }),
    ).toBeUndefined();
    expect(
      read({
        profile: {
          ...value.profile,
          credentials: [{ ...value.profile.credentials[0], envVars: ["TEAM_KEY"] }],
        },
      }),
    ).toBeUndefined();
    expect(
      read({
        profile: {
          ...value.profile,
          endpoints: [
            {
              ...value.profile.endpoints[0],
              rules: [...value.profile.endpoints[0].rules, value.profile.endpoints[0].rules[0]],
            },
          ],
        },
      }),
    ).toBeUndefined();
  },
);

it("requires the exact public IP restriction on a Hermes bound profile", () => {
  const endpointUrl = "https://staging.nous.example/v1";
  const definition = hostedNativeProvider("hermes-provider", endpointUrl)!;
  const base = response(HOSTED_NATIVE_PROVIDERS[4]);
  const value = {
    profile: {
      ...base.profile,
      id: definition.profileId,
      endpoints: [
        { ...base.profile.endpoints[0], host: "staging.nous.example", allowedIps: ["8.8.8.8"] },
      ],
    },
  };
  expect(
    isManagedNativeHostedProfileResponse(value, definition.profileId, endpointUrl, ["8.8.8.8"]),
  ).toBe(value);
  expect(
    isManagedNativeHostedProfileResponse(value, definition.profileId, endpointUrl, ["1.1.1.1"]),
  ).toBeUndefined();
  expect(
    isManagedNativeHostedProfileResponse(value, definition.profileId, endpointUrl),
  ).toBeUndefined();
  value.profile.endpoints[0].allowedIps = ["10.0.0.1"];
  expect(
    isManagedNativeHostedProfileResponse(value, definition.profileId, endpointUrl, ["10.0.0.1"]),
  ).toBeUndefined();
});

it.each([
  { endpointUrl: "http://8.8.8.8/team/v1", allowedIps: ["8.8.8.8"] },
  { endpointUrl: "https://[2001:4860:4860::8888]/team/v1", allowedIps: ["2001:4860:4860::8888"] },
  { endpointUrl: "http://host.openshell.internal:42103/team/v1", allowedIps: undefined },
])(
  "validates the runtime response for retained Hermes $endpointUrl",
  ({ endpointUrl, allowedIps }) => {
    const definition = { ...hostedNativeProvider("hermes-provider", endpointUrl)!, allowedIps };
    const value = response(definition);
    expect(
      isManagedNativeHostedProfileResponse(value, definition.profileId, endpointUrl, allowedIps),
    ).toBe(value);
    expect(
      isManagedNativeHostedProfileResponse(value, definition.profileId, endpointUrl, ["1.1.1.1"]),
    ).toBeUndefined();
    value.profile.endpoints[0].port += 1;
    expect(
      isManagedNativeHostedProfileResponse(value, definition.profileId, endpointUrl, allowedIps),
    ).toBeUndefined();
  },
);

it.each([
  { service: "gateway", directory: ".nemoclaw/gateways/42103", routerPort: null },
  { service: "Model Router", directory: ".nemoclaw", routerPort: 42103 },
])(
  "rejects a retained Hermes response after its port is reserved for $service",
  ({ directory, routerPort }) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-response-port-"));
    onTestFinished(() => fs.rmSync(home, { recursive: true, force: true }));
    vi.stubEnv("HOME", home);
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "");
    vi.stubEnv("NEMOCLAW_MODEL_ROUTER_PORT", "");
    const endpointUrl = "http://host.openshell.internal:42103/team/v1";
    const definition = hostedNativeProvider("hermes-provider", endpointUrl)!;
    const value = response(definition);
    expect(isManagedNativeHostedProfileResponse(value, definition.profileId, endpointUrl)).toBe(
      value,
    );
    const root = path.join(home, directory);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "onboard-session.json"),
      JSON.stringify({ routerPort, routerPid: null, routerCredentialHash: null }),
    );
    expect(
      isManagedNativeHostedProfileResponse(value, definition.profileId, endpointUrl),
    ).toBeUndefined();
  },
);
