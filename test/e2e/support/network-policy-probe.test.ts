// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  buildNetworkPolicyCurlProbe,
  parseNetworkPolicyCurlOutput,
} from "./network-policy-probe.ts";

describe("network-policy curl probe", () => {
  it("keeps the status format with its parser", () => {
    expect(buildNetworkPolicyCurlProbe("http://host.openshell.internal:1234/")).toContain(
      String.raw`-w '\nSTATUS_%{http_code}\n'`,
    );
  });

  it("quotes a URL as one shell argument", () => {
    expect(buildNetworkPolicyCurlProbe("http://host.openshell.internal:1234/'; echo UNSAFE")).toBe(
      String.raw`curl -sS --connect-timeout 10 --max-time 20 -w '\nSTATUS_%{http_code}\n' 'http://host.openshell.internal:1234/'\''; echo UNSAFE' 2>&1`,
    );
  });

  it.each([
    [
      "a terminal LF record",
      '{"detail":"policy_denied"}\nSTATUS_403\n',
      { response: '{"detail":"policy_denied"}', status: 403 },
    ],
    ["a terminal CRLF record", "denied\r\nSTATUS_403\r\n", { response: "denied", status: 403 }],
    [
      "response whitespace",
      "\n denied \n\nSTATUS_403\n",
      { response: "\n denied \n", status: 403 },
    ],
    [
      "status-like response text",
      '{"detail":"STATUS_403"}\nSTATUS_000\n',
      { response: '{"detail":"STATUS_403"}', status: 0 },
    ],
    ["no terminal record", '{"detail":"STATUS_403"}', null],
  ])("separates response and status from %s", (_label, output, expected) => {
    expect(parseNetworkPolicyCurlOutput(output)).toEqual(expected);
  });
});

// Execute the shipped probe with only its installation path redirected to a disposable fixture.
function installedWebFetchProbe(dist: string): string {
  const file = path.join(import.meta.dirname, "../live/network-policy.test.ts");
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const builder = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "buildWebFetchProbeScript",
  );
  const executable = ts.transpileModule(builder!.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const probe = vm.runInNewContext(`${executable}\nbuildWebFetchProbeScript()`) as string;
  return probe.replace('"/usr/local/lib/node_modules/openclaw/dist"', JSON.stringify(dist));
}

const nativeToolsFixture = `
export function createOpenClawTools() {
  return [{ name: "web_fetch", async execute(_id, {url}) {
    if (url.endsWith("/denied")) throw new Error("Web fetch failed (403)");
    return { content: "approved-marker" };
  }}];
}
`;

describe("installed native web-fetch probe", () => {
  it.each([
    { extension: "js", extra: "", status: 0 },
    { extension: "mjs", extra: "", status: 0 },
    { extension: "mjs", extra: "ambiguous", status: 1 },
    { extension: "mjs", extra: "denied-success", status: 1 },
  ])(
    "checks allowed and denied results with $extension modules ($extra)",
    ({ extension, extra, status }) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-policy-probe-"));
      try {
        fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ type: "module" }));
        const config = path.join(directory, "config.json");
        fs.writeFileSync(
          config,
          JSON.stringify({ tools: { web: { fetch: { useTrustedEnvProxy: true } } } }),
        );
        const fixtures: Record<string, string> = {
          "": nativeToolsFixture,
          ambiguous: nativeToolsFixture,
          "denied-success":
            'export function createOpenClawTools() { return [{name: "web_fetch", execute: async () => ({content: "approved-marker denied-marker"})}]; }',
        };
        fs.writeFileSync(
          path.join(directory, `openclaw-tools-native.${extension}`),
          fixtures[extra]!,
        );
        fs.writeFileSync(
          path.join(directory, `openclaw-tools-serve-config-decoy.${extension}`),
          'throw new Error("serve-config must not execute");',
        );
        const alias = `export { createOpenClawTools } from "./openclaw-tools-native.${extension}";`;
        const additional: Record<string, string> = {
          "": alias,
          "denied-success": alias,
          ambiguous: nativeToolsFixture,
        };
        fs.writeFileSync(path.join(directory, "openclaw-tools-other.mjs"), additional[extra]!);
        const result = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-",
            "https://fixture/approved",
            "https://fixture/denied",
            "approved-marker",
            "denied-marker",
          ],
          {
            input: installedWebFetchProbe(directory),
            env: { ...process.env, OPENCLAW_CONFIG_PATH: config },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        expect(result.status, result.stderr).toBe(status);
        const evidence: Record<string, string> = {
          "": "E2E_WEB_FETCH_DENIED_OK",
          ambiguous: "expected one OpenClaw tools implementation",
          "denied-success": "E2E_FAIL_DENIED_PORT_REACHED",
        };
        expect(`${result.stdout}${result.stderr}`).toContain(evidence[extra]!);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
