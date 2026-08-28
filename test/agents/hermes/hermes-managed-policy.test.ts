// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HermesBuildSettings } from "../../../agents/hermes/config/build-env.ts";
import {
  buildHermesManagedPolicy,
  HERMES_MANAGED_POLICY_SCHEMA_VERSION,
} from "../../../agents/hermes/config/managed-policy.ts";

const READER_PATH = path.join(import.meta.dirname, "../../..", "agents", "hermes", "managed_policy.py");
const PROFILE_PATCHER_PATH = path.join(
  import.meta.dirname,
  "../../..",
  "agents",
  "hermes",
  "patch-profile-policy-defaults.py",
);
const DASHBOARD_SEEDER_PATH = path.join(
  import.meta.dirname,
  "../../..",
  "agents",
  "hermes",
  "seed-dashboard-config.py",
);
const SETTINGS: HermesBuildSettings = {
  model: "test-model",
  baseUrl: "https://inference.local/v1",
  providerKey: "nvidia-router",
  upstreamProvider: "NVIDIA Router",
  inferenceApi: "openai-completions",
  contextWindow: 128_000,
  toolDisclosure: "progressive",
  webSearchProvider: "tavily",
  messagingCredentialPlaceholders: [
    {
      envKey: "DISCORD_BOT_TOKEN",
      placeholder: "openshell:resolve:env:DISCORD_BOT_TOKEN",
    },
  ],
  managedToolGateways: { brokerEnabled: false, presets: [] },
  managedImageCapabilityUnion: false,
};

const PYTHON_LOAD = `
import importlib.util
import pathlib
import sys

reader_path = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("managed_policy", reader_path)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
try:
    module.load_managed_policy(pathlib.Path(sys.argv[2]))
except module.ManagedPolicyError as exc:
    print(exc, file=sys.stderr)
    raise SystemExit(1)
`;

function loadWithPython(document: unknown) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-managed-policy-"));
  const policyPath = path.join(tmp, "managed-policy.json");
  fs.writeFileSync(policyPath, `${JSON.stringify(document)}\n`);
  try {
    return spawnSync("python3", ["-I", "-c", PYTHON_LOAD, READER_PATH, policyPath], {
      encoding: "utf8",
      timeout: 5000,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("Hermes managed policy", () => {
  it("serializes one versioned policy with resolver-only credentials (#8008)", () => {
    const rawSecret = "raw-secret-must-not-appear";
    const policy = buildHermesManagedPolicy(SETTINGS, { DISCORD_BOT_TOKEN: rawSecret });
    const serialized = JSON.stringify(policy);

    expect(policy.schema_version).toBe(HERMES_MANAGED_POLICY_SCHEMA_VERSION);
    expect(Object.keys(policy).sort()).toEqual([
      "config",
      "dashboard",
      "env_lines",
      "managed_paths",
      "schema_version",
    ]);
    expect(policy.config._nemoclaw_upstream).toEqual({
      provider: "NVIDIA Router",
      provider_key: "nvidia-router",
      model: "test-model",
    });
    expect(policy.env_lines).toContain("DISCORD_BOT_TOKEN=openshell:resolve:env:DISCORD_BOT_TOKEN");
    expect(policy.dashboard.env_keys).not.toContain("API_SERVER_KEY");
    expect(serialized).not.toContain(rawSecret);
    expect(loadWithPython(policy).status).toBe(0);
  });

  it("rejects a schema change without an explicit migration (#8008)", () => {
    const policy = {
      ...buildHermesManagedPolicy(SETTINGS, {}),
      schema_version: HERMES_MANAGED_POLICY_SCHEMA_VERSION + 1,
    };

    const result = loadWithPython(policy);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has no migration to 1");
  });

  it("rejects a raw model credential without echoing it (#8008)", () => {
    const rawCredential = "sk-raw-policy-credential";
    const policy = structuredClone(buildHermesManagedPolicy(SETTINGS, {}));
    const malformedPolicy = {
      ...policy,
      config: {
        ...policy.config,
        model: { ...policy.config.model, api_key: rawCredential },
      },
    };

    const result = loadWithPython(malformedPolicy);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must use the OpenShell proxy rewrite sentinel");
    expect(result.stderr).not.toContain(rawCredential);
  });

  it("loads the shared reader under the image's isolated Python mode (#8008)", () => {
    const patcher = spawnSync("python3", ["-I", PROFILE_PATCHER_PATH, "--help"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const seeder = spawnSync("python3", ["-I", DASHBOARD_SEEDER_PATH], {
      encoding: "utf8",
      timeout: 5000,
    });

    expect(patcher.status, patcher.stderr).toBe(0);
    expect(seeder.status).toBe(1);
    expect(seeder.stderr).toContain("usage: seed-dashboard-config.py");
    expect(seeder.stderr).not.toContain("ModuleNotFoundError");
  });
});
