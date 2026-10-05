// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installReviewedOpenClawPlugin } from "../../scripts/lib/install-reviewed-openclaw-plugin.mts";
import { seedReviewedNpmCache } from "../../scripts/lib/seed-reviewed-npm-cache.mts";

const put = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));
vi.mock("../../scripts/lib/seed-reviewed-npm-cache.mts", async (original) => {
  const actual = await original<typeof import("../../scripts/lib/seed-reviewed-npm-cache.mts")>();
  return {
    ...actual,
    seedReviewedNpmCache: vi.fn((request) => actual.seedReviewedNpmCache(request, put)),
  };
});

const PACKAGE_NAME = "@openclaw/diagnostics-otel";
const VERSION = "2026.9.2";
const SPEC = `${PACKAGE_NAME}@${VERSION}`;
const URL = "https://registry.npmjs.org/@openclaw/diagnostics-otel/-/diagnostics-otel-2026.9.2.tgz";
const command = vi.mocked(execFileSync);
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reviewed-plugin-test-"));
  command.mockReset();
  put.mockClear();
  vi.mocked(seedReviewedNpmCache).mockClear();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(
  overrides: { plugin?: Record<string, unknown>; install?: Record<string, unknown> } = {},
) {
  const archive = Buffer.from("reviewed archive fixture");
  const archivePath = path.join(root, "plugin.tgz");
  fs.writeFileSync(archivePath, archive);
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  command
    .mockReturnValueOnce(JSON.stringify({ name: PACKAGE_NAME, version: VERSION }))
    .mockReturnValueOnce(JSON.stringify({ id: "diagnostics-otel" }))
    .mockReturnValueOnce(Buffer.alloc(0))
    .mockReturnValueOnce(
      JSON.stringify({
        plugin: {
          id: "diagnostics-otel",
          packageName: PACKAGE_NAME,
          packageVersion: VERSION,
          trustedOfficialInstall: true,
          trust: { reason: "trusted-official" },
          ...overrides.plugin,
        },
        install: {
          source: "npm",
          resolvedName: PACKAGE_NAME,
          resolvedVersion: VERSION,
          resolvedSpec: SPEC,
          integrity,
          ...overrides.install,
        },
      }),
    );
  return { archivePath, integrity, packageSpec: SPEC, tarballUrl: URL };
}

it("uses the verified offline cache and checks native official provenance (#12144)", async () => {
  const request = fixture();
  await installReviewedOpenClawPlugin(request);
  const seeded = vi.mocked(seedReviewedNpmCache).mock.calls[0]![0];
  expect(seeded.archives).toEqual(new Map([[SPEC, request.archivePath]]));
  expect(put).toHaveBeenCalled();
  expect(command).toHaveBeenNthCalledWith(
    3,
    "openclaw",
    ["plugins", "install", "--force", "--pin", "--accept-capabilities", SPEC],
    expect.objectContaining({
      env: expect.objectContaining({
        NPM_CONFIG_CACHE: seeded.cacheDirectory,
        npm_config_cache: seeded.cacheDirectory,
        NPM_CONFIG_OFFLINE: "true",
        npm_config_offline: "true",
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
        npm_config_ignore_scripts: "true",
        NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
      }),
    }),
  );
  expect(command).toHaveBeenNthCalledWith(
    4,
    "openclaw",
    ["plugins", "inspect", "diagnostics-otel", "--json"],
    expect.any(Object),
  );
  expect(fs.existsSync(seeded.cacheDirectory)).toBe(false);
});

it("rejects modified bytes before parsing or installing the plugin (#12144)", async () => {
  const request = fixture();
  fs.writeFileSync(request.archivePath, "changed");
  await expect(installReviewedOpenClawPlugin(request)).rejects.toThrow(/integrity mismatch/iu);
  expect(command).not.toHaveBeenCalled();
  expect(seedReviewedNpmCache).not.toHaveBeenCalled();
});

it("rejects an archive whose package identity differs from the requested pin (#12144)", async () => {
  const request = fixture();
  await expect(
    installReviewedOpenClawPlugin({ ...request, packageSpec: `${PACKAGE_NAME}@2099.1.1` }),
  ).rejects.toThrow("archive identity does not match");
  expect(command).toHaveBeenCalledTimes(2);
  expect(seedReviewedNpmCache).not.toHaveBeenCalled();
});

it("rejects a foreign registry before invoking the native installer (#12144)", async () => {
  const request = fixture();
  await expect(
    installReviewedOpenClawPlugin({
      ...request,
      tarballUrl: "https://untrusted.example/plugin.tgz",
    }),
  ).rejects.toThrow("must use the reviewed registry");
  expect(command).toHaveBeenCalledTimes(2);
  expect(put).not.toHaveBeenCalled();
  expect(fs.existsSync(vi.mocked(seedReviewedNpmCache).mock.calls[0]![0].cacheDirectory)).toBe(
    false,
  );
});

it("removes its private cache when the native installer fails (#12144)", async () => {
  const request = fixture();
  command
    .mockReset()
    .mockReturnValueOnce(JSON.stringify({ name: PACKAGE_NAME, version: VERSION }))
    .mockReturnValueOnce(JSON.stringify({ id: "diagnostics-otel" }))
    .mockImplementationOnce(() => {
      throw new Error("native install failed");
    });
  await expect(installReviewedOpenClawPlugin(request)).rejects.toThrow("native install failed");
  expect(command).toHaveBeenCalledTimes(3);
  expect(fs.existsSync(vi.mocked(seedReviewedNpmCache).mock.calls[0]![0].cacheDirectory)).toBe(
    false,
  );
});

it.each([
  { scenario: "path-origin provenance", plugin: { trust: { reason: "origin-path" } }, install: {} },
  {
    scenario: "contradictory official trust",
    plugin: { trustedOfficialInstall: false },
    install: {},
  },
  { scenario: "a different plugin version", plugin: { packageVersion: "2099.1.1" }, install: {} },
  { scenario: "a different integrity", plugin: {}, install: { integrity: "different" } },
  { scenario: "an archive record", plugin: {}, install: { artifactKind: "npm-pack" } },
  { scenario: "a local source path", plugin: {}, install: { sourcePath: "/tmp/plugin.tgz" } },
])("rejects $scenario after installation (#12144)", async ({ plugin, install }) => {
  await expect(installReviewedOpenClawPlugin(fixture({ plugin, install }))).rejects.toThrow(
    "did not preserve reviewed official provenance",
  );
  expect(fs.existsSync(vi.mocked(seedReviewedNpmCache).mock.calls[0]![0].cacheDirectory)).toBe(
    false,
  );
});
