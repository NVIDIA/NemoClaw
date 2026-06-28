// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMcpCredentialReadinessCommand,
  buildMcpCredentialRevisionSnapshotCommand,
  parseMcpProviderAttachmentNames,
  parseMcpProviderMetadata,
  providerDetachChangedState,
} from "./mcp-bridge";
import {
  snapshotMcpCredentialRevision,
  waitForAttachedMcpCredential,
  waitForDetachedMcpCredential,
} from "./mcp-bridge-provider";
import * as processRecovery from "./process-recovery";

function decodeMcpProofTransport(command: string): string {
  const match = command.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d/);
  return match?.[1] ? Buffer.from(match[1], "base64").toString("utf8") : "";
}

describe("OpenShell MCP provider state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("parses provider type and credential keys without values", () => {
    expect(
      parseMcpProviderMetadata(`
Provider:

  Id: 11111111-2222-4333-8444-555555555555
  Name: alpha-mcp-github
  Type: generic
  Resource version: 7
  Credential keys: GITHUB_TOKEN
  Config keys: <none>
`),
    ).toEqual({
      id: "11111111-2222-4333-8444-555555555555",
      resourceVersion: 7,
      type: "generic",
      credentialKeys: ["GITHUB_TOKEN"],
    });
    expect(parseMcpProviderMetadata("Type: generic\nCredential keys: <none>\n")).toEqual({
      id: null,
      resourceVersion: null,
      type: "generic",
      credentialKeys: [],
    });
  });

  it("distinguishes a real detach from OpenShell's idempotent success", () => {
    expect(
      providerDetachChangedState(0, "✓ Detached provider alpha-mcp-github from sandbox alpha"),
    ).toBe(true);
    expect(
      providerDetachChangedState(0, "Provider alpha-mcp-github was not attached to sandbox alpha."),
    ).toBe(false);
  });

  it("parses the stock OpenShell sandbox provider table", () => {
    expect(
      parseMcpProviderAttachmentNames(`
NAME              TYPE     CREDENTIAL_KEYS   CONFIG_KEYS
alpha-mcp-github  generic  1                 0
alpha-mcp-slack   generic  1                 0
`),
    ).toEqual(["alpha-mcp-github", "alpha-mcp-slack"]);
    expect(parseMcpProviderAttachmentNames("No providers attached to sandbox alpha.\n")).toEqual(
      [],
    );
    expect(() => parseMcpProviderAttachmentNames("unexpected output\n")).toThrow(
      /attachment table header/,
    );
  });

  it("accepts current revision-scoped placeholders without exposing their value", () => {
    const command = buildMcpCredentialReadinessCommand("GITHUB_TOKEN");
    for (const value of [
      "openshell:resolve:env:GITHUB_TOKEN",
      "openshell:resolve:env:v11_GITHUB_TOKEN",
      "openshell:resolve:env:v0_GITHUB_TOKEN",
    ]) {
      const result = spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: { GITHUB_TOKEN: value },
      });
      expect(result.status, value).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }

    for (const value of [
      "raw-secret",
      "openshell:resolve:env:v_GITHUB_TOKEN",
      "openshell:resolve:env:v11_OTHER_TOKEN",
      "openshell:resolve:env:v11x_GITHUB_TOKEN",
    ]) {
      const result = spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: { GITHUB_TOKEN: value },
      });
      expect(result.status, value).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }
  });

  it("captures only validated OpenShell credential placeholders without printing values", () => {
    const snapshotPath = `/tmp/nemoclaw-mcp-provider-sync-${randomUUID()}`;
    const command = buildMcpCredentialRevisionSnapshotCommand("GITHUB_TOKEN", snapshotPath);

    try {
      for (const value of [
        "openshell:resolve:env:GITHUB_TOKEN",
        "openshell:resolve:env:v11_GITHUB_TOKEN",
      ]) {
        fs.rmSync(snapshotPath, { force: true });
        const result = spawnSync("/bin/sh", ["-c", command], {
          encoding: "utf8",
          env: { GITHUB_TOKEN: value },
        });
        expect(result.status, value).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
        expect(fs.readFileSync(snapshotPath, "utf8")).toBe(value);
      }

      const rawSecret = "never-write-or-print-this-secret";
      fs.rmSync(snapshotPath, { force: true });
      const rawResult = spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: { GITHUB_TOKEN: rawSecret },
      });
      expect(rawResult.status).not.toBe(0);
      expect(rawResult.stdout).toBe("");
      expect(rawResult.stderr).toBe("");
      expect(fs.readFileSync(snapshotPath, "utf8")).toBe("");
      expect(
        `${rawResult.stdout}${rawResult.stderr}${fs.readFileSync(snapshotPath, "utf8")}`,
      ).not.toContain(rawSecret);

      fs.rmSync(snapshotPath, { force: true });
      const wrapperMarker = "__NEMOCLAW_MCP_SNAPSHOT_WRAPPER_CONTINUED__";
      const absentResult = spawnSync(
        "/bin/sh",
        ["-c", `${command}\nprintf '%s\\n' '${wrapperMarker}'`],
        {
          encoding: "utf8",
          env: {},
        },
      );
      expect(absentResult.status).toBe(0);
      expect(absentResult.stdout.trim()).toBe(wrapperMarker);
      expect(absentResult.stderr).toBe("");
      expect(fs.readFileSync(snapshotPath, "utf8")).toBe("");
    } finally {
      fs.rmSync(snapshotPath, { force: true });
    }
  });

  it("does not overwrite a pre-existing credential revision snapshot", () => {
    const snapshotPath = `/tmp/nemoclaw-mcp-provider-sync-${randomUUID()}`;
    const sentinel = "pre-existing-snapshot";
    fs.writeFileSync(snapshotPath, sentinel, { mode: 0o600 });

    try {
      const result = spawnSync(
        "/bin/sh",
        ["-c", buildMcpCredentialRevisionSnapshotCommand("GITHUB_TOKEN", snapshotPath)],
        {
          encoding: "utf8",
          env: {
            GITHUB_TOKEN: "openshell:resolve:env:v11_GITHUB_TOKEN",
          },
        },
      );
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(fs.readFileSync(snapshotPath, "utf8")).toBe(sentinel);
    } finally {
      fs.rmSync(snapshotPath, { force: true });
    }
  });

  it("uses an OpenShell-only exec for provider credential proofs", () => {
    const exec = vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue(null);

    expect(() =>
      snapshotMcpCredentialRevision("alpha", {
        server: "github",
        agent: "openclaw",
        adapter: "mcporter",
        url: "https://mcp.example.test/mcp",
        env: ["GITHUB_TOKEN"],
        providerName: "alpha-mcp-github-0123456789abcdef",
        providerId: "11111111-2222-4333-8444-555555555555",
        policyName: "mcp-bridge-github",
        addedAt: "2026-06-01T00:00:00.000Z",
      }),
    ).toThrow(/Could not capture the current OpenShell credential revision/);
    const proofCommand = exec.mock.calls[0]?.[1] ?? "";
    expect(proofCommand).not.toMatch(/[\r\n]/);
    expect(proofCommand).toContain("base64 -d");
    expect(decodeMcpProofTransport(proofCommand)).toContain("GITHUB_TOKEN");
    expect(exec).toHaveBeenCalledWith("alpha", proofCommand, undefined, {
      allowLocalDockerFallback: false,
    });
    const decodeFailure = spawnSync("/bin/sh", ["-c", proofCommand.replace("base64 -d", "false")]);
    expect(decodeFailure.status).not.toBe(0);
  });

  it("uses a newline-free OpenShell transport for attachment readiness", () => {
    const exec = vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
    });

    waitForAttachedMcpCredential("alpha", {
      server: "github",
      agent: "openclaw",
      adapter: "mcporter",
      url: "https://mcp.example.test/mcp",
      env: ["GITHUB_TOKEN"],
      providerName: "alpha-mcp-github-0123456789abcdef",
      providerId: "11111111-2222-4333-8444-555555555555",
      policyName: "mcp-bridge-github",
      addedAt: "2026-06-01T00:00:00.000Z",
    });

    const proofCommand = exec.mock.calls[0]?.[1] ?? "";
    expect(proofCommand).not.toMatch(/[\r\n]/);
    expect(decodeMcpProofTransport(proofCommand)).toContain("valid_placeholder");
    expect(decodeMcpProofTransport(proofCommand)).toContain("GITHUB_TOKEN");
  });

  it("fails detach verification when the strict OpenShell exec is unavailable", () => {
    vi.stubEnv("NEMOCLAW_MCP_PROVIDER_SYNC_TIMEOUT_SECONDS", "1");
    const exec = vi.spyOn(processRecovery, "executeSandboxExecCommand").mockReturnValue(null);
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(1_000);

    expect(() =>
      waitForDetachedMcpCredential("alpha", {
        server: "github",
        agent: "openclaw",
        adapter: "mcporter",
        url: "https://mcp.example.test/mcp",
        env: ["GITHUB_TOKEN"],
        providerName: "alpha-mcp-github-0123456789abcdef",
        providerId: "11111111-2222-4333-8444-555555555555",
        policyName: "mcp-bridge-github",
        addedAt: "2026-06-01T00:00:00.000Z",
      }),
    ).toThrow(/did not confirm credential 'GITHUB_TOKEN' was revoked/);

    const proofCommand = exec.mock.calls[0]?.[1] ?? "";
    expect(proofCommand).not.toMatch(/[\r\n]/);
    expect(decodeMcpProofTransport(proofCommand)).toContain("GITHUB_TOKEN+x");
    expect(exec).toHaveBeenCalledWith("alpha", proofCommand, undefined, {
      allowLocalDockerFallback: false,
    });
  });

  it("requires a changed credential revision after provider updates", () => {
    const snapshotPath = `/tmp/nemoclaw-mcp-provider-sync-${randomUUID()}`;
    const runReadiness = (value: string) =>
      spawnSync(
        "/bin/sh",
        ["-c", buildMcpCredentialReadinessCommand("GITHUB_TOKEN", snapshotPath)],
        { encoding: "utf8", env: { GITHUB_TOKEN: value } },
      );

    try {
      for (const [prior, stale, refreshed] of [
        [
          "openshell:resolve:env:v11_GITHUB_TOKEN",
          "openshell:resolve:env:v11_GITHUB_TOKEN",
          "openshell:resolve:env:v12_GITHUB_TOKEN",
        ],
        [
          "openshell:resolve:env:GITHUB_TOKEN",
          "openshell:resolve:env:GITHUB_TOKEN",
          "openshell:resolve:env:v1_GITHUB_TOKEN",
        ],
      ]) {
        fs.writeFileSync(snapshotPath, prior, { mode: 0o600 });
        const staleResult = runReadiness(stale);
        expect(staleResult.status, prior).not.toBe(0);
        expect(staleResult.stdout).toBe("");
        expect(staleResult.stderr).toBe("");

        const refreshedResult = runReadiness(refreshed);
        expect(refreshedResult.status, prior).toBe(0);
        expect(refreshedResult.stdout).toBe("");
        expect(refreshedResult.stderr).toBe("");
      }
    } finally {
      fs.rmSync(snapshotPath, { force: true });
    }
  });

  it("treats an empty pre-update snapshot as presence-only and rejects malformed prior state", () => {
    const snapshotPath = `/tmp/nemoclaw-mcp-provider-sync-${randomUUID()}`;
    const command = buildMcpCredentialReadinessCommand("GITHUB_TOKEN", snapshotPath);
    const run = (value: string) =>
      spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
        env: { GITHUB_TOKEN: value },
      });

    try {
      fs.writeFileSync(snapshotPath, "", { mode: 0o600 });
      for (const value of [
        "openshell:resolve:env:GITHUB_TOKEN",
        "openshell:resolve:env:v1_GITHUB_TOKEN",
      ]) {
        const result = run(value);
        expect(result.status, value).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
      }

      fs.writeFileSync(snapshotPath, "raw-or-corrupt-prior-value", {
        mode: 0o600,
      });
      const malformedResult = run("openshell:resolve:env:v2_GITHUB_TOKEN");
      expect(malformedResult.status).not.toBe(0);
      expect(malformedResult.stdout).toBe("");
      expect(malformedResult.stderr).toBe("");

      fs.rmSync(snapshotPath, { force: true });
      const missingResult = run("openshell:resolve:env:v2_GITHUB_TOKEN");
      expect(missingResult.status).not.toBe(0);
      expect(missingResult.stdout).toBe("");
      expect(missingResult.stderr).toBe("");
    } finally {
      fs.rmSync(snapshotPath, { force: true });
    }
  });
});
