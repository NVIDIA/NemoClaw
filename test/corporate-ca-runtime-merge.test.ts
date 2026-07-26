// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Runtime behavior of the corporate-proxy CA merge (#6210) in the sandbox
// entrypoints. Exercises the actual shell blocks extracted from
// scripts/nemoclaw-start.sh and agents/hermes/start.sh, not a re-implementation.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runShellLines, sliceBlock } from "./helpers/corporate-ca-support";

const OPENCLAW_START = join(import.meta.dirname, "../scripts/nemoclaw-start.sh");
const HERMES_START = join(import.meta.dirname, "../agents/hermes/start.sh");

const OPENSHELL_PEM = "-----BEGIN CERTIFICATE-----\nOPENSHELL-ROOT\n-----END CERTIFICATE-----\n";
const CORPORATE_PEM = "-----BEGIN CERTIFICATE-----\nCORPORATE-ROOT\n-----END CERTIFICATE-----\n";
const MERGE_START = "# Corporate proxy CA merge (NemoClaw#6210).";

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

function mergeBlock(scriptPath: string, endMarker: string, corpCa: string, merged: string): string {
  return sliceBlock(scriptPath, MERGE_START, endMarker)
    .replaceAll("/usr/local/share/nemoclaw/corporate-ca.pem", corpCa)
    .replaceAll("/tmp/nemoclaw-ca-bundle.pem", merged);
}

