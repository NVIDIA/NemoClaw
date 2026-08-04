// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { build } from "esbuild";

interface PackageLicense {
  name: string;
  version: string;
  declaredLicense: string;
  text: string;
}

const outputDir = path.resolve("dist");
const bundlePath = path.join(outputDir, "mcp-tool-discovery.mjs");
const licenseFileNames = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md"];
const reviewedBundledPackages = [
  "@modelcontextprotocol/sdk",
  "ajv",
  "ajv-formats",
  "content-type",
  "eventsource-parser",
  "fast-deep-equal",
  "fast-uri",
  "json-schema-traverse",
  "pkce-challenge",
  "zod",
  "zod-to-json-schema",
] as const;

function packageNameFromInput(inputPath: string): string | null {
  const normalized = inputPath.replaceAll("\\", "/");
  const marker = "node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const segments = normalized.slice(markerIndex + marker.length).split("/");
  if (segments[0]?.startsWith("@")) return `${segments[0]}/${segments[1]}`;
  return segments[0] || null;
}

function readPackageLicense(packageName: string): PackageLicense {
  const packageDir = path.resolve("node_modules", packageName);
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
    version?: unknown;
    license?: unknown;
  };
  if (typeof manifest.version !== "string" || typeof manifest.license !== "string") {
    throw new Error(`bundled package ${packageName} has invalid license metadata`);
  }
  const licenseFileName = licenseFileNames.find((candidate) =>
    fs.existsSync(path.join(packageDir, candidate)),
  );
  if (!licenseFileName) throw new Error(`bundled package ${packageName} has no license file`);
  return {
    name: packageName,
    version: manifest.version,
    declaredLicense: manifest.license,
    text: fs.readFileSync(path.join(packageDir, licenseFileName), "utf8").trim(),
  };
}

fs.rmSync(outputDir, { recursive: true, force: true });
const result = await build({
  entryPoints: ["mcp-tool-discovery.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: bundlePath,
  metafile: true,
});

const bundledPackages = [...new Set(Object.keys(result.metafile.inputs).map(packageNameFromInput))]
  .filter((name): name is string => name !== null)
  .sort();
if (JSON.stringify(bundledPackages) !== JSON.stringify(reviewedBundledPackages)) {
  throw new Error(
    `the MCP discovery bundle does not match the reviewed package graph: ${JSON.stringify(bundledPackages)}`,
  );
}

const notices = bundledPackages.map(readPackageLicense);
fs.writeFileSync(
  path.join(outputDir, "BUNDLED_PACKAGES.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      packages: notices.map(({ name, version, declaredLicense }) => ({
        name,
        version,
        license: declaredLicense,
      })),
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const noticeText = [
  "Third-party licenses for the NemoClaw MCP tool discovery runtime bundle",
  "",
  ...notices.flatMap(({ name, version, declaredLicense, text }) => [
    "================================================================================",
    `${name}@${version} (${declaredLicense})`,
    "================================================================================",
    text,
    "",
  ]),
].join("\n");
fs.writeFileSync(path.join(outputDir, "THIRD_PARTY_LICENSES.txt"), noticeText, "utf8");
