// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  command,
  errorDetail,
  fileIdentity,
  type CommandResult,
} from "./probe-component-workload.mts";

export const originalPathExt = ".COM;.EXE;.BAT;.CMD";
export const delimitedPathExt = originalPathExt + ";";
export const officialBuildCommand = "tsc -b && vite build";
export const shimSha256 = "47ccea08e5db69d0fc274ce0a0db9c360bb13264c4a9b315cc608e0833bae247";
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

type ShimApi = {
  create(from: string, to: string): Promise<void>;
  target(file: string): Promise<string>;
  source: string;
};

export function loadOfficialShim(npmRoot: string): ShimApi {
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(npmRoot, "package.json"), "utf8")).version,
    "12.0.2",
  );
  const rootRequire = createRequire(path.join(npmRoot, "package.json"));
  const linksRequire = createRequire(rootRequire.resolve("bin-links"));
  const source = linksRequire.resolve("cmd-shim");
  assert.equal(digest(source), shimSha256, "The official npm12 cmd-shim source differs.");
  assert.equal(linksRequire("cmd-shim/package.json").version, "9.0.2");
  return { create: linksRequire("cmd-shim"), target: linksRequire("read-cmd-shim"), source };
}

export async function createWorkspace(root: string, api: ShimApi) {
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, "web"));
  fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "owned-shim-control", private: true, workspaces: ["web"] }),
  );
  fs.writeFileSync(
    path.join(root, "web", "package.json"),
    JSON.stringify({
      name: "owned-web-control",
      private: true,
      scripts: { build: officialBuildCommand },
    }),
  );
  const bins = [];
  for (const [name, args] of [
    ["tsc", ["-b"]],
    ["vite", ["build"]],
  ] as const) {
    const script = path.join(root, `${name}-fixture.mjs`);
    // Generated innocuous Node programs, not substitutes for actual compilers.
    fs.writeFileSync(
      script,
      `#!/usr/bin/env node\nconsole.log(JSON.stringify({control:${JSON.stringify(name)},argv:process.argv.slice(2),execPath:process.execPath,pathExt:process.env.PATHEXT}));\nif (${JSON.stringify(name)} === "tsc") process.exit(Number(process.env.NEMOCLAW_FIXTURE_FIRST_EXIT ?? 0));\n`,
    );
    const bin = path.join(root, "node_modules", ".bin", name);
    await api.create(script, bin);
    const cmd = bin + ".cmd";
    assert.equal(
      path.resolve(path.dirname(cmd), (await api.target(cmd)).replaceAll("\\", path.sep)),
      script,
    );
    bins.push({
      name,
      args,
      script,
      cmd,
      sha256: digest(cmd),
      contents: fs.readFileSync(cmd, "utf8"),
    });
  }
  return bins;
}

type Event = { control: string; argv: string[]; execPath: string; pathExt: string };
export function events(value: CommandResult): Event[] {
  return value.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('{"control":'))
    .map((line) => JSON.parse(line) as Event);
}

export function checkResult(
  result: CommandResult,
  expectedNames: string[],
  success: boolean,
  node: string,
) {
  assert.equal(result.error, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.outputExceeded, false);
  assert.equal(result.childClosed, true);
  assert.equal(result.signal, null);
  assert.equal(typeof result.exitCode, "number");
  if (success) assert.equal(result.exitCode, 0);
  else assert.notEqual(result.exitCode, 0);
  const rows = events(result);
  assert.deepEqual(
    rows.map((row) => row.control),
    expectedNames,
  );
  for (const row of rows) {
    assert.equal(path.resolve(row.execPath).toLowerCase(), path.resolve(node).toLowerCase());
    assert.deepEqual(row.argv, row.control === "tsc" ? ["-b"] : ["build"]);
  }
  return rows;
}

function argument(name: string) {
  const at = process.argv.indexOf(name);
  assert.ok(at >= 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith("--"));
  return path.resolve(process.argv[at + 1]);
}

