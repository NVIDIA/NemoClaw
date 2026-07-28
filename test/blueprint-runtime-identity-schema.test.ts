// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isRuntimeIdentityConfig } from "../nemoclaw/src/blueprint/runtime-identity.ts";
import { compileConfigSchema } from "../scripts/validate-configs.mts";

const validate = compileConfigSchema("schemas/blueprint.schema.json");
const baseBlueprint = {
  version: "1.0.0",
  profiles: ["default"],
  components: {
    sandbox: { image: "example.invalid/nemoclaw:fixture", name: "fixture" },
    inference: {
      profiles: {
        default: { provider_type: "openai", endpoint: "https://api.example.com" },
      },
    },
  },
};
const runtimeIdentity = {
  profile_path: "provider-profiles/okta-runtime-v1.yaml",
  provider_type: "okta-runtime-v1",
  provider_name: "acme-okta-runtime",
  credential_key: "OKTA_ACCESS_TOKEN",
  client_id_env: "OKTA_CLIENT_ID",
  refresh_token_env: "OKTA_REFRESH_TOKEN",
  client_secret_env: "OKTA_CLIENT_SECRET",
};

const oboRuntimeIdentity = {
  profile_path: "provider-profiles/okta-obo-v1.yaml",
  provider_type: "okta-obo-v1",
  provider_name: "acme-okta-obo",
  credential_key: "OKTA_OBO_ACCESS_TOKEN",
  client_id_env: "OKTA_CLIENT_ID",
  client_secret_env: "OKTA_CLIENT_SECRET",
  subject_token_env: "OKTA_SUBJECT_TOKEN",
  token_url: "https://example.okta.com/oauth2/default/v1/token",
  audience: "api://orders",
  scopes: ["orders.read"],
};

function blueprintWithIdentity(identity: object): object {
  return {
    ...baseBlueprint,
    components: { ...baseBlueprint.components, identity },
  };
}

describe("blueprint runtime identity schema", () => {
  it("accepts the provider-neutral contract", () => {
    expect(validate(blueprintWithIdentity(runtimeIdentity)), JSON.stringify(validate.errors)).toBe(
      true,
    );
    expect(isRuntimeIdentityConfig(runtimeIdentity)).toBe(true);
  });

  it("accepts the host-managed Okta OBO contract", () => {
    expect(
      validate(blueprintWithIdentity(oboRuntimeIdentity)),
      JSON.stringify(validate.errors),
    ).toBe(true);
    expect(isRuntimeIdentityConfig(oboRuntimeIdentity)).toBe(true);
  });

  it("rejects an identity-provider discriminator", () => {
    expect(validate(blueprintWithIdentity({ okta: runtimeIdentity }))).toBe(false);
  });

  it.each([
    "NODE_OPTIONS",
    "MYTOKEN",
    "OPENSHELL_TOKEN",
  ])("rejects unsafe secret-material name %s", (refreshTokenEnvironment) => {
    expect(
      validate(
        blueprintWithIdentity({
          ...runtimeIdentity,
          refresh_token_env: refreshTokenEnvironment,
        }),
      ),
    ).toBe(false);
  });

  it("rejects identity values forwarded by the general subprocess allowlist", () => {
    expect(
      validate(
        blueprintWithIdentity({
          ...runtimeIdentity,
          client_id_env: "XDG_CLIENT_ID",
        }),
      ),
    ).toBe(false);
  });

  it("rejects a client ID name that the runner's structural contract rejects", () => {
    const unsupportedIdentity = {
      ...runtimeIdentity,
      client_id_env: "OTHER_ID",
    };
    expect(validate(blueprintWithIdentity(unsupportedIdentity))).toBe(false);
    expect(isRuntimeIdentityConfig(unsupportedIdentity)).toBe(false);
  });

  it("rejects a token-exchange config that mixes the refresh flow", () => {
    expect(
      validate(
        blueprintWithIdentity({
          ...oboRuntimeIdentity,
          refresh_token_env: "OKTA_REFRESH_TOKEN",
        }),
      ),
    ).toBe(false);
  });
});
