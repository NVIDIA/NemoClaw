// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  managedPublisher,
  readWorkflow,
  required,
  step,
} from "../../helpers/managed-image-publication-workflow";

const packageVersions = {
  "@openclaw/diagnostics-otel": "2026.9.2",
  "@openclaw/brave-plugin": "2026.9.2",
  "@openclaw/discord": "2026.9.2",
  "@tencent-weixin/openclaw-weixin": "2.4.9",
  "@openclaw/slack": "2026.9.2",
  "@openclaw/whatsapp": "2026.9.2",
  "@openclaw/msteams": "2026.9.2",
  "@openclaw/googlechat": "2026.9.2",
};
let fixtureRoot: string;

function fixturePath(imagePath: string): string {
  return path.join(fixtureRoot, imagePath);
}

function packageManifest(name: string): string {
  return fixturePath(`/sandbox/.openclaw/npm/projects/fixture/node_modules/${name}/package.json`);
}

function validateImagePackages(): void {
  const validation = required(
    step(
      managedPublisher(readWorkflow("managed-images.yaml")),
      "Validate exact managed image before promotion",
    ).run,
    "managed image validation step is missing",
  );
  const source = required(
    validation.match(
      /node <<'VALIDATE_OPENCLAW_UNION'\n([\s\S]+?)\n\s*VALIDATE_OPENCLAW_UNION/u,
    )?.[1],
    "OpenClaw image validator is missing",
  );
  // Execute the complete workflow validator unchanged. Redirect its image paths
  // to real fixture files; package matching and path checks belong to the validator.
  const modules: Record<string, unknown> = {
    "node:path": path,
    "node:fs": {
      existsSync: (file: string) => fs.existsSync(fixturePath(file)),
      lstatSync: (file: string) => fs.lstatSync(fixturePath(file)),
      realpathSync: (file: string) => fs.realpathSync(fixturePath(file)),
      readdirSync: (directory: string) =>
        fs.readdirSync(fixturePath(directory), { withFileTypes: true }),
      readFileSync: (file: string) => fs.readFileSync(fixturePath(file), "utf8"),
    },
  };
  runInNewContext(source, { require: (name: string) => modules[name] }, { timeout: 1_000 });
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-image-packages-"));
  Object.entries(packageVersions).forEach(([name, version]) => {
    const manifest = packageManifest(name);
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify({ name, version }));
  });
  fs.writeFileSync(
    fixturePath("/sandbox/.openclaw/openclaw.json"),
    JSON.stringify({ tools: { web: { search: { enabled: false } } } }),
  );
});

afterEach(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

describe("managed OpenClaw image package validation", () => {
  it("accepts the installed package inventory with native channel defaults", () => {
    expect(validateImagePackages).not.toThrow();
  });

  it("rejects a missing Google Chat package", () => {
    fs.rmSync(path.dirname(packageManifest("@openclaw/googlechat")), { recursive: true });
    expect(validateImagePackages).toThrow(
      "managed OpenClaw plugin googlechat is missing or duplicated",
    );
  });

  it("rejects a Google Chat package with the wrong version", () => {
    fs.writeFileSync(
      packageManifest("@openclaw/googlechat"),
      JSON.stringify({ name: "@openclaw/googlechat", version: "2026.9.1" }),
    );
    expect(validateImagePackages).toThrow(
      "managed OpenClaw plugin googlechat is missing or duplicated",
    );
  });
});
