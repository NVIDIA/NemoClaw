// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { compileConfigSchema } from "../scripts/validate-configs.mts";

const validate = compileConfigSchema("schemas/blueprint.schema.json");

interface BlueprintFixture {
  version: string;
  profiles: string[];
  components: {
    sandbox: { image: string; name: string };
    inference: {
      profiles: {
        default: {
          provider_type: string;
          endpoint: string;
          provider_name?: string;
        };
      };
    };
  };
}

function createBlueprint(): BlueprintFixture {
  return {
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
}

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

function blueprintWithExternalTarget(target: object = externalTarget): object {
  return {
    ...createBlueprint(),
    min_openshell_version: "0.0.106",
    max_openshell_version: "0.0.106",
    openshell_target: target,
  };
}

describe("blueprint name schema", () => {
  it.each([
    ["a flag-like sandbox name", "--help"],
    ["a leading-dash sandbox name", "-x"],
    ["a command-substitution sandbox name", "$(id)"],
    ["an uppercase sandbox name", "TestSandbox"],
    ["a trailing-hyphen sandbox name", "sandbox-"],
    ["a 20-character sandbox name", "a".repeat(20)],
    ["a double-hyphen sandbox name", "legacy--sandbox"],
  ])("rejects blueprint with %s", (_label, name) => {
    const blueprint = createBlueprint();
    blueprint.components.sandbox.name = name;
    expect(validate(blueprint)).toBe(false);
  });

  it.each([
    ["accepts uppercase, dots, and underscores", "Provider_1.prod", true],
    ["accepts exactly 128 characters", `a${"b".repeat(127)}`, true],
    ["rejects command substitution", "$(id)", false],
    ["rejects a leading digit", "1provider", false],
    ["rejects a leading dash", "-provider", false],
    ["rejects whitespace and controls", "provider\nname", false],
    ["rejects 129 characters", `a${"b".repeat(128)}`, false],
  ])("%s in blueprint provider_name", (_label, providerName, expected) => {
    const blueprint = createBlueprint();
    blueprint.components.inference.profiles.default.provider_name = providerName;
    expect(validate(blueprint)).toBe(expected);
  });

  it("accepts blueprint with an exact 19-character sandbox name (#8497)", () => {
    const blueprint = createBlueprint();
    blueprint.components.sandbox.name = `a${"b".repeat(18)}`;
    expect(validate(blueprint), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("blueprint external OpenShell target schema", () => {
  it("accepts one explicit target", () => {
    expect(validate(blueprintWithExternalTarget()), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects mixed local and external lifecycle fields", () => {
    const target = {
      ...externalTarget,
      local: { mode: "managed" },
    };

    expect(validate(blueprintWithExternalTarget(target))).toBe(false);
  });

  it("accepts the mTLS authentication form", () => {
    const target = {
      ...externalTarget,
      authentication: {
        kind: "mtls",
        client_certificate_file: "/run/secrets/openshell/client.crt",
        client_key_file: "/run/secrets/openshell/client.key",
      },
    };

    expect(validate(blueprintWithExternalTarget(target)), JSON.stringify(validate.errors)).toBe(
      true,
    );
  });

  it("rejects mixed authentication forms", () => {
    const target = {
      ...externalTarget,
      authentication: {
        kind: "oidc",
        token_file: "/run/secrets/openshell/token",
        client_certificate_file: "/run/secrets/openshell/client.crt",
        client_key_file: "/run/secrets/openshell/client.key",
      },
    };

    expect(validate(blueprintWithExternalTarget(target))).toBe(false);
  });

  it("rejects a target without the OpenShell release range", () => {
    const blueprint = {
      ...createBlueprint(),
      openshell_target: externalTarget,
    };

    expect(validate(blueprint)).toBe(false);
  });
});
