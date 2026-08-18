// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HIGH_CONFIDENCE_PREFIXED_TOKEN_SPECS } from "../../../nemoclaw/src/security/secret-scanner.ts";
import { buildSandboxCredentialScanCommand } from "../live/cloud-inference-credential-boundary.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Create and track an isolated sandbox-state fixture root. */
function createScanRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cloud-credential-scan-"));
  roots.push(root);
  return root;
}

/** Write one text or binary sandbox-state fixture and return its path. */
function writeFixture(root: string, relativePath: string, body: string | Uint8Array): string {
  const rootPath = path.resolve(root);
  assert(!path.isAbsolute(relativePath), "Fixture path must be relative to the scan root");
  const file = path.resolve(rootPath, relativePath);
  const relativeFile = path.relative(rootPath, file);
  assert(
    relativeFile !== ".." && !relativeFile.startsWith(`..${path.sep}`),
    "Fixture path must stay inside the scan root",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

/** Run the exact live credential scan command against a fixture root. */
function scan(root: string): string {
  return execFileSync("sh", ["-lc", buildSandboxCredentialScanCommand([root])], {
    encoding: "utf8",
  });
}

describe("cloud inference sandbox credential scan", () => {
  it("rejects fixture paths outside the temporary scan root", () => {
    const root = createScanRoot();

    expect(() => writeFixture(root, "../outside.txt", "outside\n")).toThrow(
      "Fixture path must stay inside the scan root",
    );
    expect(() => writeFixture(root, path.join(root, "absolute.txt"), "outside\n")).toThrow(
      "Fixture path must be relative to the scan root",
    );
  });

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
    ["GitHub fine-grained", `github_pat_${"a".repeat(15)}_${"b".repeat(14)}`],
    ["npm", `npm_${"b".repeat(36)}`],
  ])("reports only the path of a file that contains a %s credential canary", (_label, canary) => {
    const root = createScanRoot();
    const leakedFile = writeFixture(root, "openclaw.json", `{"apiKey":"${canary}"}\n`);

    const output = scan(root);

    expect(output.trim()).toBe(leakedFile);
    expect(output).not.toContain(canary);
  });

  it.each(
    HIGH_CONFIDENCE_PREFIXED_TOKEN_SPECS.flatMap(({ prefixes, minimumPayloadLength }) =>
      prefixes.map((prefix) => [prefix, minimumPayloadLength] as const),
    ),
  )("enforces the shared minimum payload for %s", (prefix, minimumPayloadLength) => {
    const root = createScanRoot();
    writeFixture(root, "short.txt", `${prefix}${"a".repeat(minimumPayloadLength - 1)}\n`);

    expect(scan(root)).toBe("");

    const detectedFile = writeFixture(
      root,
      "minimum.txt",
      `${prefix}${"a".repeat(minimumPayloadLength)}\n`,
    );
    expect(scan(root).trim()).toBe(detectedFile);
  });

  it.each([
    ["prefixed GitHub token", `prefixghp_${"a".repeat(36)}`],
    ["suffixed GitHub token", `ghp_${"a".repeat(36)}_suffix`],
    ["prefixed npm token", `prefixnpm_${"b".repeat(36)}`],
    ["suffixed npm token", `npm_${"b".repeat(36)}_suffix`],
  ])("does not report a token embedded in a larger identifier: %s", (_label, value) => {
    const root = createScanRoot();
    writeFixture(root, "embedded.txt", `${value}\n`);

    expect(scan(root)).toBe("");
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
