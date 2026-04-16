// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Tests for scripts/validate-policies.js — the pre-commit policy schema
// validator. We exercise the validator as a subprocess (matching how
// the pre-commit hook invokes it) and assert on exit code + stderr.
//
// Ref: https://github.com/NVIDIA/NemoClaw/issues/1445

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VALIDATOR = path.join(__dirname, "..", "scripts", "validate-policies.js");

function runValidator(args) {
  return spawnSync("node", [VALIDATOR, ...args], {
    encoding: "utf-8",
    timeout: 10_000,
  });
}

function writeTmpYaml(name, body) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "policy-validator-test-"));
  const p = path.join(tmp, name);
  fs.writeFileSync(p, body, "utf-8");
  return { path: p, tmpDir: tmp };
}

function cleanup(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

describe("validate-policies.js", () => {
  let scratch;

  afterEach(() => {
    if (scratch) cleanup(scratch);
    scratch = null;
  });

  it("accepts a minimal valid policy", () => {
    const body = `
version: 1
network_policies:
  example:
    name: example
    endpoints:
      - host: example.com
        port: 443
        protocol: rest
        enforcement: enforce
        rules:
          - allow: { method: GET, path: "/" }
`;
    const { path: p, tmpDir } = writeTmpYaml("good.yaml", body);
    scratch = tmpDir;
    const r = runValidator([p]);
    expect(r.status).toBe(0);
  });

  it("rejects host:\"*\" as dangerous wildcard", () => {
    const body = `
version: 1
network_policies:
  bad:
    name: bad
    endpoints:
      - host: "*"
        port: 443
        protocol: rest
`;
    const { path: p, tmpDir } = writeTmpYaml("wildcard.yaml", body);
    scratch = tmpDir;
    const r = runValidator([p]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/grants access to any destination/);
  });

  it("rejects host:0.0.0.0/0 as dangerous bind-everything", () => {
    const body = `
version: 1
network_policies:
  bad:
    name: bad
    endpoints:
      - host: "0.0.0.0/0"
        port: 443
`;
    const { path: p, tmpDir } = writeTmpYaml("bind-all.yaml", body);
    scratch = tmpDir;
    const r = runValidator([p]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/grants access to any destination/);
  });

  it("allows subdomain wildcards like *.example.com", () => {
    const body = `
version: 1
network_policies:
  subdomain:
    name: subdomain
    endpoints:
      - host: "*.example.com"
        port: 443
        protocol: rest
        rules:
          - allow: { method: GET, path: "/" }
`;
    const { path: p, tmpDir } = writeTmpYaml("subdomain.yaml", body);
    scratch = tmpDir;
    const r = runValidator([p]);
    expect(r.status).toBe(0);
  });

  it("rejects access:full combined with rules (mutually exclusive)", () => {
    const body = `
version: 1
network_policies:
  conflict:
    name: conflict
    endpoints:
      - host: example.com
        port: 443
        access: full
        rules:
          - allow: { method: GET, path: "/" }
`;
    const { path: p, tmpDir } = writeTmpYaml("conflict.yaml", body);
    scratch = tmpDir;
    const r = runValidator([p]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/mutually exclusive/);
  });

  it("rejects invalid HTTP method in allow rules", () => {
    const body = `
version: 1
network_policies:
  bad:
    name: bad
    endpoints:
      - host: example.com
        port: 443
        rules:
          - allow: { method: FROB, path: "/" }
`;
    const { path: p, tmpDir } = writeTmpYaml("bad-method.yaml", body);
    scratch = tmpDir;
    const r = runValidator([p]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/invalid HTTP method/);
  });

  it("rejects path that does not start with /", () => {
    const body = `
version: 1
network_policies:
  bad:
    name: bad
    endpoints:
      - host: example.com
        port: 443
        rules:
          - allow: { method: GET, path: "relative/path" }
`;
    const { path: p, tmpDir } = writeTmpYaml("bad-path.yaml", body);
    scratch = tmpDir;
    const r = runValidator([p]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/path must start with/);
  });

  it("rejects invalid enforcement value", () => {
    const body = `
version: 1
network_policies:
  bad:
    name: bad
    endpoints:
      - host: example.com
        port: 443
        enforcement: "off"
`;
    const { path: p, tmpDir } = writeTmpYaml("bad-enforce.yaml", body);
    scratch = tmpDir;
    const r = runValidator([p]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/invalid enforcement/);
  });

  it("rejects port out of range", () => {
    const body = `
version: 1
network_policies:
  bad:
    name: bad
    endpoints:
      - host: example.com
        port: 99999
`;
    const { path: p, tmpDir } = writeTmpYaml("bad-port.yaml", body);
    scratch = tmpDir;
    const r = runValidator([p]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/port must be an integer between 1 and 65535/);
  });

  it("requires version on full policy but not on preset fragments", () => {
    const preset = `
preset:
  name: my_preset
  description: "Test preset"
network_policies:
  p:
    name: p
    endpoints:
      - host: example.com
        port: 443
`;
    const { path: p, tmpDir } = writeTmpYaml("preset.yaml", preset);
    scratch = tmpDir;
    const r = runValidator([p]);
    expect(r.status).toBe(0);

    // Same content minus the preset block should fail
    const missing = preset.replace(/preset:[\s\S]*?description: "Test preset"\n/, "");
    const { path: p2, tmpDir: t2 } = writeTmpYaml("nopreset.yaml", missing);
    try {
      const r2 = runValidator([p2]);
      expect(r2.status).toBe(1);
      expect(r2.stderr).toMatch(/missing required top-level field: version/);
    } finally {
      cleanup(t2);
    }
  });

  it("skips files without network_policies or preset (e.g. tiers.yaml)", () => {
    const body = `
tiers:
  - name: restricted
    description: Minimum privileges
`;
    const { path: p, tmpDir } = writeTmpYaml("tiers.yaml", body);
    scratch = tmpDir;
    const r = runValidator([p]);
    expect(r.status).toBe(0);
  });

  it("rejects a versioned policy that omits network_policies", () => {
    // Per CodeRabbit on #1987: a file with `version:` but no
    // `network_policies:` is a misconfiguration — it looks like a full
    // policy but declares no endpoints. The skip-logic for non-policy
    // files must not silently pass it.
    const body = `
version: 1
# network_policies intentionally missing — should fail validation.
`;
    const { path: p, tmpDir } = writeTmpYaml("versioned-no-policies.yaml", body);
    scratch = tmpDir;
    const r = runValidator([p]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing required top-level field: network_policies/);
  });

  it("rejects empty-string host as missing field", () => {
    // Per CodeRabbit on #1987: truthy checks previously let empty strings
    // slip through. Empty host is a config bug, not "unset".
    const body = `
version: 1
network_policies:
  bad:
    name: bad
    endpoints:
      - host: ""
        port: 443
`;
    const { path: p, tmpDir } = writeTmpYaml("empty-host.yaml", body);
    scratch = tmpDir;
    const r = runValidator([p]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing required field: host/);
  });

  it("rejects empty-string protocol as invalid", () => {
    // Per CodeRabbit on #1987: empty-string protocol was previously
    // silently accepted by the truthy check.
    const body = `
version: 1
network_policies:
  bad:
    name: bad
    endpoints:
      - host: example.com
        port: 443
        protocol: ""
`;
    const { path: p, tmpDir } = writeTmpYaml("empty-proto.yaml", body);
    scratch = tmpDir;
    const r = runValidator([p]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/invalid protocol/);
  });

  it("validates all committed policy files in the repo", () => {
    const policyDir = path.join(__dirname, "..", "nemoclaw-blueprint", "policies");
    const files = [
      path.join(policyDir, "openclaw-sandbox.yaml"),
      path.join(policyDir, "openclaw-sandbox-permissive.yaml"),
      path.join(policyDir, "tiers.yaml"),
      ...fs
        .readdirSync(path.join(policyDir, "presets"))
        .filter((f) => f.endsWith(".yaml"))
        .map((f) => path.join(policyDir, "presets", f)),
    ].filter((f) => fs.existsSync(f));

    const r = runValidator(files);
    expect(r.status).toBe(0);
  });
});
