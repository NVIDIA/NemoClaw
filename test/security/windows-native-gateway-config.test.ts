// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeNativeGatewayConfig } from "../../packaging/windows/runtime/native-security.mts";

const template = [
  "[openshell.drivers.mxc]",
  'wxc_exec_path = "C:\\\\old\\\\wxc-exec.exe" # installed path',
  'backend = "process_container"',
  "pc_least_privilege = false",
  'pc_capabilities = ["privateNetworkClientServer"]',
  "debug = false",
  "[another_driver]",
  'wxc_exec_path = "keep-this-value"',
  "",
].join("\n");

let temporaryRoot: string;
beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-native-gateway-"));
});
afterEach(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

function fixture(contents = template, name = "NemoClaw candidate") {
  const installRoot = path.join(temporaryRoot, name);
  const runRoot = path.join(temporaryRoot, "run");
  const source = path.join(installRoot, "config", "mxc-gateway.toml");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(runRoot);
  fs.writeFileSync(source, contents);
  return { installRoot, runRoot, source };
}

describe("native gateway configuration", () => {
  it("uses the selected installation and preserves the template settings", () => {
    const { installRoot, runRoot, source } = fixture();
    const output = writeNativeGatewayConfig(installRoot, runRoot);

    expect(output).toBe(path.join(fs.realpathSync(runRoot), "mxc-gateway.toml"));
    expect(fs.readFileSync(source, "utf8")).toBe(template);
    expect(parse(fs.readFileSync(output, "utf8"))).toEqual({
      openshell: {
        drivers: {
          mxc: {
            wxc_exec_path: path.join(installRoot, "mxc", "wxc-exec.exe"),
            backend: "process_container",
            pc_least_privilege: false,
            pc_capabilities: ["privateNetworkClientServer"],
            debug: false,
          },
        },
      },
      another_driver: { wxc_exec_path: "keep-this-value" },
    });
  });

  it.skipIf(process.platform === "win32")("escapes TOML-sensitive path characters", () => {
    const { installRoot, runRoot } = fixture(template, 'Nemo "quoted" \\ path\u007f');
    const output = writeNativeGatewayConfig(installRoot, runRoot);
    const parsed = parse(fs.readFileSync(output, "utf8"));

    expect(parsed).toMatchObject({
      openshell: {
        drivers: { mxc: { wxc_exec_path: path.join(installRoot, "mxc", "wxc-exec.exe") } },
      },
    });
  });

  it("retains security settings supplied by a different installed template", () => {
    const alternate = template
      .replace("pc_least_privilege = false", "pc_least_privilege = true")
      .replace('pc_capabilities = ["privateNetworkClientServer"]', "pc_capabilities = []");
    const { installRoot, runRoot } = fixture(alternate);
    const output = writeNativeGatewayConfig(installRoot, runRoot);

    expect(parse(fs.readFileSync(output, "utf8"))).toMatchObject({
      openshell: { drivers: { mxc: { pc_least_privilege: true, pc_capabilities: [] } } },
    });
  });

  it.each(["", "runtime"])("rejects output inside the installed payload at %j", (child) => {
    const { installRoot } = fixture();
    const runRoot = path.join(installRoot, child);
    fs.mkdirSync(runRoot, { recursive: true });

    expect(() => writeNativeGatewayConfig(installRoot, runRoot)).toThrow(
      /outside the installed payload/u,
    );
    expect(fs.existsSync(path.join(runRoot, "mxc-gateway.toml"))).toBe(false);
  });

  it("rejects a run directory that links into the installed payload", () => {
    const { installRoot } = fixture();
    const alias = path.join(temporaryRoot, "alias");
    fs.symlinkSync(installRoot, alias, "junction");

    expect(() => writeNativeGatewayConfig(installRoot, alias)).toThrow(
      /outside the installed payload/u,
    );
  });

  it.each([
    '[another_driver]\nwxc_exec_path = "other"\n',
    '[openshell.drivers.mxc]\nbackend = "process_container"\n',
    '[openshell.drivers.mxc]\nwxc_exec_path = "first"\nwxc_exec_path = "second"\n',
    '[openshell.drivers.mxc]\nwxc_exec_path = "first"\n[openshell.drivers.mxc]\n',
    '[openshell.drivers.mxc]\n[[another_driver]]\nwxc_exec_path = "other"\n',
    "[openshell.drivers.mxc]\nwxc_exec_path = 42\n",
  ])("rejects an absent or ambiguous template binding %#", (contents) => {
    const { installRoot, runRoot } = fixture(contents);

    expect(() => writeNativeGatewayConfig(installRoot, runRoot)).toThrow(/gateway template/u);
    expect(fs.readdirSync(runRoot)).toEqual([]);
  });

  it("requires the installed template without creating a replacement", () => {
    const { installRoot, runRoot, source } = fixture();
    fs.unlinkSync(source);

    expect(() => writeNativeGatewayConfig(installRoot, runRoot)).toThrow(/template is missing/u);
    expect(fs.readdirSync(runRoot)).toEqual([]);
  });

  it("rejects an installation path that cannot be represented as TOML Unicode", () => {
    const { installRoot, runRoot } = fixture();

    expect(() => writeNativeGatewayConfig(`${installRoot}\ud800`, runRoot)).toThrow(
      /invalid Unicode/u,
    );
    expect(fs.readdirSync(runRoot)).toEqual([]);
  });

  it("does not replace an existing per-run configuration", () => {
    const { installRoot, runRoot } = fixture();
    const output = path.join(runRoot, "mxc-gateway.toml");
    fs.writeFileSync(output, "existing run");

    expect(() => writeNativeGatewayConfig(installRoot, runRoot)).toThrow(/EEXIST/u);
    expect(fs.readFileSync(output, "utf8")).toBe("existing run");
  });
});
