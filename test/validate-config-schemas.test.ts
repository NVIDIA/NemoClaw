// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validate config files against their JSON Schemas.
 *
 * Complements validate-blueprint.test.ts (business-logic invariants) with
 * structural/type validation via JSON Schema. Runs as part of the "cli"
 * Vitest project.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import Ajv, { type ValidateFunction } from "ajv/dist/2020.js";
import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function repoPath(...segments: string[]): string {
  return join(REPO_ROOT, ...segments);
}

type LooseScalar = string | number | boolean | null;
type LooseValue = LooseScalar | LooseObject | LooseValue[];
type LooseObject = { [key: string]: LooseValue };

function parseJson<T>(text: string): T {
  return JSON.parse(text);
}

function isLooseValue(value: LooseValue | object | undefined): value is LooseValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isLooseValue(entry));
  }
  return isLooseObject(value);
}

function isLooseObject(value: LooseValue | object | undefined): value is LooseObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => isLooseValue(entry))
  );
}

function loadYAML(path: string): LooseObject {
  const parsed = YAML.parse(readFileSync(path, "utf-8"));
  if (!isLooseObject(parsed)) {
    throw new Error(`Expected YAML object in ${path}`);
  }
  return parsed;
}

function loadJSON(path: string): LooseObject {
  const parsed = parseJson<LooseValue>(readFileSync(path, "utf-8"));
  if (!isLooseObject(parsed)) {
    throw new Error(`Expected JSON object in ${path}`);
  }
  return parsed;
}

function compileSchema(schemaRelPath: string): ValidateFunction {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const schema = loadJSON(repoPath(schemaRelPath));
  return ajv.compile(schema);
}

function asRecord(value: LooseValue | undefined): LooseObject {
  return isLooseObject(value) ? value : {};
}

function cloneObject(value: LooseObject | undefined): LooseObject {
  return { ...asRecord(value) };
}

function expectValid(validate: ValidateFunction, data: object, label: string): void {
  const valid = validate(data);
  if (!valid) {
    const messages = (validate.errors ?? []).map((e) => `  ${e.instancePath || "/"}: ${e.message}`);
    expect.unreachable(`${label} failed schema validation:\n${messages.join("\n")}`);
  }
}

// ── Blueprint ────────────────────────────────────────────────────────────────

describe("blueprint.schema.json", () => {
  const validate = compileSchema("schemas/blueprint.schema.json");
  const data = loadYAML(repoPath("nemoclaw-blueprint/blueprint.yaml"));

  it("blueprint.yaml passes schema validation", () => {
    expectValid(validate, data, "blueprint.yaml");
  });

  it("rejects blueprint with missing required field", () => {
    const bad = cloneObject(data);
    delete bad.version;
    expect(validate(bad)).toBe(false);
  });

  it("rejects blueprint with wrong type for version", () => {
    const bad = { ...cloneObject(data), version: 123 };
    expect(validate(bad)).toBe(false);
  });

  it("rejects blueprint with unknown top-level property", () => {
    const bad = { ...cloneObject(data), unknownField: true };
    expect(validate(bad)).toBe(false);
  });

  it("rejects blueprint with unknown nested component property", () => {
    const root = asRecord(data);
    const components = asRecord(root.components);
    const inference = asRecord(components.inference);
    const bad = {
      ...root,
      components: {
        ...components,
        inference: {
          ...inference,
          extraField: true,
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects blueprint inference profile with unknown property", () => {
    const root = asRecord(data);
    const components = asRecord(root.components);
    const inference = asRecord(components.inference);
    const profiles = asRecord(inference.profiles);
    const defaultProfile = asRecord(profiles.default);
    const bad = {
      ...root,
      components: {
        ...components,
        inference: {
          ...inference,
          profiles: {
            ...profiles,
            default: {
              ...defaultProfile,
              typoField: true,
            },
          },
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects blueprint policyAddition endpoint with protocol rest but no rules", () => {
    const bad = {
      version: "1.0.0",
      profiles: ["default"],
      components: {
        sandbox: { image: "img:latest", name: "test-sandbox" },
        inference: {
          profiles: {
            default: { provider_type: "openai", endpoint: "https://api.openai.com" },
          },
        },
        policy: {
          base: "policies/openclaw-sandbox.yaml",
          additions: {
            my_service: {
              name: "My Service",
              endpoints: [{ host: "api.example.com", port: 443, protocol: "rest" }],
            },
          },
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });
});

// ── Base sandbox policy ──────────────────────────────────────────────────────

describe("sandbox-policy.schema.json", () => {
  const validate = compileSchema("schemas/sandbox-policy.schema.json");
  const data = loadYAML(repoPath("nemoclaw-blueprint/policies/openclaw-sandbox.yaml"));

  it("openclaw-sandbox.yaml passes schema validation", () => {
    expectValid(validate, data, "openclaw-sandbox.yaml");
  });

  it("rejects policy with missing network_policies", () => {
    const bad = cloneObject(data);
    delete bad.network_policies;
    expect(validate(bad)).toBe(false);
  });

  it("rejects policy with unknown top-level property", () => {
    const bad = { ...cloneObject(data), extra: true };
    expect(validate(bad)).toBe(false);
  });

  it("rejects sandbox-policy endpoint with protocol rest but no rules", () => {
    const bad = {
      version: 1,
      network_policies: {
        test_service: {
          name: "Test Service",
          endpoints: [{ host: "api.example.com", port: 443, protocol: "rest" }],
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });
});

// ── Policy presets ───────────────────────────────────────────────────────────

describe("policy-preset.schema.json", () => {
  const validate = compileSchema("schemas/policy-preset.schema.json");
  const presetsDir = repoPath("nemoclaw-blueprint/policies/presets");

  let presetFiles: string[] = [];
  try {
    presetFiles = readdirSync(presetsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
    if (code !== "ENOENT") throw err;
    // directory may not exist
  }

  for (const file of presetFiles) {
    it(`${file} passes schema validation`, () => {
      const data = loadYAML(join(presetsDir, file));
      expectValid(validate, data, file);
    });
  }

  it("rejects preset without preset metadata", () => {
    const bad = {
      network_policies: {
        test: { name: "test", endpoints: [{ host: "a.com", port: 443, access: "full" }] },
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects preset without network_policies", () => {
    const bad = { preset: { name: "test", description: "test" } };
    expect(validate(bad)).toBe(false);
  });

  it("rejects preset endpoint with protocol rest but no rules", () => {
    const bad = {
      preset: { name: "test", description: "test" },
      network_policies: {
        test_service: {
          name: "Test Service",
          endpoints: [{ host: "api.example.com", port: 443, protocol: "rest" }],
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });
});

// ── OpenClaw plugin manifest ─────────────────────────────────────────────────

describe("openclaw-plugin.schema.json", () => {
  const validate = compileSchema("schemas/openclaw-plugin.schema.json");
  const data = loadJSON(repoPath("nemoclaw/openclaw.plugin.json"));

  it("openclaw.plugin.json passes schema validation", () => {
    expectValid(validate, data, "openclaw.plugin.json");
  });

  it("rejects plugin with missing id", () => {
    const bad = cloneObject(data);
    delete bad.id;
    expect(validate(bad)).toBe(false);
  });

  it("rejects plugin with invalid version format", () => {
    const bad = { ...cloneObject(data), version: "not-semver" };
    expect(validate(bad)).toBe(false);
  });
});
