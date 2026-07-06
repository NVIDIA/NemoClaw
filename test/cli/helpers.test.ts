// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  nodeOptionsWithoutSourceLoader,
  SOURCE_REQUIRE_HOOK,
  sourceLoaderNodeOptions,
} from "../helpers/source-loader-options";
import { runWithEnv } from "./helpers";

const tempDirs = new Set<string>();

afterEach(() => {
  for (const directory of tempDirs) fs.rmSync(directory, { force: true, recursive: true });
  tempDirs.clear();
});

describe("source-loader Node options", () => {
  it("removes only the repository source-loader option wherever it appears (#6245)", () => {
    const unrelatedRequire = "--require=/tmp/keep-preload.cjs";
    const inspect = "--inspect-port=0";
    const assigned = `--require=${SOURCE_REQUIRE_HOOK}`;
    const quotedAssignment = `--require=${JSON.stringify(SOURCE_REQUIRE_HOOK)}`;

    expect(nodeOptionsWithoutSourceLoader(undefined)).toBe("");
    expect(nodeOptionsWithoutSourceLoader(assigned)).toBe("");
    expect(nodeOptionsWithoutSourceLoader(quotedAssignment)).toBe("");
    expect(nodeOptionsWithoutSourceLoader(`--require ${SOURCE_REQUIRE_HOOK}`)).toBe("");
    expect(nodeOptionsWithoutSourceLoader(`-r ${JSON.stringify(SOURCE_REQUIRE_HOOK)}`)).toBe("");
    expect(
      nodeOptionsWithoutSourceLoader(
        `${quotedAssignment} ${inspect} ${assigned} ${unrelatedRequire}`,
      ),
    ).toBe(`${inspect} ${unrelatedRequire}`);
    expect(
      nodeOptionsWithoutSourceLoader(`${unrelatedRequire} -r=${SOURCE_REQUIRE_HOOK} ${inspect}`),
    ).toBe(`${unrelatedRequire} ${inspect}`);

    const spacedHook = "/tmp/NemoClaw worktree/onboard-script-mocks.cjs";
    expect(
      nodeOptionsWithoutSourceLoader(
        `--require=${JSON.stringify(spacedHook)} ${inspect}`,
        spacedHook,
      ),
    ).toBe(inspect);
  });

  it("preserves malformed or unrelated options byte-for-byte (#6245)", () => {
    const nodeOptions =
      '--require=/tmp/onboard-script-mocks.cjs.backup --conditions="development mode"';
    const malformedOptions = [
      '--conditions="development mode --trace-warnings',
      "--conditions='development mode --trace-warnings",
      "--conditions=trailing\\",
    ];

    expect(nodeOptionsWithoutSourceLoader(nodeOptions)).toBe(nodeOptions);
    for (const malformed of malformedOptions) {
      expect(nodeOptionsWithoutSourceLoader(malformed)).toBe(malformed);
      const loaderBeforeMalformed = `${sourceLoaderNodeOptions(undefined)} ${malformed}`;
      expect(nodeOptionsWithoutSourceLoader(loaderBeforeMalformed)).toBe(loaderBeforeMalformed);
    }
  });

  it("preserves malformed source-loader assignments byte-for-byte (#6245)", () => {
    const hook = "hook";
    const malformedAssignments = ["--require='hook", '--require="hook', '--require=foo"bar'];

    for (const malformed of malformedAssignments) {
      expect(nodeOptionsWithoutSourceLoader(malformed, hook)).toBe(malformed);
    }
  });

  it("removes an unquoted source-loader assignment with escaped backslashes (#6245)", () => {
    const escapedWindowsHook = String.raw`C:\\path\\hook`;

    expect(
      nodeOptionsWithoutSourceLoader(
        `--require=${escapedWindowsHook} --trace-warnings`,
        escapedWindowsHook,
      ),
    ).toBe("--trace-warnings");
  });

  it("handles mixed quotes and escaped backslashes while removing the source loader (#6245)", () => {
    const spacedWindowsHook = String.raw`C:\NemoClaw worktree\onboard-script-mocks.cjs`;
    const mixedOptions = `--conditions='development "mode"' ${sourceLoaderNodeOptions(
      undefined,
      spacedWindowsHook,
    )} --trace-warnings`;

    expect(nodeOptionsWithoutSourceLoader(mixedOptions, spacedWindowsHook)).toBe(
      `--conditions='development "mode"' --trace-warnings`,
    );
  });

  it("keeps unrelated preloads active without installing the TypeScript source hook (#6245)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-node-options-"));
    tempDirs.add(directory);
    const marker = path.join(directory, "preload.json");
    const preload = path.join(directory, "observe-preloads.cjs");
    fs.writeFileSync(
      preload,
      [
        'const fs = require("node:fs");',
        'const Module = require("node:module");',
        `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ hasTypeScriptHook: Object.hasOwn(Module._extensions, ".ts") }));`,
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptionsWithoutSourceLoader(
          `${sourceLoaderNodeOptions(undefined)} --require=${preload}`,
        ),
      },
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual({ hasTypeScriptHook: false });
  });

  it("keeps the TypeScript source hook in the default CLI integration child (#6245)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-source-options-"));
    tempDirs.add(directory);
    const marker = path.join(directory, "preload.json");
    const preload = path.join(directory, "observe-source-preload.cjs");
    fs.writeFileSync(
      preload,
      [
        'const fs = require("node:fs");',
        'const Module = require("node:module");',
        `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ hasTypeScriptHook: Object.hasOwn(Module._extensions, ".ts") }));`,
      ].join("\n"),
    );

    const result = runWithEnv("--version", {
      NODE_OPTIONS: `${sourceLoaderNodeOptions(undefined)} --require=${preload}`,
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual({ hasTypeScriptHook: true });
  });

  it("quotes preload paths that contain spaces for Node (#6245)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw node options "));
    tempDirs.add(directory);
    const marker = path.join(directory, "loaded.txt");
    const preload = path.join(directory, "space preload.cjs");
    fs.writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ok");`);

    const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      env: { ...process.env, NODE_OPTIONS: sourceLoaderNodeOptions(undefined, preload) },
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(marker, "utf8")).toBe("ok");
  });
});
