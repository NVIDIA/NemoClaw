// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildHermesManagedStartupIntegrityScript } from "../live/hermes-gpu-startup-integrity.ts";

interface IntegrityFixture {
  root: string;
  configPath: string;
  envPath: string;
  strictHashPath: string;
  compatHashPath: string;
  startupLogPath: string;
  baseEnv: string;
  generatedKey: string;
}

const roots: string[] = [];
const MCP_STATE_RECORD = `# nemoclaw-hermes-mcp-state-v1 intended=${"1".repeat(64)} applied=${"2".repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function writeHash(
  hashPath: string,
  configPath: string,
  config: string,
  envPath: string,
  env: string,
): void {
  fs.writeFileSync(
    hashPath,
    `${digest(config)}  ${configPath}\n${digest(env)}  ${envPath}\n${MCP_STATE_RECORD}\n`,
  );
}

function readHashRecords(hashPath: string): string[] {
  return fs.readFileSync(hashPath, "utf-8").split("\n").slice(0, -1);
}

function writeHashRecords(hashPath: string, records: readonly string[]): void {
  fs.writeFileSync(hashPath, `${records.join("\n")}\n`);
}

function createFixture(): IntegrityFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-gpu-integrity-"));
  roots.push(root);
  const hermesDir = path.join(root, ".hermes");
  const fixture: IntegrityFixture = {
    root,
    configPath: path.join(hermesDir, "config.yaml"),
    envPath: path.join(hermesDir, ".env"),
    strictHashPath: path.join(root, "hermes.config-hash"),
    compatHashPath: path.join(hermesDir, ".config-hash"),
    startupLogPath: path.join(root, "nemoclaw-start.log"),
    baseEnv: "API_SERVER_PORT=18642\nSAFE_SETTING=trusted\n",
    generatedKey: "a".repeat(64),
  };
  const config = "model:\n  default: test-model\n";
  const liveEnv = `${fixture.baseEnv}API_SERVER_KEY=${fixture.generatedKey}\n`;
  fs.mkdirSync(hermesDir, { recursive: true });
  fs.writeFileSync(fixture.configPath, config);
  fs.writeFileSync(fixture.envPath, liveEnv);
  writeHash(fixture.strictHashPath, fixture.configPath, config, fixture.envPath, fixture.baseEnv);
  writeHash(fixture.compatHashPath, fixture.configPath, config, fixture.envPath, liveEnv);
  fs.chmodSync(fixture.strictHashPath, 0o444);
  fs.writeFileSync(fixture.startupLogPath, "[config] managed startup complete\n");
  return fixture;
}

function runProof(fixture: IntegrityFixture, extraEnv: NodeJS.ProcessEnv = {}) {
  const strictMetadata = fs.statSync(fixture.strictHashPath);
  return spawnSync(
    "/bin/bash",
    [
      "-c",
      buildHermesManagedStartupIntegrityScript({
        configPath: fixture.configPath,
        envPath: fixture.envPath,
        strictHashPath: fixture.strictHashPath,
        compatHashPath: fixture.compatHashPath,
        startupLogPath: fixture.startupLogPath,
        strictHashUid: strictMetadata.uid,
        strictHashGid: strictMetadata.gid,
      }),
    ],
    {
      encoding: "utf-8",
      timeout: 5000,
      env: {
        LANG: "C",
        LC_ALL: "C",
        ...extraEnv,
      },
    },
  );
}

describe("Hermes managed startup integrity proof", () => {
  it("accepts canonical file and MCP state records with one generated API key beyond the strict base (#6427)", () => {
    const fixture = createFixture();
    const rawStrictCheck = spawnSync("sha256sum", ["-c", fixture.strictHashPath, "--status"], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(rawStrictCheck.error).toBeUndefined();
    expect(rawStrictCheck.status).not.toBeNull();
    expect(rawStrictCheck.status).not.toBe(0);
    const proof = runProof(fixture);
    expect(proof.status, proof.stderr).toBe(0);
    expect(proof.stdout).toBe("OK\n");
  });

  it("rejects a missing Hermes MCP state record (#6427)", () => {
    const fixture = createFixture();
    const [configRecord, envRecord] = readHashRecords(fixture.compatHashPath);
    writeHashRecords(fixture.compatHashPath, [configRecord!, envRecord!]);

    const proof = runProof(fixture);
    expect(proof.status).not.toBe(0);
    expect(proof.stderr).toContain(
      "Hermes compatibility hash does not contain exactly three records",
    );
  });

  it("rejects a malformed Hermes MCP state record (#6427)", () => {
    const fixture = createFixture();
    const [configRecord, envRecord] = readHashRecords(fixture.compatHashPath);
    writeHashRecords(fixture.compatHashPath, [
      configRecord!,
      envRecord!,
      `# nemoclaw-hermes-mcp-state-v1 intended=${"1".repeat(64)} applied=invalid`,
    ]);

    const proof = runProof(fixture);
    expect(proof.status).not.toBe(0);
    expect(proof.stderr).toContain(
      "Hermes compatibility hash contains an unexpected MCP state record",
    );
  });

  it("rejects duplicate Hermes MCP state records (#6427)", () => {
    const fixture = createFixture();
    const records = readHashRecords(fixture.compatHashPath);
    writeHashRecords(fixture.compatHashPath, [...records, MCP_STATE_RECORD]);

    const proof = runProof(fixture);
    expect(proof.status).not.toBe(0);
    expect(proof.stderr).toContain(
      "Hermes compatibility hash does not contain exactly three records",
    );
  });

  it("rejects a reordered Hermes MCP state record (#6427)", () => {
    const fixture = createFixture();
    const [configRecord, envRecord, stateRecord] = readHashRecords(fixture.compatHashPath);
    writeHashRecords(fixture.compatHashPath, [stateRecord!, configRecord!, envRecord!]);

    const proof = runProof(fixture);
    expect(proof.status).not.toBe(0);
    expect(proof.stderr).toContain("Hermes compatibility hash contains an unexpected file record");
  });

  it("rejects unexpected records after the Hermes MCP state record (#6427)", () => {
    const fixture = createFixture();
    const records = readHashRecords(fixture.compatHashPath);
    writeHashRecords(fixture.compatHashPath, [...records, "unexpected"]);

    const proof = runProof(fixture);
    expect(proof.status).not.toBe(0);
    expect(proof.stderr).toContain(
      "Hermes compatibility hash does not contain exactly three records",
    );
  });

  it("rejects non-key environment drift even when the compatibility hash accepts it", () => {
    const fixture = createFixture();
    const config = fs.readFileSync(fixture.configPath, "utf-8");
    const driftedEnv = `${fs.readFileSync(fixture.envPath, "utf-8")}UNEXPECTED=drift\n`;
    fs.writeFileSync(fixture.envPath, driftedEnv);
    writeHash(fixture.compatHashPath, fixture.configPath, config, fixture.envPath, driftedEnv);

    const proof = runProof(fixture);
    expect(proof.status).not.toBe(0);
    expect(proof.stderr).toContain(
      "Hermes environment differs from the strict startup base beyond the generated API key",
    );
  });

  it("rejects duplicate generated keys", () => {
    const duplicate = createFixture();
    fs.appendFileSync(duplicate.envPath, `API_SERVER_KEY=${"b".repeat(64)}\n`);
    const proof = runProof(duplicate);
    expect(proof.status).not.toBe(0);
    expect(proof.stderr).toContain("Hermes environment contains an unexpected API key assignment");
  });

  it("rejects a stale compatibility hash", () => {
    const stale = createFixture();
    const config = fs.readFileSync(stale.configPath, "utf-8");
    writeHash(stale.compatHashPath, stale.configPath, config, stale.envPath, stale.baseEnv);
    const proof = runProof(stale);
    expect(proof.status).not.toBe(0);
    expect(proof.stderr).toContain(
      "Hermes compatibility hash does not match the current environment",
    );
  });

  it("rejects a noncanonical API key assignment even when it belongs to the strict base", () => {
    const fixture = createFixture();
    const config = fs.readFileSync(fixture.configPath, "utf-8");
    const pollutedBase = `${fixture.baseEnv}export API_SERVER_KEY=${"b".repeat(64)}\n`;
    const liveEnv = `${pollutedBase}API_SERVER_KEY=${fixture.generatedKey}\n`;
    fs.writeFileSync(fixture.envPath, liveEnv);
    fs.chmodSync(fixture.strictHashPath, 0o644);
    writeHash(fixture.strictHashPath, fixture.configPath, config, fixture.envPath, pollutedBase);
    fs.chmodSync(fixture.strictHashPath, 0o444);
    writeHash(fixture.compatHashPath, fixture.configPath, config, fixture.envPath, liveEnv);

    const proof = runProof(fixture);
    expect(proof.status).not.toBe(0);
    expect(proof.stderr).toContain("Hermes environment contains an unexpected API key assignment");
  });

  it("ignores ambient Python module shadowing", () => {
    const fixture = createFixture();
    const shadowDir = path.join(fixture.root, "python-shadow");
    fs.mkdirSync(shadowDir);
    fs.writeFileSync(path.join(shadowDir, "hashlib.py"), 'raise SystemExit("shadowed hashlib")\n');

    const proof = runProof(fixture, { PYTHONPATH: shadowDir });
    expect(proof.status, proof.stderr).toBe(0);
    expect(proof.stdout).toBe("OK\n");
  });

  it("rejects a writable strict anchor and startup guard refusal", () => {
    const writable = createFixture();
    fs.chmodSync(writable.strictHashPath, 0o644);
    let proof = runProof(writable);
    expect(proof.status).not.toBe(0);
    expect(proof.stderr).toContain("Hermes strict hash is not the expected read-only owner anchor");

    const refused = createFixture();
    fs.writeFileSync(
      refused.startupLogPath,
      "Hermes runtime config guard refuses mutation under a foreign PID 1\n",
    );
    proof = runProof(refused);
    expect(proof.status).not.toBe(0);
    expect(proof.stderr).toContain("Hermes startup log contains a runtime config guard refusal");
  });
});
