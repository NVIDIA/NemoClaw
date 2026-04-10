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
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import Ajv, { type ValidateFunction } from "ajv/dist/2020.js";
import YAML from "yaml";

const REPO_ROOT = new URL("..", import.meta.url);

function repoPath(...segments: string[]): string {
  return new URL(join(...segments), REPO_ROOT).pathname;
}

function loadYAML(path: string): unknown {
  return YAML.parse(readFileSync(path, "utf-8"));
}

function loadJSON(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function compileSchema(schemaRelPath: string): ValidateFunction {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const schema = loadJSON(repoPath(schemaRelPath));
  return ajv.compile(schema as object);
}

function expectValid(validate: ValidateFunction, data: unknown, label: string): void {
  const valid = validate(data);
  if (!valid) {
    const messages = (validate.errors ?? []).map(
      (e) => `  ${e.instancePath || "/"}: ${e.message}`,
    );
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
    const bad = { ...(data as object) };
    delete (bad as Record<string, unknown>).version;
    expect(validate(bad)).toBe(false);
  });

  it("rejects blueprint with wrong type for version", () => {
    const bad = { ...(data as object), version: 123 };
    expect(validate(bad)).toBe(false);
  });

  it("rejects blueprint with unknown top-level property", () => {
    const bad = { ...(data as object), unknownField: true };
    expect(validate(bad)).toBe(false);
  });

  it("rejects blueprint with unknown nested component property", () => {
    const bad = {
      ...(data as object),
      components: {
        ...((data as Record<string, any>).components),
        inference: {
          ...((data as Record<string, any>).components.inference),
          extraField: true,
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects blueprint inference profile with unknown property", () => {
    const bad = {
      ...(data as object),
      components: {
        ...((data as Record<string, any>).components),
        inference: {
          ...((data as Record<string, any>).components.inference),
          profiles: {
            ...((data as Record<string, any>).components.inference.profiles),
            default: {
              ...((data as Record<string, any>).components.inference.profiles.default),
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
  const data = loadYAML(
    repoPath("nemoclaw-blueprint/policies/openclaw-sandbox.yaml"),
  );

  it("openclaw-sandbox.yaml passes schema validation", () => {
    expectValid(validate, data, "openclaw-sandbox.yaml");
  });

  it("rejects policy with missing network_policies", () => {
    const bad = { ...(data as object) };
    delete (bad as Record<string, unknown>).network_policies;
    expect(validate(bad)).toBe(false);
  });

  it("rejects policy with unknown top-level property", () => {
    const bad = { ...(data as object), extra: true };
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
    if ((err as { code?: string }).code !== "ENOENT") throw err;
    // directory may not exist
  }

  for (const file of presetFiles) {
    it(`${file} passes schema validation`, () => {
      const data = loadYAML(join(presetsDir, file));
      expectValid(validate, data, file);
    });
  }

  it("rejects preset without preset metadata", () => {
    const bad = { network_policies: { test: { name: "test", endpoints: [{ host: "a.com", port: 443, access: "full" }] } } };
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
    const bad = { ...(data as object) };
    delete (bad as Record<string, unknown>).id;
    expect(validate(bad)).toBe(false);
  });

  it("rejects plugin with invalid version format", () => {
    const bad = { ...(data as object), version: "not-semver" };
    expect(validate(bad)).toBe(false);
  });
});
