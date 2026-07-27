// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  openShellGatewayAuthArtifactSafetyMarkerName,
  scanAndApproveOpenShellGatewayAuthArtifacts,
} from "../../../tools/e2e/openshell-gateway-auth-artifact-safety.mts";
import { ArtifactSink } from "../fixtures/artifacts.ts";
import {
  assertOpenShellGatewayAuthArtifactsSafe,
  buildSandboxTokenContainerProbeDockerArgs,
  registerSandboxJwtArtifactRedaction,
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

  it("redacts a minted sandbox token before gateway output reaches an artifact (#7101)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-artifact-redaction-"));
    try {
      const artifacts = new ArtifactSink(dir);
      const sandboxToken = "opaque-sandbox-token-not-covered-by-canonical-patterns";
      registerSandboxJwtArtifactRedaction(artifacts, sandboxToken);

      await artifacts.writeText("openshell-gateway.log", `gateway echoed ${sandboxToken}\n`);

      const content = fs.readFileSync(path.join(dir, "openshell-gateway.log"), "utf8");
      expect(content).toContain("[REDACTED]");
      expect(content).not.toContain(sandboxToken);
      expect(() => assertOpenShellGatewayAuthArtifactsSafe(dir)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binds artifact safety approval to the current GitHub run attempt (#7101)", () => {
    expect(
      openShellGatewayAuthArtifactSafetyMarkerName({
        GITHUB_RUN_ATTEMPT: "4",
        GITHUB_RUN_ID: "29897237525",
      }),
    ).toBe("artifact-safety-29897237525-4.passed");
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

  it("removes rejected artifacts before an unconditional workflow upload can run (#7101)", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-artifact-scan-"));
    const dir = path.join(parent, "uploadable-auth-artifacts");
    fs.mkdirSync(dir);
    try {
      await expect(
        withOpenShellGatewayAuthArtifactSafety(dir, async () => {
          fs.writeFileSync(path.join(dir, "failed-probe.json"), '{"authorization":"redacted"}\n');
          throw new Error("scenario failed");
        }),
      ).rejects.toThrow(/failed-probe\.json.*authorization header/);
      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.readdirSync(parent)).toEqual([]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("preserves safe diagnostics when the scenario itself fails (#7101)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-artifact-safe-failure-"));
    try {
      await expect(
        withOpenShellGatewayAuthArtifactSafety(dir, async () => {
          fs.writeFileSync(path.join(dir, "failed-probe.json"), '{"status":"failed"}\n');
          throw new Error("scenario failed");
        }),
      ).rejects.toThrow("scenario failed");
      expect(fs.readFileSync(path.join(dir, "failed-probe.json"), "utf8")).toContain(
        '"status":"failed"',
      );
      const approved = scanAndApproveOpenShellGatewayAuthArtifacts(dir);
      try {
        expect(fs.readFileSync(path.join(approved, "failed-probe.json"), "utf8")).toContain(
          '"status":"failed"',
        );
        expect(
          fs.existsSync(path.join(approved, openShellGatewayAuthArtifactSafetyMarkerName())),
        ).toBe(true);
      } finally {
        fs.rmSync(approved, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("withholds safety approval when quarantine and deletion both fail (#7101)", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-artifact-fail-closed-"));
    const dir = path.join(parent, "uploadable-auth-artifacts");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "failed-probe.json"), '{"authorization":"redacted"}\n');
    vi.stubEnv("GITHUB_RUN_ID", "29897237525");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "9");
    const originalRmSync = fs.rmSync.bind(fs);
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated quarantine move failure");
    });
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      expect(path.resolve(String(target)), "simulated artifact deletion failure").not.toBe(
        path.resolve(dir),
      );
      originalRmSync(target, options);
    });

    try {
      await expect(
        Promise.resolve().then(() => scanAndApproveOpenShellGatewayAuthArtifacts(dir)),
      ).rejects.toThrow(/failed safety approval and quarantine/);
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      rmSpy.mockRestore();
      renameSpy.mockRestore();
      vi.unstubAllEnvs();
      originalRmSync(parent, { recursive: true, force: true });
    }
  });

  it("deletes rejected artifacts when quarantine cannot cross filesystems (#7101)", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-artifact-exdev-"));
    const dir = path.join(parent, "uploadable-auth-artifacts");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "failed-probe.json"), '{"authorization":"redacted"}\n');
    let quarantineRoot: string | undefined;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((_source, destination) => {
      quarantineRoot = path.dirname(String(destination));
      throw Object.assign(new Error("simulated cross-device quarantine move"), { code: "EXDEV" });
    });

    try {
      let rejection: unknown;
      try {
        scanAndApproveOpenShellGatewayAuthArtifacts(dir);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toMatch(/failed-probe\.json.*authorization header/);
      expect(rejection).not.toBeInstanceOf(AggregateError);
      expect(fs.existsSync(dir)).toBe(false);
      expect(quarantineRoot).toBeDefined();
      expect(fs.existsSync(quarantineRoot as string)).toBe(false);
    } finally {
      renameSpy.mockRestore();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects an unsafe artifact written after scenario finalization (#7101)", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-artifact-post-test-"));
    const dir = path.join(parent, "uploadable-auth-artifacts");
    fs.mkdirSync(dir);
    try {
      await withOpenShellGatewayAuthArtifactSafety(dir, async () => {
        fs.writeFileSync(path.join(dir, "scenario.json"), '{"status":"passed"}\n');
      });
      expect(fs.existsSync(path.join(dir, openShellGatewayAuthArtifactSafetyMarkerName()))).toBe(
        false,
      );

      fs.writeFileSync(path.join(dir, "cleanup.json"), '{"authorization":"leaked"}\n');

      expect(() => scanAndApproveOpenShellGatewayAuthArtifacts(dir)).toThrow(
        /cleanup\.json.*authorization header/,
      );
      expect(fs.existsSync(dir)).toBe(false);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("uploads a vetted staging payload that later source mutations cannot change (#7101)", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-artifact-staging-"));
    const dir = path.join(parent, "uploadable-auth-artifacts");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "scenario.json"), '{"status":"passed"}\n');
    const approved = scanAndApproveOpenShellGatewayAuthArtifacts(dir, {
      GITHUB_RUN_ATTEMPT: "3",
      GITHUB_RUN_ID: "29897237525",
    });
    try {
      fs.writeFileSync(path.join(dir, "late.json"), '{"authorization":"leaked"}\n');

      expect(fs.existsSync(path.join(approved, "late.json"))).toBe(false);
      expect(fs.readFileSync(path.join(approved, "scenario.json"), "utf8")).toBe(
        '{"status":"passed"}\n',
      );
      expect(fs.existsSync(path.join(approved, "artifact-safety-29897237525-3.passed"))).toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
      fs.rmSync(approved, { recursive: true, force: true });
    }
  });

  it("rejects a scanned nested directory replaced before the approved copy (#7101)", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-artifact-dir-swap-"));
    const dir = path.join(parent, "uploadable-auth-artifacts");
    const nested = path.join(dir, "nested");
    const originalNested = path.join(parent, "original-nested");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(nested, "scenario.json"), '{"status":"passed"}\n');
    fs.writeFileSync(path.join(outside, "scenario.json"), '{"status":"external"}\n');
    const originalMkdir = fs.mkdirSync.bind(fs);
    let approvedRoot: string | undefined;
    let approvedNested: string | undefined;
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementationOnce((target, options) => {
      const result = originalMkdir(target, options);
      approvedNested = String(target);
      approvedRoot = path.dirname(approvedNested);
      fs.renameSync(nested, originalNested);
      fs.symlinkSync(outside, nested, "dir");
      return result;
    });

    try {
      expect(() => scanAndApproveOpenShellGatewayAuthArtifacts(dir)).toThrow(
        /nested.*entry identity changed during safety approval/,
      );
      expect(path.basename(approvedNested as string)).toBe("nested");
      expect(path.basename(approvedRoot as string)).toMatch(/^nemoclaw-approved-auth-artifacts-/);
      expect(approvedRoot).toBeDefined();
      expect(fs.existsSync(approvedRoot as string)).toBe(false);
      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.readFileSync(path.join(outside, "scenario.json"), "utf8")).toContain("external");
    } finally {
      mkdirSpy.mockRestore();
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("closes the source when the approved artifact cannot be opened (#7101)", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-auth-artifact-open-failure-"));
    const dir = path.join(parent, "uploadable-auth-artifacts");
    const artifactPath = path.join(dir, "scenario.json");
    fs.mkdirSync(dir);
    fs.writeFileSync(artifactPath, '{"status":"passed"}\n');
    const originalOpen = fs.openSync.bind(fs);
    let scanSourceFd: number | undefined;
    let copySourceFd: number | undefined;
    const openSpy = vi
      .spyOn(fs, "openSync")
      .mockImplementationOnce((target, flags, mode) => {
        scanSourceFd = originalOpen(target, flags, mode);
        return scanSourceFd;
      })
      .mockImplementationOnce((target, flags, mode) => {
        copySourceFd = originalOpen(target, flags, mode);
        return copySourceFd;
      })
      .mockImplementationOnce(() => {
        throw new Error("simulated approved destination open failure");
      });
    try {
      expect(() => scanAndApproveOpenShellGatewayAuthArtifacts(dir)).toThrow(
        "simulated approved destination open failure",
      );
      expect(scanSourceFd).toBeDefined();
      expect(copySourceFd).toBeDefined();
      expect(() => fs.fstatSync(scanSourceFd as number)).toThrowError(
        expect.objectContaining({ code: "EBADF" }),
      );
      expect(() => fs.fstatSync(copySourceFd as number)).toThrowError(
        expect.objectContaining({ code: "EBADF" }),
      );
    } finally {
      openSpy.mockRestore();
      for (const descriptor of [scanSourceFd, copySourceFd].filter(
        (candidate): candidate is number => candidate !== undefined,
      )) {
        try {
          fs.closeSync(descriptor);
        } catch {
          // The implementation already closed the descriptor.
        }
      }
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
