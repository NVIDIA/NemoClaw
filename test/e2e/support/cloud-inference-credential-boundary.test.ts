// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildSandboxCredentialScanCommand } from "../live/cloud-inference-credential-boundary.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createScanRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloud-credential-scan-"));
  roots.push(root);
  return root;
}

function writeFixture(root: string, relativePath: string, body: string | Uint8Array): string {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

function scan(root: string): string {
  return execFileSync("sh", ["-lc", buildSandboxCredentialScanCommand([root])], {
    encoding: "utf8",
  });
}

describe("cloud inference sandbox credential scan", () => {
  it("accepts npm dependency metadata that does not contain a credential value (#9363)", () => {
    const root = createScanRoot();
    writeFixture(
      root,
      "npm/projects/openclaw-whatsapp/node_modules/thread-stream/test/ts/transpile.sh",
      'echo "${npm_config_user_agent}"\n',
    );
    writeFixture(
      root,
      "npm/projects/openclaw-msteams/node_modules/jwks-rsa/package.json",
      '{"scripts":{"release":"git tag $npm_package_version"}}\n',
    );
    writeFixture(root, "configuration/token-key-path.txt", "ordinary dependency metadata\n");

    expect(scan(root)).toBe("");
  });

  it.each([
    ["NVIDIA", "nvapi-nemoclaw-credential-boundary-canary"],
    ["GitHub", `ghp_${"a".repeat(36)}`],
    ["npm", `npm_${"b".repeat(36)}`],
  ])("reports only the path of a file that contains a %s credential canary", (_label, canary) => {
    const root = createScanRoot();
    const leakedFile = writeFixture(root, "openclaw.json", `{"apiKey":"${canary}"}\n`);

    const output = scan(root);

    expect(output.trim()).toBe(leakedFile);
    expect(output).not.toContain(canary);
  });

  it("reports a credential canary in a NUL-containing file", () => {
    const root = createScanRoot();
    const canary = "nvapi-nemoclaw-binary-credential-canary";
    const leakedFile = writeFixture(root, "state.bin", Buffer.from(`prefix\0${canary}\n`));

    const output = scan(root);

    expect(output.trim()).toBe(leakedFile);
    expect(output).not.toContain(canary);
  });
});
