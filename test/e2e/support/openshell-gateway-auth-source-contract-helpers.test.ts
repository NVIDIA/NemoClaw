// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assertOpenShellGatewayAuthArtifactsSafe,
  buildSandboxTokenContainerProbeDockerArgs,
  skipUnavailableProbeImage,
  withOpenShellGatewayAuthArtifactSafety,
} from "../live/openshell-gateway-auth-source-contract-helpers.ts";

function valuesAfterFlag(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ""] : []));
}

function withArtifactDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-artifact-scan-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("OpenShell gateway auth source contract helpers", () => {
  it("mounts only TLS material into the sandbox JWT Docker probe", () => {
    const stateDir = path.resolve("/tmp/nemoclaw-auth-source-state");
    const args = buildSandboxTokenContainerProbeDockerArgs({
      authorization: "Bearer sandbox-token",
      dockerBin: "docker",
      networkName: "nemoclaw-auth-source-net",
      payload: Buffer.from("sandbox request"),
      port: 47321,
      stateDir,
    });

    expect(valuesAfterFlag(args, "--volume")).toEqual([
      `${path.join(stateDir, "tls", "ca.crt")}:/tmp/nemoclaw-probe-ca.crt:ro`,
      `${path.join(stateDir, "tls", "client", "tls.crt")}:/tmp/nemoclaw-probe-client.crt:ro`,
      `${path.join(stateDir, "tls", "client", "tls.key")}:/tmp/nemoclaw-probe-client.key:ro`,
    ]);
    expect(valuesAfterFlag(args, "--env")).toEqual(
      expect.arrayContaining([
        "PROBE_AUTHORIZATION=Bearer sandbox-token",
        "PROBE_CA_PATH=/tmp/nemoclaw-probe-ca.crt",
        "PROBE_CLIENT_CERT_PATH=/tmp/nemoclaw-probe-client.crt",
        "PROBE_CLIENT_KEY_PATH=/tmp/nemoclaw-probe-client.key",
      ]),
    );
    expect(args).not.toContain(`${stateDir}:${stateDir}:ro`);

    const serializedArgs = args.join("\n");
    expect(serializedArgs).not.toContain("jwt/signing.pem");
    expect(serializedArgs).not.toContain("jwt/kid");
    expect(serializedArgs).not.toContain("openshell-gateway.toml");
  });

  it("omits sandbox JWT material from the mTLS-only Docker probe", () => {
    const args = buildSandboxTokenContainerProbeDockerArgs({
      dockerBin: "docker",
      networkName: "nemoclaw-auth-source-net",
      payload: Buffer.from("sandbox request"),
      port: 47321,
      stateDir: path.resolve("/tmp/nemoclaw-auth-source-state"),
    });

    expect(
      valuesAfterFlag(args, "--env").some((value) => value.startsWith("PROBE_AUTHORIZATION=")),
    ).toBe(false);
  });

  it("uses host networking to reach a loopback-only Linux gateway", () => {
    const args = buildSandboxTokenContainerProbeDockerArgs({
      dockerBin: "docker",
      networkName: "nemoclaw-auth-source-net",
      payload: Buffer.from("sandbox request"),
      port: 47321,
      stateDir: path.resolve("/tmp/nemoclaw-auth-source-state"),
      useHostNetwork: true,
    });

    expect(valuesAfterFlag(args, "--network")).toEqual(["host"]);
    expect(valuesAfterFlag(args, "--add-host")).toEqual(["host.openshell.internal:127.0.0.1"]);
  });

  it("hard-fails unavailable Docker probe images on GitHub Actions", () => {
    const skip = vi.fn();

    expect(() =>
      skipUnavailableProbeImage(
        { status: 125, stdout: "", stderr: "toomanyrequests: rate limit exceeded" },
        skip,
        true,
      ),
    ).toThrow(/became unavailable.*after the workflow pre-pull step.*toomanyrequests/);
    expect(skip).not.toHaveBeenCalled();
  });

  it("allows local runs to skip when the Docker probe image is unavailable", () => {
    const skip = vi.fn();

    skipUnavailableProbeImage({ status: 125, stdout: "", stderr: "manifest unknown" }, skip, false);

    expect(skip).toHaveBeenCalledWith("Docker probe image was unavailable: manifest unknown");
  });

  it("accepts ordinary auth-contract artifacts without secret-bearing material", () => {
    withArtifactDir((dir) => {
      fs.writeFileSync(
        path.join(dir, "scenario.json"),
        `${JSON.stringify({ contract: "sandbox JWT enabled", status: "passed" })}\n`,
      );
      fs.writeFileSync(
        path.join(dir, "openshell-gateway.log"),
        "INFO sandbox JWT enabled for gateway authentication\n",
      );

      expect(() => assertOpenShellGatewayAuthArtifactsSafe(dir)).not.toThrow();
    });
  });

  it.each([
    ["authorization header", '{"authorization":"redacted"}\n'],
    [
      "Bearer JWT",
      ["Bearer ", "eyJhbGciOiJFZERTQSJ9", ".", "eyJzdWIiOiJzYW5kYm94In0", ".", "signature\n"].join(
        "",
      ),
    ],
    ["JWT signing-key path", "/tmp/state/jwt/signing.pem\n"],
    ["JWT key-id path", "/tmp/state/jwt/kid\n"],
    ["gateway auth config path", "/tmp/state/openshell-gateway.toml\n"],
    ["gateway JWT configuration", "[openshell.gateway.gateway_jwt]\n"],
    [
      "private key",
      ["-----BEGIN ", "PRIVATE KEY-----\n", "redacted\n", "-----END ", "PRIVATE KEY-----\n"].join(
        "",
      ),
    ],
  ])("rejects %s content without echoing it", (label, content) => {
    withArtifactDir((dir) => {
      fs.writeFileSync(path.join(dir, "probe.json"), content);

      expect(() => assertOpenShellGatewayAuthArtifactsSafe(dir)).toThrow(
        new RegExp(`probe\\.json.*${label}`),
      );
    });
  });

  it.each([
    "jwt/signing.pem",
    "jwt/kid",
    "openshell-gateway.toml",
  ])("rejects sensitive artifact path %s", (relativePath) => {
    withArtifactDir((dir) => {
      const target = path.join(dir, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "redacted\n");

      expect(() => assertOpenShellGatewayAuthArtifactsSafe(dir)).toThrow(
        /sensitive auth file name/,
      );
    });
  });

  it("scans artifacts in the failure path before a workflow upload can run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-artifact-scan-"));
    try {
      await expect(
        withOpenShellGatewayAuthArtifactSafety(dir, async () => {
          fs.writeFileSync(path.join(dir, "failed-probe.json"), '{"authorization":"redacted"}\n');
          throw new Error("scenario failed");
        }),
      ).rejects.toThrow(/failed-probe\.json.*authorization header/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
