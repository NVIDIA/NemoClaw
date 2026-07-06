// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Runtime behavior of the corporate-proxy CA merge (#6210) in the sandbox
// entrypoints. Exercises the actual shell blocks extracted from
// scripts/nemoclaw-start.sh and agents/hermes/start.sh, not a re-implementation.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const OPENCLAW_START = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
const HERMES_START = join(import.meta.dirname, "../agents/hermes/start.sh");

const OPENSHELL_PEM = "-----BEGIN CERTIFICATE-----\nOPENSHELL-ROOT\n-----END CERTIFICATE-----\n";
const CORPORATE_PEM = "-----BEGIN CERTIFICATE-----\nCORPORATE-ROOT\n-----END CERTIFICATE-----\n";

const tmpRoots: string[] = [];

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sliceBlock(scriptPath: string, startMarker: string, endMarker: string): string {
  const src = readFileSync(scriptPath, "utf-8");
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Failed to extract block [${startMarker} .. ${endMarker}] from ${scriptPath}`);
  }
  return src.slice(start, end);
}

function mergeBlock(scriptPath: string, corpCa: string, merged: string): string {
  return sliceBlock(
    scriptPath,
    "# Corporate proxy CA merge (NemoClaw#6210).",
    "# Git TLS CA bundle fix (NemoClaw#2270).",
  )
    .replaceAll("/usr/local/share/nemoclaw/corporate-ca.pem", corpCa)
    .replaceAll("/tmp/nemoclaw-ca-bundle.pem", merged);
}

function runShell(dir: string, lines: string[]): string {
  const script = join(dir, "run.sh");
  writeFileSync(script, ["#!/usr/bin/env bash", "set -euo pipefail", ...lines].join("\n"), {
    mode: 0o700,
  });
  return execFileSync("bash", [script], { encoding: "utf-8" });
}

describe("corporate proxy CA runtime merge (#6210)", () => {
  it("appends the corporate CA to the OpenShell bundle for OpenClaw and repoints all CA env", () => {
    const dir = tmpDir("nemoclaw-corp-merge-openclaw-");
    const openshell = join(dir, "openshell-ca.pem");
    const corp = join(dir, "corporate-ca.pem");
    const merged = join(dir, "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(corp, CORPORATE_PEM);

    const out = runShell(dir, [
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      mergeBlock(OPENCLAW_START, corp, merged),
      'printf "SSL_CERT_FILE=%s\\n" "${SSL_CERT_FILE:-}"',
      'printf "CURL_CA_BUNDLE=%s\\n" "${CURL_CA_BUNDLE:-}"',
      'printf "REQUESTS_CA_BUNDLE=%s\\n" "${REQUESTS_CA_BUNDLE:-}"',
      'printf "GIT_SSL_CAINFO=%s\\n" "${GIT_SSL_CAINFO:-}"',
      'printf "NODE_EXTRA_CA_CERTS=%s\\n" "${NODE_EXTRA_CA_CERTS:-}"',
      'printf "MERGED=%s\\n" "${_NEMOCLAW_CORPORATE_CA_MERGED:-}"',
    ]);

    for (const name of [
      "SSL_CERT_FILE",
      "CURL_CA_BUNDLE",
      "REQUESTS_CA_BUNDLE",
      "GIT_SSL_CAINFO",
      "NODE_EXTRA_CA_CERTS",
    ]) {
      expect(out).toContain(`${name}=${merged}`);
    }
    expect(out).toContain("MERGED=1");
    const mergedContent = readFileSync(merged, "utf-8");
    expect(mergedContent).toContain("OPENSHELL-ROOT");
    expect(mergedContent).toContain("CORPORATE-ROOT");
  });

  it("is a no-op for OpenClaw when no corporate CA was baked into the image", () => {
    const dir = tmpDir("nemoclaw-corp-merge-noop-");
    const openshell = join(dir, "openshell-ca.pem");
    const absentCorp = join(dir, "absent-corporate-ca.pem");
    const merged = join(dir, "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);

    const out = runShell(dir, [
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      mergeBlock(OPENCLAW_START, absentCorp, merged),
      'printf "SSL_CERT_FILE=%s\\n" "${SSL_CERT_FILE:-}"',
      'printf "MERGED=%s\\n" "${_NEMOCLAW_CORPORATE_CA_MERGED:-}"',
    ]);

    expect(out).toContain(`SSL_CERT_FILE=${openshell}`);
    expect(out).toContain("MERGED=\n");
    expect(existsSync(merged)).toBe(false);
  });

  it("appends the corporate CA and repoints SSL_CERT_FILE / NODE_EXTRA_CA_CERTS for Hermes", () => {
    const dir = tmpDir("nemoclaw-corp-merge-hermes-");
    const openshell = join(dir, "openshell-ca.pem");
    const corp = join(dir, "corporate-ca.pem");
    const merged = join(dir, "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(corp, CORPORATE_PEM);

    // Hermes extracts up to the OpenShell derivation comment; splice that in so
    // the CURL/REQUESTS/GIT vars derive from the merged SSL_CERT_FILE too.
    const hermesMerge = sliceBlock(
      HERMES_START,
      "# Corporate proxy CA merge (NemoClaw#6210).",
      "# OpenShell injects SSL_CERT_FILE/CURL_CA_BUNDLE for its L7 proxy CA.",
    )
      .replaceAll("/usr/local/share/nemoclaw/corporate-ca.pem", corp)
      .replaceAll("/tmp/nemoclaw-ca-bundle.pem", merged);

    const out = runShell(dir, [
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      hermesMerge,
      'printf "SSL_CERT_FILE=%s\\n" "${SSL_CERT_FILE:-}"',
      'printf "NODE_EXTRA_CA_CERTS=%s\\n" "${NODE_EXTRA_CA_CERTS:-}"',
      'printf "MERGED=%s\\n" "${_NEMOCLAW_CORPORATE_CA_MERGED:-}"',
    ]);

    expect(out).toContain(`SSL_CERT_FILE=${merged}`);
    expect(out).toContain(`NODE_EXTRA_CA_CERTS=${merged}`);
    expect(out).toContain("MERGED=1");
    const mergedContent = readFileSync(merged, "utf-8");
    expect(mergedContent).toContain("OPENSHELL-ROOT");
    expect(mergedContent).toContain("CORPORATE-ROOT");
  });

  it("persists the merged CA env into OpenClaw connect sessions only after a merge", () => {
    const dir = tmpDir("nemoclaw-corp-connect-");
    const block = sliceBlock(
      OPENCLAW_START,
      "# Corporate proxy CA for connect sessions (NemoClaw#6210).",
      "# Nemotron inference fix for connect sessions.",
    );
    const bundle = "/tmp/nemoclaw-ca-bundle.pem";

    // Behavioral: capture the emitted connect-session exports, source them in a
    // fresh shell, and assert on the resulting environment — not the text.
    function connectSessionEnv(preEnv: string[]): Record<string, string> {
      const envFile = join(dir, "connect-env.sh");
      const emitted = runShell(dir, [...preEnv, `{ ${block}\n} > ${JSON.stringify(envFile)}`]);
      expect(emitted).toBe("");
      const sourced = runShell(dir, [
        `source ${JSON.stringify(envFile)}`,
        'printf "SSL_CERT_FILE=%s\\n" "${SSL_CERT_FILE:-}"',
        'printf "CURL_CA_BUNDLE=%s\\n" "${CURL_CA_BUNDLE:-}"',
        'printf "REQUESTS_CA_BUNDLE=%s\\n" "${REQUESTS_CA_BUNDLE:-}"',
        'printf "NODE_EXTRA_CA_CERTS=%s\\n" "${NODE_EXTRA_CA_CERTS:-}"',
      ]);
      return Object.fromEntries(
        sourced
          .trim()
          .split("\n")
          .map((line) => {
            const idx = line.indexOf("=");
            return [line.slice(0, idx), line.slice(idx + 1)];
          }),
      );
    }

    const merged = connectSessionEnv([
      `export SSL_CERT_FILE=${bundle}`,
      `export CURL_CA_BUNDLE=${bundle}`,
      `export REQUESTS_CA_BUNDLE=${bundle}`,
      `export NODE_EXTRA_CA_CERTS=${bundle}`,
      "export _NEMOCLAW_CORPORATE_CA_MERGED=1",
    ]);
    expect(merged.SSL_CERT_FILE).toBe(bundle);
    expect(merged.CURL_CA_BUNDLE).toBe(bundle);
    expect(merged.REQUESTS_CA_BUNDLE).toBe(bundle);
    expect(merged.NODE_EXTRA_CA_CERTS).toBe(bundle);

    // No merge marker → the block emits nothing, so a fresh shell inherits no
    // corporate CA env from the connect-session file.
    const skipped = connectSessionEnv(["export SSL_CERT_FILE=/etc/openshell-tls/ca-bundle.pem"]);
    expect(skipped.SSL_CERT_FILE).toBe("");
    expect(skipped.CURL_CA_BUNDLE).toBe("");
  });
});
