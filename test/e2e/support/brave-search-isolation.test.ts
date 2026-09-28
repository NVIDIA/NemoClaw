// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BRAVE_PROCESS_BOUNDARY, BRAVE_SHELL_BOUNDARY } from "../live/brave-search-helpers.ts";

import { writeBraveEgressStub } from "../fixtures/brave-backend.ts";

import {
  hasRequiredOpenshellMessagingFeatures,
  REQUIRED_OPENSHELL_MCP_FEATURES,
} from "../../../src/lib/onboard/openshell-feature-gate.ts";

const directories: string[] = [];
function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "brave-isolation-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("Brave runtime credential boundary probes", () => {
  it.each([
    ["", 0],
    ["BRAVE_API_KEY=openshell:resolve:env:v1_BRAVE_API_KEY", 0],
    ["BRAVE_API_KEY=synthetic-raw-key", 98],
    ["BRAVE_API_KEY=openshell:resolve:env:v1_BRAVE_API_KEY\0BRAVE_API_KEY=synthetic-raw-key", 98],
  ])("classifies a running gateway environment without exposing %s", (environment, status) => {
    const root = temporaryDirectory();
    fs.mkdirSync(path.join(root, "123"));
    fs.writeFileSync(path.join(root, "123/cmdline"), "openclaw-gateway\0");
    fs.writeFileSync(path.join(root, "123/environ"), environment);
    const result = spawnSync("python3", ["-c", BRAVE_PROCESS_BOUNDARY, root], { encoding: "utf8" });
    expect(result.status).toBe(status);
    expect(result.stdout + result.stderr).toBe("");
  });

  it("fails closed when no gateway exists", () => {
    const result = spawnSync("python3", ["-c", BRAVE_PROCESS_BOUNDARY, temporaryDirectory()]);
    expect(result.status).toBe(97);
  });

  it.each([
    ["unavailable environment", "node\0/app/openclaw/openclaw.mjs\0gateway\0run\0"],
    ["shell wrapper only", "sh\0-c\0openclaw gateway run\0"],
  ])("fails closed with %s", (_condition, command) => {
    const root = temporaryDirectory();
    fs.mkdirSync(path.join(root, "123"));
    fs.writeFileSync(path.join(root, "123/cmdline"), command);
    const result = spawnSync("python3", ["-c", BRAVE_PROCESS_BOUNDARY, root]);
    expect(result.status).not.toBe(0);
  });

  it.each([
    ["", 0],
    ["openshell:resolve:env:v1_BRAVE_API_KEY", 0],
    ["synthetic-raw-key", 98],
  ])("classifies fresh shell environment %s", (value, status) => {
    const result = spawnSync("sh", ["-c", BRAVE_SHELL_BOUNDARY], {
      env: { PATH: process.env.PATH, BRAVE_API_KEY: String(value) },
      encoding: "utf8",
    });
    expect(result.status).toBe(status);
    expect(result.stdout + result.stderr).toBe("");
  });

  it("blocks the optional Brave egress request", () => {
    const directory = temporaryDirectory();
    const real = path.join(directory, "real-openshell");
    fs.writeFileSync(
      real,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o700 },
    );
    const wrapper = writeBraveEgressStub(directory, real);
    const prefix = ["sandbox", "exec", "--name", "test", "--"];
    const egress = [
      ...prefix,
      "sh",
      "-lc",
      "'curl' '-sS' '--compressed' '--max-time' '20' '-G' 'https://api.search.brave.com/res/v1/web/search' '--data-urlencode' 'q=NVIDIA'",
    ];
    expect(spawnSync(wrapper, egress).status).toBe(69);
    expect(fs.readFileSync(path.join(directory, "brave-egress-blocked"), "utf8")).toBe("blocked\n");
  });

  it.each([
    ["creation", ["sandbox", "create", "--name", "test"]],
    [
      "running process",
      ["sandbox", "exec", "--name", "test", "--", "python3", "-c", BRAVE_PROCESS_BOUNDARY],
    ],
    ["login shell", ["sandbox", "exec", "--name", "test", "--", "sh", "-lc", BRAVE_SHELL_BOUNDARY]],
    [
      "production guard",
      ["sandbox", "exec", "--name", "test", "--", "sh", "-c", "printenv BRAVE_API_KEY"],
    ],
    [
      "configuration",
      ["sandbox", "exec", "--name", "test", "--", "cat", "/sandbox/.openclaw/openclaw.json"],
    ],
  ])("delegates %s to real OpenShell", (_label, args) => {
    const directory = temporaryDirectory();
    const real = path.join(directory, "real-openshell");
    fs.writeFileSync(
      real,
      `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o700 },
    );
    const wrapper = writeBraveEgressStub(directory, real);
    const result = spawnSync(wrapper, args as string[], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });
  it.each([false, true])(
    "preserves the component integrity preflight with explicit bindings: %s",
    (explicit) => {
      const realDirectory = temporaryDirectory();
      const mockDirectory = temporaryDirectory();
      const real = path.join(realDirectory, "openshell");
      const gateway = path.join(realDirectory, "openshell-gateway");
      const sandbox = path.join(realDirectory, "openshell-sandbox");
      const version = "#!/bin/sh\nprintf 'openshell 0.0.116\\n'\n";
      const component = `${version}# ${REQUIRED_OPENSHELL_MCP_FEATURES.join(" ")}\n`;
      fs.writeFileSync(real, version, { mode: 0o700 });
      fs.writeFileSync(gateway, component, { mode: 0o700 });
      fs.writeFileSync(sandbox, component, { mode: 0o700 });
      const wrapper = writeBraveEgressStub(mockDirectory, real);
      expect(
        hasRequiredOpenshellMessagingFeatures({
          openshellBin: wrapper,
          gatewayBin: gateway,
          sandboxBin: sandbox,
          allowExternalGatewayBin: explicit,
          allowExternalSandboxBin: explicit,
        }),
      ).toBe(explicit);
    },
  );
});
