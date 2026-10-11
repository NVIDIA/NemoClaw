// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { managedBraveProfile } from "../../../../test/fixtures/openshell-provider-profile";
import {
  hostedNativeProvider,
  HOSTED_NATIVE_PROVIDERS,
} from "../../inference/native-provider/hosted";
import { nativeProviderLifecycle } from "../../inference/native-provider";
import { parseCheckedInProviderProfileContract } from "./provider-profile";
import { isManagedNativeHostedProfileResponse } from "./native-hosted-profile-response";

function response(definition: (typeof HOSTED_NATIVE_PROVIDERS)[number]) {
  const contract = parseCheckedInProviderProfileContract(
    fs.readFileSync(nativeProviderLifecycle(definition).nativeProviderProfilePath(), "utf8"),
  )!;
  const base = managedBraveProfile();
  const credential = contract.boundary.credentials[0];
  const endpoint = contract.boundary.endpoints[0] as {
    host: string;
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
          access: "",
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
