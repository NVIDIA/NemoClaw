// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { compileConfigSchema } from "../../scripts/validate-configs.mts";

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
  trust: { ca_file: "/var/run/openshell-target/ca.pem" },
  authentication: {
    credential_file: "/var/run/openshell-target/authentication",
  },
};

function blueprintWithExternalTarget(target: object = externalTarget): object {
  return {
    version: "1.0.0",
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
  it("accepts one explicit target without managed components", () => {
    expect(validate(blueprintWithExternalTarget()), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    ["components", { components: createBlueprint().components }],
    ["profiles", { profiles: ["default"] }],
    ["min_openclaw_version", { min_openclaw_version: "2026.8.0" }],
  ])("rejects an external target with the managed-only field %s (#9872)", (_field, value) => {
    expect(
      validate({ ...blueprintWithExternalTarget(), ...value }),
      JSON.stringify(validate.errors),
    ).toBe(false);
  });

  it.each(["https://openshell.example.test:8443/", "https://[2001:db8::1]:8443"])(
    "accepts a valid bare HTTPS origin [%s]",
    (endpoint) => {
      expect(
        validate(blueprintWithExternalTarget({ ...externalTarget, endpoint })),
        JSON.stringify(validate.errors),
      ).toBe(true);
    },
  );

  it("rejects mixed local and external lifecycle fields", () => {
    const target = {
      ...externalTarget,
      local: { mode: "managed" },
    };

    expect(validate(blueprintWithExternalTarget(target))).toBe(false);
  });

  it.each([
    [
      "OIDC",
      {
        kind: "oidc",
        token_file: "/var/run/openshell-target/token",
      },
    ],
    [
      "mTLS",
      {
        kind: "mtls",
        client_certificate_file: "/var/run/openshell-target/client.crt",
        client_key_file: "/var/run/openshell-target/client.key",
      },
    ],
  ])("rejects the protocol-specific %s authentication form", (_name, authentication) => {
    const target = {
      ...externalTarget,
      authentication,
    };

    expect(validate(blueprintWithExternalTarget(target))).toBe(false);
  });

  it.each([
    [
      "credential-bearing endpoint",
      { ...externalTarget, endpoint: "https://user@openshell.example.test:8443" },
    ],
    [
      "endpoint path",
      { ...externalTarget, endpoint: "https://openshell.example.test:8443/gateway" },
    ],
    ["missing endpoint host", { ...externalTarget, endpoint: "https://:8443" }],
    [
      "out-of-range endpoint port",
      { ...externalTarget, endpoint: "https://openshell.example.test:99999" },
    ],
    ["malformed IPv6 endpoint", { ...externalTarget, endpoint: "https://[:::]" }],
    ["relative CA file", { ...externalTarget, trust: { ca_file: "ca.pem" } }],
    [
      "relative authentication file",
      { ...externalTarget, authentication: { credential_file: "authentication" } },
    ],
    [
      "unsafe-large expected release",
      { ...externalTarget, expected_release: "9007199254740992.0.0" },
    ],
  ])("rejects a target with a %s", (_name, target) => {
    expect(validate(blueprintWithExternalTarget(target))).toBe(false);
  });

  it("rejects a target without the OpenShell release range", () => {
    const blueprint = {
      version: "1.0.0",
      openshell_target: externalTarget,
    };

    expect(validate(blueprint)).toBe(false);
  });
});