async function main() {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "arm64");
  assert.equal(process.version, "v22.23.2");
  const npmRoot = fs.realpathSync(argument("--npm-root"));
  const output = argument("--artifact-directory");
  fs.mkdirSync(output);
  const node = fs.realpathSync(process.execPath);
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  assert.ok(systemRoot && path.isAbsolute(systemRoot));
  const temp = path.join(output, "temp");
  fs.mkdirSync(temp);
  const environment: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    COMSPEC: path.join(systemRoot, "System32", "cmd.exe"),
    PATH: [path.dirname(node), path.join(systemRoot, "System32")].join(path.delimiter),
    TEMP: temp,
    TMP: temp,
    CI: "1",
    npm_config_userconfig: path.join(output, "user.npmrc"),
    npm_config_globalconfig: path.join(output, "global.npmrc"),
    npm_config_cache: path.join(temp, "npm-cache"),
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  for (const name of ["user.npmrc", "global.npmrc"]) fs.writeFileSync(path.join(output, name), "");
  const workspace = path.join(output, "workspace with spaces");
  const receipt: Record<string, unknown> = {
    schemaVersion: 1,
    classification: "official-npm12-windows-command-discovery-control",
    status: "fail",
    actualHermesBuild: false,
    runtimeQualified: false,
    installedAcceptance: false,
    officialBuildCommand,
    originalPathExt,
    delimitedPathExt,
    node: fileIdentity(node),
    cases: [],
    originalShimSourceSha256: shimSha256,
    workspaceRemoved: false,
  };
  let primary: unknown;
  try {
    assert.equal(
      (receipt.node as ReturnType<typeof fileIdentity>).sha256,
      "97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878",
    );
    const api = loadOfficialShim(npmRoot);
    const bins = await createWorkspace(workspace, api);
    receipt.bins = bins;
    const cases: { name: string; result: CommandResult }[] = [];
    receipt.cases = cases;
    const run = async (name: string, pathExt: string, firstExit = "0") => {
      const result = await command(
        node,
        [path.join(npmRoot, "bin", "npm-cli.js"), "run", "build", "--workspace", "web"],
        { ...environment, PATHEXT: pathExt, NEMOCLAW_FIXTURE_FIRST_EXIT: firstExit },
        workspace,
        15_000,
      );
      cases.push({ name, result });
      return result;
    };
    const baseline = await run("original-pathext", originalPathExt);
    const positive = await run("delimited-pathext", delimitedPathExt);
    const firstFailure = await run("first-command-failure", delimitedPathExt, "23");
    for (const bin of bins)
      assert.equal(digest(bin.cmd), bin.sha256, "No official generated shim may change.");
    for (const suffix of ["", ".cmd", ".ps1"])
      fs.unlinkSync(path.join(workspace, "node_modules", ".bin", "vite" + suffix));
    const missing = await run("missing-owned-second-command", delimitedPathExt);
    const oldRows = checkResult(baseline, ["tsc"], false, node);
    assert.equal(
      oldRows[0].pathExt,
      originalPathExt + " ",
      "Capture the actual trailing-space mutation, not only a missing command.",
    );
    const newRows = checkResult(positive, ["tsc", "vite"], true, node);
    for (const row of newRows)
      assert.deepEqual(
        row.pathExt.split(";").filter((value) => value.trim()),
        originalPathExt.split(";"),
      );
    checkResult(firstFailure, ["tsc"], false, node);
    assert.equal(
      firstFailure.exitCode,
      23,
      "The first compiler failure must retain its exact exit code.",
    );
    checkResult(missing, ["tsc"], false, node);
    receipt.status = "pass";
    receipt.hypothesisConfirmed = true;
  } catch (error) {
    primary = error;
    receipt.error = errorDetail(error);
  } finally {
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
      receipt.workspaceRemoved = !fs.existsSync(workspace);
    } catch (error) {
      receipt.cleanupError = errorDetail(error);
      primary ??= error;
      receipt.status = "fail";
    }
    try {
      fs.writeFileSync(
        path.join(output, "npm-shim-control.json"),
        JSON.stringify(receipt, null, 2) + "\n",
        { flag: "wx" },
      );
    } catch (error) {
      primary ??= error;
    }
  }
  if (primary) throw primary;
  console.log("OFFICIAL_NPM_SHIM_CONTROL_PASS");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(errorDetail(error));
    process.exitCode = 1;
  });
}
