// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  createHermesSwitchyardRoutingIntent,
  encodeHermesSwitchyardRoutingIntent,
  encodeSwitchyardProviderBindings,
  HERMES_SWITCHYARD_BINDINGS_ENV,
  HERMES_SWITCHYARD_ROUTING_ENV,
} from "../../../src/lib/hermes-switchyard-routing";
import * as sharedRuntime from "../../../src/lib/onboard/managed-startup/image-runtime";
import { switchyardBindingFixture } from "../../helpers/hermes-switchyard";

it("rebuilds the committed Hermes artifact from its shared runtime and cleanup binding", () => {
  const checked = spawnSync(
    process.execPath,
    ["agents/hermes/build-managed-startup-runtime.ts", "--check"],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  expect(checked.status, checked.stderr).toBe(0);
});

it("executes the isolated Hermes runtime entrypoint", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-startup-"));
  try {
    const executable = path.join(directory, "runtime.cjs");
    fs.copyFileSync("agents/hermes/managed-startup-image-runtime.bundle", executable);
    const result = spawnSync(process.execPath, [executable], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("usage: managed-startup-image-runtime");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const bundledRuntime = createRequire(import.meta.url)(
  path.resolve("agents/hermes/managed-startup-image-runtime.bundle"),
) as typeof sharedRuntime;

const directBundledRuntime = createRequire(import.meta.url)(
  path.resolve(
    "tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/managed-startup-direct-image-runtime.bundle",
  ),
) as typeof sharedRuntime;

describe.each([
  ["shared runtime", sharedRuntime],
  ["shipped Hermes bundle", bundledRuntime],
  ["shipped direct bundle", directBundledRuntime],
] as const)("%s routing recovery", (_label, runtime) => {
  it.each([
    ["empty", (target: string) => fs.writeFileSync(target, "")],
    ["missing", () => {}],
    ["symlink", (target: string, original: string) => fs.symlinkSync(original, target)],
    ["directory", (target: string) => fs.mkdirSync(target)],
    ["hard-linked", (target: string, original: string) => fs.linkSync(original, target)],
  ] as const)(
    "stops startup with the original diagnostic and recovery instructions for a %s routing file",
    (_invalid, prepare) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-routing-"));
      onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
      const target = path.join(directory, "relay.toml");
      const original = path.join(directory, "original.toml");
      fs.writeFileSync(original, "preserve this configuration");
      prepare(target, original);
      const routing = createHermesSwitchyardRoutingIntent({
        efficient: { provider: "nvidia-prod", model: "efficient-model" },
        capable: { provider: "openai-api", model: "capable-model" },
      });
      const environment = {
        [HERMES_SWITCHYARD_ROUTING_ENV]: encodeHermesSwitchyardRoutingIntent(routing),
        [HERMES_SWITCHYARD_BINDINGS_ENV]: encodeSwitchyardProviderBindings(
          switchyardBindingFixture(routing),
          routing,
        ),
      };
      const paths = {
        relayPluginStateSource: path.join(directory, "staged-state.json"),
        relayPluginStateTarget: path.join(directory, "state.json"),
        relayPluginsSource: path.join(directory, "staged-relay.toml"),
        relayPluginsTarget: target,
        switchyardDeploymentSource: path.join(directory, "staged-deployment.toml"),
        switchyardDeploymentTarget: path.join(directory, "deployment.toml"),
      };
      const entries = fs.readdirSync(directory);
      let diagnostic: Error | undefined;
      try {
        runtime.readStableRegularFileSnapshot(target, 1024);
      } catch (error) {
        diagnostic = error as Error;
      }
      expect(diagnostic).toBeInstanceOf(Error);
      expect(() => runtime.verifyHermesSwitchyardRoutingFiles(environment, paths)).toThrow(
        expect.objectContaining({
          ...diagnostic,
          name: diagnostic!.name,
          message: expect.stringContaining(diagnostic!.message + "\nHermes startup stopped"),
        }),
      );
      expect(() => runtime.verifyHermesSwitchyardRoutingFiles(environment, paths)).toThrow(
        /Do not edit the protected routing files[\s\S]*nemoclaw onboard --fresh --agent hermes --name <new-name> --switchyard-config <routing-config.json>[\s\S]*does not recover data[\s\S]*independently maintained backup[\s\S]*Do not delete the failed sandbox/u,
      );
      expect(fs.readdirSync(directory)).toEqual(entries);
      expect(fs.readFileSync(original, "utf8")).toBe("preserve this configuration");
    },
  );
});