describe("corporate proxy CA runtime merge (#6210)", () => {
  it("appends the corporate CA to the OpenShell bundle for OpenClaw and repoints all CA env (#6210)", () => {
    const dir = tmpDir("nemoclaw-corp-merge-openclaw-");
    const openshell = join(dir, "openshell-ca.pem");
    const corp = join(dir, "corporate-ca.pem");
    const merged = join(dir, "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(corp, CORPORATE_PEM);

    const out = runShellLines(dir, [
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      mergeBlock(OPENCLAW_START, "# Git TLS CA bundle fix (NemoClaw#2270).", corp, merged),
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

  it("is a no-op for OpenClaw when no corporate CA was baked into the image (#6210)", () => {
    const dir = tmpDir("nemoclaw-corp-merge-noop-");
    const openshell = join(dir, "openshell-ca.pem");
    const absentCorp = join(dir, "absent-corporate-ca.pem");
    const merged = join(dir, "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);

    const out = runShellLines(dir, [
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      mergeBlock(OPENCLAW_START, "# Git TLS CA bundle fix (NemoClaw#2270).", absentCorp, merged),
      'printf "SSL_CERT_FILE=%s\\n" "${SSL_CERT_FILE:-}"',
      'printf "MERGED=%s\\n" "${_NEMOCLAW_CORPORATE_CA_MERGED:-}"',
    ]);

    expect(out).toContain(`SSL_CERT_FILE=${openshell}`);
    expect(out).toContain("MERGED=\n");
    expect(existsSync(merged)).toBe(false);
  });

  it("appends the corporate CA and repoints all CA env for Hermes (#6210)", () => {
    const dir = tmpDir("nemoclaw-corp-merge-hermes-");
    const openshell = join(dir, "openshell-ca.pem");
    const corp = join(dir, "corporate-ca.pem");
    const merged = join(dir, "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(corp, CORPORATE_PEM);

    // Hermes' block ends at the OpenShell derivation comment; splice that in so
    // the CURL/REQUESTS/GIT vars derive from the merged SSL_CERT_FILE too.
    const hermesMerge = mergeBlock(
      HERMES_START,
      "# OpenShell injects SSL_CERT_FILE/CURL_CA_BUNDLE for its L7 proxy CA.",
      corp,
      merged,
    );

    // Simulate OpenShell having pre-set CURL/REQUESTS/GIT to its own bundle;
    // the merge must override them, not leave them pointing at OpenShell-only.
    const out = runShellLines(dir, [
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      `export CURL_CA_BUNDLE=${JSON.stringify(openshell)}`,
      `export REQUESTS_CA_BUNDLE=${JSON.stringify(openshell)}`,
      `export GIT_SSL_CAINFO=${JSON.stringify(openshell)}`,
      hermesMerge,
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

  it("bails without exporting when the OpenClaw merged bundle cannot be written (#6210)", () => {
    const dir = tmpDir("nemoclaw-corp-merge-fail-");
    const openshell = join(dir, "openshell-ca.pem");
    const corp = join(dir, "corporate-ca.pem");
    // A merged path under a non-existent directory makes mktemp fail.
    const merged = join(dir, "no-such-dir", "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(corp, CORPORATE_PEM);

    const out = runShellLines(dir, [
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      mergeBlock(OPENCLAW_START, "# Git TLS CA bundle fix (NemoClaw#2270).", corp, merged),
      'printf "SSL_CERT_FILE=%s\\n" "${SSL_CERT_FILE:-}"',
      'printf "MERGED=%s\\n" "${_NEMOCLAW_CORPORATE_CA_MERGED:-}"',
    ]);

    // Merge bailed: OpenShell-only trust intact, no merge marker.
    expect(out).toContain(`SSL_CERT_FILE=${openshell}`);
    expect(out).toContain("MERGED=\n");
    expect(existsSync(merged)).toBe(false);
  });

  it("bails without exporting when the Hermes merged bundle cannot be written (#6210)", () => {
    const dir = tmpDir("nemoclaw-corp-merge-hermes-fail-");
    const openshell = join(dir, "openshell-ca.pem");
    const corp = join(dir, "corporate-ca.pem");
    const merged = join(dir, "no-such-dir", "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(corp, CORPORATE_PEM);

    const out = runShellLines(dir, [
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      mergeBlock(
        HERMES_START,
        "# OpenShell injects SSL_CERT_FILE/CURL_CA_BUNDLE for its L7 proxy CA.",
        corp,
        merged,
      ),
      'printf "SSL_CERT_FILE=%s\\n" "${SSL_CERT_FILE:-}"',
      'printf "MERGED=%s\\n" "${_NEMOCLAW_CORPORATE_CA_MERGED:-}"',
    ]);

    expect(out).toContain(`SSL_CERT_FILE=${openshell}`);
    expect(out).toContain("MERGED=\n");
    expect(existsSync(merged)).toBe(false);
  });

  it("bails without exporting when OpenClaw cannot make the merged bundle readable (#6210)", () => {
    const dir = tmpDir("nemoclaw-corp-merge-chmod-openclaw-");
    const openshell = join(dir, "openshell-ca.pem");
    const corp = join(dir, "corporate-ca.pem");
    const merged = join(dir, "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(corp, CORPORATE_PEM);

    const out = runShellLines(dir, [
      "chmod() { return 1; }",
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      mergeBlock(OPENCLAW_START, "# Git TLS CA bundle fix (NemoClaw#2270).", corp, merged),
      'printf "SSL_CERT_FILE=%s\\n" "${SSL_CERT_FILE:-}"',
      'printf "MERGED=%s\\n" "${_NEMOCLAW_CORPORATE_CA_MERGED:-}"',
    ]);

    expect(out).toContain(`SSL_CERT_FILE=${openshell}`);
    expect(out).toContain("MERGED=\n");
    expect(existsSync(merged)).toBe(false);
  });

  it("bails without exporting when Hermes cannot make the merged bundle readable (#6210)", () => {
    const dir = tmpDir("nemoclaw-corp-merge-chmod-hermes-");
    const openshell = join(dir, "openshell-ca.pem");
    const corp = join(dir, "corporate-ca.pem");
    const merged = join(dir, "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(corp, CORPORATE_PEM);

    const out = runShellLines(dir, [
      "chmod() { return 1; }",
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      mergeBlock(
        HERMES_START,
        "# OpenShell injects SSL_CERT_FILE/CURL_CA_BUNDLE for its L7 proxy CA.",
        corp,
        merged,
      ),
      'printf "SSL_CERT_FILE=%s\\n" "${SSL_CERT_FILE:-}"',
      'printf "MERGED=%s\\n" "${_NEMOCLAW_CORPORATE_CA_MERGED:-}"',
    ]);

    expect(out).toContain(`SSL_CERT_FILE=${openshell}`);
    expect(out).toContain("MERGED=\n");
    expect(existsSync(merged)).toBe(false);
  });

  it("warns on stderr when the OpenClaw merge fails (#6210)", () => {
    const dir = tmpDir("nemoclaw-corp-merge-warn-openclaw-");
    const openshell = join(dir, "openshell-ca.pem");
    const corp = join(dir, "corporate-ca.pem");
    const merged = join(dir, "no-such-dir", "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(corp, CORPORATE_PEM);

    // exec 2>&1 folds the merge's stderr warning into captured stdout.
    const out = runShellLines(dir, [
      "exec 2>&1",
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      mergeBlock(OPENCLAW_START, "# Git TLS CA bundle fix (NemoClaw#2270).", corp, merged),
    ]);
    expect(out).toContain("corporate proxy CA merge failed");
    expect(out).not.toContain("BEGIN CERTIFICATE");
  });

  it("warns on stderr when the Hermes merge fails (#6210)", () => {
    const dir = tmpDir("nemoclaw-corp-merge-warn-hermes-");
    const openshell = join(dir, "openshell-ca.pem");
    const corp = join(dir, "corporate-ca.pem");
    const merged = join(dir, "no-such-dir", "merged-ca.pem");
    writeFileSync(openshell, OPENSHELL_PEM);
    writeFileSync(corp, CORPORATE_PEM);

    const out = runShellLines(dir, [
      "exec 2>&1",
      `export SSL_CERT_FILE=${JSON.stringify(openshell)}`,
      mergeBlock(
        HERMES_START,
        "# OpenShell injects SSL_CERT_FILE/CURL_CA_BUNDLE for its L7 proxy CA.",
        corp,
        merged,
      ),
    ]);
    expect(out).toContain("corporate proxy CA merge failed");
    expect(out).not.toContain("BEGIN CERTIFICATE");
  });

  it("persists the merged CA env into OpenClaw connect sessions only after a merge (#6210)", () => {
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
      const emitted = runShellLines(dir, [...preEnv, `{ ${block}\n} > ${JSON.stringify(envFile)}`]);
      expect(emitted).toBe("");
      const sourced = runShellLines(dir, [
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
