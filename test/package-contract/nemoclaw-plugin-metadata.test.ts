// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import {
  createMinimumOpenClawPluginApi,
  MINIMUM_OPENCLAW_PLUGIN_API_VERSION,
} from "./fixtures/minimum-openclaw-plugin-api";

const repoRoot = path.join(import.meta.dirname, "../..");
const pluginRoot = path.join(repoRoot, "nemoclaw");

type Release = readonly [year: number, month: number, day: number];

type PluginPackage = {
  openclaw?: {
    extensions?: unknown;
    compat?: {
      pluginApi?: unknown;
      minGatewayVersion?: unknown;
    };
    build?: {
      openclawVersion?: unknown;
    };
  };
};

function readPluginPackage(): PluginPackage {
  const result = spawnSync("npm", ["--prefix", pluginRoot, "pkg", "get", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(
    result.status,
    `npm could not read the plugin metadata: ${result.stdout}${result.stderr}`,
  ).toBe(0);
  return JSON.parse(result.stdout);
}

function parseRelease(value: unknown, label: string): Release {
  expect(value, `${label} must be a release string`).toBeTypeOf("string");
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(value as string);
  expect(match, `${label} must use the YYYY.M.D release format`).not.toBeNull();
  return [Number(match![1]), Number(match![2]), Number(match![3])];
}

function compareRelease(left: Release, right: Release): number {
  return (
    left.map((value, index) => value - right[index]!).find((difference) => difference !== 0) ?? 0
  );
}

function requireStringArray(value: unknown, label: string): string[] {
  expect(Array.isArray(value), `${label} must be an array`).toBe(true);
  const values = value as unknown[];
  expect(
    values.every((entry) => typeof entry === "string"),
    `${label} must contain strings`,
  ).toBe(true);
  return values as string[];
}

describe("packed NemoClaw plugin metadata", () => {
  it("ships an importable extension whose build satisfies the advertised host bounds", async () => {
    const packageJson = readPluginPackage();
    const extensions = packageJson.openclaw?.extensions;
    expect(extensions).toEqual([expect.stringMatching(/^\.\/dist\/.+\.js$/)]);
    const [extension] = requireStringArray(extensions, "openclaw.extensions");

    const extensionPath = path.join(pluginRoot, extension!);
    expect(fs.existsSync(extensionPath), "Run the plugin build before package contracts.").toBe(
      true,
    );
    const pluginModule = await import(pathToFileURL(extensionPath).href);
    expect(pluginModule.default).toBeTypeOf("function");
    const { api, registrations } = createMinimumOpenClawPluginApi();
    expect(() => pluginModule.default(api)).not.toThrow();
    expect(registrations.commands).toEqual([expect.objectContaining({ name: "nemoclaw" })]);
    expect(registrations.providers).toEqual([expect.objectContaining({ id: "inference" })]);
    expect(registrations.hookNames).toEqual(
      expect.arrayContaining(["before_prompt_build", "before_tool_call"]),
    );

    const pluginApi = packageJson.openclaw?.compat?.pluginApi;
    expect(pluginApi).toEqual(expect.stringMatching(/^>=\d{4}\.\d{1,2}\.\d{1,2}$/));
    const pluginApiMinimum = parseRelease((pluginApi as string).slice(2), "plugin API minimum");
    const gatewayMinimum = parseRelease(
      packageJson.openclaw?.compat?.minGatewayVersion,
      "gateway minimum",
    );
    const buildVersion = parseRelease(
      packageJson.openclaw?.build?.openclawVersion,
      "OpenClaw build version",
    );
    const minimumHostApi = parseRelease(
      MINIMUM_OPENCLAW_PLUGIN_API_VERSION,
      "minimum executable host fixture",
    );

    expect(pluginApiMinimum).toEqual(minimumHostApi);
    expect(gatewayMinimum).toEqual(minimumHostApi);
    expect(compareRelease(buildVersion, pluginApiMinimum)).toBeGreaterThanOrEqual(0);
    expect(compareRelease(buildVersion, gatewayMinimum)).toBeGreaterThanOrEqual(0);
  });

  it("includes every declared extension in the npm package", () => {
    const packageJson = readPluginPackage();
    const extensions = requireStringArray(packageJson.openclaw?.extensions, "openclaw.extensions");

    const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: pluginRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(packed.status, `${packed.stdout}${packed.stderr}`).toBe(0);
    const report = JSON.parse(packed.stdout) as Array<{ files?: Array<{ path?: string }> }>;
    const packedPaths = new Set((report[0]?.files ?? []).map((entry) => entry.path));

    expect(packedPaths).toContain("openclaw.plugin.json");
    for (const extension of extensions) {
      expect(packedPaths).toContain(extension.replace(/^\.\//, ""));
    }
  });
});
