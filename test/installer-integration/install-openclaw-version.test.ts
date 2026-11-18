// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { INSTALLER_PAYLOAD } from "../helpers/installer-sourced-env";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-version-path-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  return {
    root,
    resolve(checkout: string) {
      return spawnSync(
        "bash",
        [
          "-c",
          'source "$1"; resolve_openclaw_version "$2"',
          "fixture",
          INSTALLER_PAYLOAD,
          checkout,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: { HOME: root, PATH: `${bin}:/usr/bin:/bin` },
        },
      );
    },
  };
}

it("reads the package version from a path with quotes and shell metacharacters", () => {
  const { root, resolve } = fixture();
  const checkout = path.join(root, 'checkout\'s "quotes" $(touch marker); [x]\nspace');
  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(checkout, "package.json"), '{"dependencies":{"openclaw":"1.2.3"}}');
  const result = resolve(checkout);
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("1.2.3");
  expect(fs.existsSync(path.join(root, "marker"))).toBe(false);
});

it.each([
  ["missing dependency", '{"name":"fixture"}'],
  ["invalid JSON", "{not json}"],
])("falls back to Dockerfile.base for %s", (_label, contents) => {
  const { root, resolve } = fixture();
  fs.writeFileSync(path.join(root, "package.json"), contents);
  fs.writeFileSync(path.join(root, "Dockerfile.base"), "ARG OPENCLAW_VERSION=4.5.6\n");
  const result = resolve(root);
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("4.5.6");
});

it("falls back to Dockerfile.base when package.json is absent", () => {
  const { root, resolve } = fixture();
  fs.writeFileSync(path.join(root, "Dockerfile.base"), "ARG OPENCLAW_VERSION=4.5.6\n");
  const result = resolve(root);
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("4.5.6");
});
