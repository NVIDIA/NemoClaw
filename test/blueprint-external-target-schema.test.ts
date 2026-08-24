// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

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
const externalTarget = {
  endpoint: "https://openshell.example.test:8443",
  workspace: "default",
  expected_release: "0.0.106",
  lifecycle: "external",
  trust: { ca_file: "/run/secrets/openshell/ca.pem" },
  authentication: {
    kind: "oidc",
    token_file: "/run/secrets/openshell/token",
  },
};

describe("blueprint external OpenShell target schema", () => {
  it("accepts one explicit target", () => {
    const blueprint = {
      ...baseBlueprint,
      min_openshell_version: "0.0.106",
      max_openshell_version: "0.0.106",
      openshell_target: externalTarget,
    };

    expect(validate(blueprint), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects mixed local and external lifecycle fields", () => {
    const blueprint = {
      ...baseBlueprint,
      openshell_target: {
        ...externalTarget,
        local: { mode: "managed" },
      },
    };

    expect(validate(blueprint)).toBe(false);
  });

  it("accepts the mTLS authentication form", () => {
    const blueprint = {
      ...baseBlueprint,
      min_openshell_version: "0.0.106",
      max_openshell_version: "0.0.106",
      openshell_target: {
        ...externalTarget,
        authentication: {
          kind: "mtls",
          client_certificate_file: "/run/secrets/openshell/client.crt",
          client_key_file: "/run/secrets/openshell/client.key",
        },
      },
    };

    expect(validate(blueprint), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects mixed authentication forms", () => {
    const blueprint = {
      ...baseBlueprint,
      min_openshell_version: "0.0.106",
      max_openshell_version: "0.0.106",
      openshell_target: {
        ...externalTarget,
        authentication: {
          kind: "oidc",
          token_file: "/run/secrets/openshell/token",
          client_certificate_file: "/run/secrets/openshell/client.crt",
          client_key_file: "/run/secrets/openshell/client.key",
        },
      },
    };

    expect(validate(blueprint)).toBe(false);
  });

  it("rejects a target without the OpenShell release range", () => {
    const blueprint = {
      ...baseBlueprint,
      openshell_target: externalTarget,
    };

    expect(validate(blueprint)).toBe(false);
  });
});
