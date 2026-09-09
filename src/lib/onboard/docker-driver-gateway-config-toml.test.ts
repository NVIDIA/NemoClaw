// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { printOnboardResumeHint, resetOnboardResumeHintForTests } from "./resume-hint";
import {
  baseGatewayEnv,
  DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS,
  jwtBundlePaths,
  mintOpenShellStyleSandboxJwt,
  parseTomlString,
  validateOpenShellStyleSandboxJwt,
  writeGatewayConfig,
  writeOpenShell0044PreAuthState,
} from "../../../test/support/openshell-gateway-config-helpers";
import {
  buildDockerDriverGatewayConfigToml,
  ensureDockerDriverGatewayJwtBundle,
  gatewayIdForStateDir,
  hasStateScopedSandboxNamespace,
  NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV,
  openExistingGatewayConfigAuthority,
  prepareDockerDriverGatewayConfigEnv,
} from "./docker-driver-gateway-config";
import { openRegularFileNoFollow } from "../adapters/fs/regular-file";
import {
  buildDockerDriverGatewayRuntimeMarker,
  writeDockerDriverGatewayRuntimeMarker,
} from "./docker-driver-gateway-runtime-marker";
import { prepareNativePodmanGatewayHostRuntime } from "./runtime-provider/podman-runtime-surfaces";
import { createDockerRuntimeProviderBundle } from "./runtime-provider/docker";

const SCOPED_NAMESPACE_PROOF_DRIVER = path.join(
  process.cwd(),
  "test/fixtures/gateway-scoped-namespace-proof-driver.cts",
);

function readRegularFileUtf8(target: string): string {
  const file = openRegularFileNoFollow(target);
  try {
    return file.readUtf8();
  } finally {
    file.close();
  }
}

function legacyGatewayIdForStateDir(stateDir: string): string {
  const leaf = path.basename(path.resolve(stateDir)).replace(/[^A-Za-z0-9_.-]/g, "-");
  return leaf ? `nemoclaw-${leaf}` : "nemoclaw";
}

function podmanGatewayRuntime(env: Record<string, string>) {
  return prepareNativePodmanGatewayHostRuntime({
    environment: { ...process.env, ...env },
    platform: "linux",
    socketPath: env.OPENSHELL_PODMAN_SOCKET,
  });
}

function observedDockerGatewayRuntime() {
  const gateway = createDockerRuntimeProviderBundle().gateway as Extract<
    ReturnType<typeof createDockerRuntimeProviderBundle>["gateway"],
    { supported: true }
  >;
  return gateway.observeHostRuntime({ environment: {}, platform: process.platform });
}

function writePreScopedGatewayConfig(
  stateDir: string,
  includeDefaultNamespace = false,
  driver: "docker" | "podman" = "docker",
): { configPath: string; env: Record<string, string>; gatewayId: string } {
  const env = baseGatewayEnv(stateDir);
  Object.assign(
    env,
    driver === "podman"
      ? {
          OPENSHELL_DRIVERS: "podman",
          OPENSHELL_PODMAN_SOCKET: path.join(stateDir, "podman.sock"),
        }
      : {},
  );
  const gatewayId = legacyGatewayIdForStateDir(stateDir);
  const jwtBundle = ensureDockerDriverGatewayJwtBundle(stateDir);
  const gatewayRuntime =
    driver === "podman"
      ? prepareNativePodmanGatewayHostRuntime({
          environment: { ...process.env, ...env },
          platform: "linux",
          socketPath: env.OPENSHELL_PODMAN_SOCKET,
        })
      : undefined;
  let toml = buildDockerDriverGatewayConfigToml(
    env,
    "/usr/bin/openshell-sandbox",
    jwtBundle,
    gatewayId,
    gatewayRuntime,
  );
  toml = toml.replace(
    /^sandbox_namespace = .*\n/m,
    includeDefaultNamespace ? 'sandbox_namespace = "default"\n' : "",
  );
  const configPath = path.join(stateDir, "openshell-gateway.toml");
  fs.writeFileSync(configPath, toml, { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  return { configPath, env, gatewayId };
}

describe("docker-driver-gateway config TOML", () => {
  it("writes OpenShell 0.0.72 gateway JWT config into the managed state dir", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-config-"));
    try {
      const env = writeGatewayConfig(stateDir);
      const configPath = path.join(stateDir, "openshell-gateway.toml");
      const signingKeyPath = path.join(stateDir, "jwt", "signing.pem");
      const publicKeyPath = path.join(stateDir, "jwt", "public.pem");
      const kidPath = path.join(stateDir, "jwt", "kid");
      const toml = fs.readFileSync(configPath, "utf-8");

      expect(env.OPENSHELL_GATEWAY_CONFIG).toBe(configPath);
      expect(env.OPENSHELL_GRPC_ENDPOINT).toBe("https://127.0.0.1:8080");
      expect(toml).toContain("[openshell.gateway.gateway_jwt]");
      expect(toml).toContain(`signing_key_path = "${signingKeyPath}"`);
      expect(toml).toContain(`public_key_path = "${publicKeyPath}"`);
      expect(toml).toContain(`kid_path = "${kidPath}"`);
      expect(toml).toContain(`gateway_id = "${gatewayIdForStateDir(stateDir)}"`);
      expect(toml).toContain(`sandbox_namespace = "${gatewayIdForStateDir(stateDir)}"`);
      expect(toml).toContain(`ttl_secs = ${DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS}`);
      expect(toml).toContain("disable_tls = false");
      expect(toml).toContain("[openshell.gateway.tls]");
      expect(toml).toContain(`cert_path = "${path.join(stateDir, "tls", "server", "tls.crt")}"`);
      expect(toml).toContain(`key_path = "${path.join(stateDir, "tls", "server", "tls.key")}"`);
      expect(toml).toContain(`client_ca_path = "${path.join(stateDir, "tls", "ca.crt")}"`);
      expect(toml).toContain("[openshell.gateway.mtls_auth]");
      expect(toml).toContain("enabled = true");
      expect(toml).toContain("[openshell.gateway.auth]");
      expect(toml).toContain("allow_unauthenticated_users = false");
      expect(toml).toContain('compute_drivers = ["docker"]');
      expect(toml).toContain('grpc_endpoint = "https://127.0.0.1:8080"');
      expect(toml).toContain(`guest_tls_ca = "${path.join(stateDir, "tls", "ca.crt")}"`);
      expect(toml).toContain(
        `guest_tls_cert = "${path.join(stateDir, "tls", "client", "tls.crt")}"`,
      );
      expect(toml).toContain(
        `guest_tls_key = "${path.join(stateDir, "tls", "client", "tls.key")}"`,
      );
      expect(toml).toContain('supervisor_bin = "/usr/bin/openshell-sandbox"');
      expect(env[NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]).toBe(gatewayIdForStateDir(stateDir));
      expect(env.OPENSHELL_DISABLE_GATEWAY_AUTH).toBeUndefined();
      expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(stateDir, "jwt")).mode & 0o777).toBe(0o700);
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(signingKeyPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(publicKeyPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(kidPath).mode & 0o777).toBe(0o600);

      const signingKeyBeforeRestart = readRegularFileUtf8(signingKeyPath);
      const restartedEnv = writeGatewayConfig(stateDir);
      const restartedToml = readRegularFileUtf8(configPath);
      expect(restartedEnv[NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]).toBe(
        gatewayIdForStateDir(stateDir),
      );
      expect(parseTomlString(restartedToml, "gateway_id")).toBe(gatewayIdForStateDir(stateDir));
      expect(parseTomlString(restartedToml, "sandbox_namespace")).toBe(
        gatewayIdForStateDir(stateDir),
      );
      expect(readRegularFileUtf8(signingKeyPath)).toBe(signingKeyBeforeRestart);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves the pre-scoped Docker identity and an existing sandbox JWT on restart", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-upgrade-"));
    try {
      const { configPath, env, gatewayId } = writePreScopedGatewayConfig(stateDir);
      const bundle = jwtBundlePaths(stateDir);
      const kid = fs.readFileSync(bundle.kidPath, "utf-8").trim();
      const signingKeyBefore = fs.readFileSync(bundle.signingKeyPath, "utf-8");
      const token = mintOpenShellStyleSandboxJwt({
        signingKeyPath: bundle.signingKeyPath,
        kid,
        gatewayId,
        sandboxId: "legacy-sandbox",
        iat: 1_700_000_000,
        exp: 0,
      });
      env.OPENSHELL_DOCKER_NETWORK_NAME = "openshell-upgraded";

      prepareDockerDriverGatewayConfigEnv(env, stateDir, "/opt/openshell/sandbox");

      const rewritten = fs.readFileSync(configPath, "utf-8");
      expect(parseTomlString(rewritten, "gateway_id")).toBe(gatewayId);
      expect(parseTomlString(rewritten, "sandbox_namespace")).toBe("default");
      expect(parseTomlString(rewritten, "network_name")).toBe("openshell-upgraded");
      expect(parseTomlString(rewritten, "supervisor_bin")).toBe("/opt/openshell/sandbox");
      expect(env[NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]).toBe("default");
      expect(fs.readFileSync(bundle.signingKeyPath, "utf-8")).toBe(signingKeyBefore);
      expect(
        validateOpenShellStyleSandboxJwt({
          token,
          publicKeyPath: bundle.publicKeyPath,
          kid,
          gatewayId: parseTomlString(rewritten, "gateway_id"),
          now: 1_700_000_100,
          expectedSandboxId: "legacy-sandbox",
        }),
      ).not.toBeNull();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves the v0.0.74 gateway identity while upgrading its reviewed JWT TTL", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-v0-0-74-"));
    try {
      const { configPath, env, gatewayId } = writePreScopedGatewayConfig(stateDir);
      const bundle = jwtBundlePaths(stateDir);
      const kid = fs.readFileSync(bundle.kidPath, "utf-8").trim();
      const token = mintOpenShellStyleSandboxJwt({
        signingKeyPath: bundle.signingKeyPath,
        kid,
        gatewayId,
        sandboxId: "v0-0-74-sandbox",
        iat: 1_700_000_000,
        exp: 0,
      });
      const legacyToml = fs
        .readFileSync(configPath, "utf-8")
        .replace(`ttl_secs = ${DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS}`, "ttl_secs = 3600");
      fs.writeFileSync(configPath, legacyToml, { encoding: "utf-8", mode: 0o600 });
      const signingKeyBefore = fs.readFileSync(bundle.signingKeyPath, "utf-8");

      prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox");

      const rewritten = fs.readFileSync(configPath, "utf-8");
      expect(parseTomlString(rewritten, "gateway_id")).toBe(gatewayId);
      expect(rewritten).toContain(`ttl_secs = ${DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS}`);
      expect(rewritten).not.toContain("ttl_secs = 3600");
      expect(fs.readFileSync(bundle.signingKeyPath, "utf-8")).toBe(signingKeyBefore);
      expect(
        validateOpenShellStyleSandboxJwt({
          token,
          publicKeyPath: bundle.publicKeyPath,
          kid,
          gatewayId: parseTomlString(rewritten, "gateway_id"),
          now: 1_700_000_100,
          expectedSandboxId: "v0-0-74-sandbox",
        }),
      ).not.toBeNull();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects an unreviewed legacy JWT TTL without mutating the config", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-legacy-ttl-"));
    try {
      const { configPath, env } = writePreScopedGatewayConfig(stateDir);
      const unreviewedToml = fs
        .readFileSync(configPath, "utf-8")
        .replace(`ttl_secs = ${DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS}`, "ttl_secs = 3601");
      fs.writeFileSync(configPath, unreviewedToml, { encoding: "utf-8", mode: 0o600 });

      expect(() =>
        prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox"),
      ).toThrow(/does not match NemoClaw's generated form/);
      expect(fs.readFileSync(configPath, "utf-8")).toBe(unreviewedToml);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects the legacy JWT TTL on a scoped gateway without mutating the config", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-scoped-ttl-"));
    try {
      const env = writeGatewayConfig(stateDir);
      const configPath = path.join(stateDir, "openshell-gateway.toml");
      const invalidToml = fs
        .readFileSync(configPath, "utf-8")
        .replace(`ttl_secs = ${DOCKER_DRIVER_GATEWAY_JWT_TTL_SECS}`, "ttl_secs = 3600");
      fs.writeFileSync(configPath, invalidToml, { encoding: "utf-8", mode: 0o600 });

      expect(() =>
        prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox"),
      ).toThrow(/does not match NemoClaw's generated form/);
      expect(fs.readFileSync(configPath, "utf-8")).toBe(invalidToml);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("recognizes an explicitly restored default namespace as the legacy identity", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-restored-"));
    try {
      const { configPath, env, gatewayId } = writePreScopedGatewayConfig(stateDir, true);

      prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox");

      const rewritten = fs.readFileSync(configPath, "utf-8");
      expect(parseTomlString(rewritten, "gateway_id")).toBe(gatewayId);
      expect(parseTomlString(rewritten, "sandbox_namespace")).toBe("default");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not replace an incomplete legacy JWT bundle", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-jwt-missing-"));
    try {
      const { configPath, env } = writePreScopedGatewayConfig(stateDir);
      const configBefore = fs.readFileSync(configPath, "utf-8");
      const bundle = jwtBundlePaths(stateDir);
      const signingKeyBefore = fs.readFileSync(bundle.signingKeyPath, "utf-8");
      fs.unlinkSync(bundle.publicKeyPath);

      expect(() =>
        prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox"),
      ).toThrow(/Legacy gateway JWT bundle is incomplete/);
      expect(fs.readFileSync(configPath, "utf-8")).toBe(configBefore);
      expect(fs.readFileSync(bundle.signingKeyPath, "utf-8")).toBe(signingKeyBefore);
      expect(fs.existsSync(bundle.publicKeyPath)).toBe(false);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not rewrite an existing gateway config with an ambiguous identity", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-ambiguous-"));
    try {
      const { configPath, env, gatewayId } = writePreScopedGatewayConfig(stateDir);
      const bundle = jwtBundlePaths(stateDir);
      const signingKeyBefore = fs.readFileSync(bundle.signingKeyPath, "utf-8");
      const ambiguousToml = fs
        .readFileSync(configPath, "utf-8")
        .replace(`gateway_id = "${gatewayId}"`, 'gateway_id = "operator-managed"');
      fs.writeFileSync(configPath, ambiguousToml, { encoding: "utf-8", mode: 0o600 });

      expect(() =>
        prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox"),
      ).toThrow(/neither the legacy nor scoped identity/);
      expect(fs.readFileSync(configPath, "utf-8")).toBe(ambiguousToml);
      expect(fs.readFileSync(bundle.signingKeyPath, "utf-8")).toBe(signingKeyBefore);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("names the configured driver and a recovery path when a Docker config blocks a Podman run (#10071)", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-cross-driver-"));
    try {
      const { configPath } = writePreScopedGatewayConfig(stateDir, false, "docker");
      const bundle = jwtBundlePaths(stateDir);
      const signingKeyBefore = fs.readFileSync(bundle.signingKeyPath, "utf-8");
      const dockerToml = fs.readFileSync(configPath, "utf-8");
      const podmanEnv = baseGatewayEnv(stateDir);
      Object.assign(podmanEnv, {
        OPENSHELL_DRIVERS: "podman",
        OPENSHELL_PODMAN_SOCKET: path.join(stateDir, "podman.sock"),
      });

      expect(() =>
        prepareDockerDriverGatewayConfigEnv(podmanEnv, stateDir, "/usr/bin/openshell-sandbox", {
          gatewayRuntime: podmanGatewayRuntime(podmanEnv),
        }),
      ).toThrow(
        /already configures a 'docker'-driver OpenShell gateway.*this run selected the 'podman' driver.*NemoClaw-managed state.*nemoclaw uninstall.*preserves externally managed or supervised state.*lifecycle authority.*NEMOCLAW_GATEWAY_PORT.*separate state directory.*NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR/s,
      );
      expect(fs.readFileSync(configPath, "utf-8")).toBe(dockerToml);
      expect(fs.readFileSync(bundle.signingKeyPath, "utf-8")).toBe(signingKeyBefore);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("names the configured driver and a recovery path when a Podman config blocks a Docker run (#10071)", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-cross-driver-"));
    try {
      const { configPath } = writePreScopedGatewayConfig(stateDir, false, "podman");
      const bundle = jwtBundlePaths(stateDir);
      const signingKeyBefore = fs.readFileSync(bundle.signingKeyPath, "utf-8");
      const podmanToml = fs.readFileSync(configPath, "utf-8");
      const dockerEnv = baseGatewayEnv(stateDir);

      expect(() =>
        prepareDockerDriverGatewayConfigEnv(dockerEnv, stateDir, "/usr/bin/openshell-sandbox"),
      ).toThrow(
        /already configures a 'podman'-driver OpenShell gateway.*this run selected the 'docker' driver/s,
      );
      expect(fs.readFileSync(configPath, "utf-8")).toBe(podmanToml);
      expect(fs.readFileSync(bundle.signingKeyPath, "utf-8")).toBe(signingKeyBefore);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not classify a malformed other-driver table as a cross-driver conflict (#10071)", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-malformed-driver-"));
    try {
      const { configPath } = writePreScopedGatewayConfig(stateDir, false, "docker");
      const malformedToml = fs
        .readFileSync(configPath, "utf-8")
        .replace(/^grpc_endpoint = .*$/m, 'grpc_endpoint = ""');
      fs.writeFileSync(configPath, malformedToml, { encoding: "utf-8", mode: 0o600 });
      const podmanEnv = baseGatewayEnv(stateDir);
      Object.assign(podmanEnv, {
        OPENSHELL_DRIVERS: "podman",
        OPENSHELL_PODMAN_SOCKET: path.join(stateDir, "podman.sock"),
      });

      expect(() =>
        prepareDockerDriverGatewayConfigEnv(podmanEnv, stateDir, "/usr/bin/openshell-sandbox", {
          gatewayRuntime: podmanGatewayRuntime(podmanEnv),
        }),
      ).toThrow(/driver config is incomplete/);
      expect(() =>
        prepareDockerDriverGatewayConfigEnv(podmanEnv, stateDir, "/usr/bin/openshell-sandbox", {
          gatewayRuntime: podmanGatewayRuntime(podmanEnv),
        }),
      ).not.toThrow(/already configures a 'docker'-driver/);
      expect(fs.readFileSync(configPath, "utf-8")).toBe(malformedToml);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("still reports the generic schema mismatch when neither driver table is present (#10071)", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-no-driver-table-"));
    try {
      const { configPath } = writePreScopedGatewayConfig(stateDir);
      const noDriversToml = fs
        .readFileSync(configPath, "utf-8")
        .replace(/\[openshell\.drivers\.docker\][\s\S]*$/, "");
      fs.writeFileSync(configPath, noDriversToml, { encoding: "utf-8", mode: 0o600 });
      const env = baseGatewayEnv(stateDir);

      let error: unknown;
      try {
        prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox");
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(
        /cannot prove its generated gateway identity \(the config does not match NemoClaw's schema\)/,
      );
      expect((error as Error).message).not.toContain("already configures");
      expect(fs.readFileSync(configPath, "utf-8")).toBe(noDriversToml);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("suppresses the circular '--resume' hint after a cross-driver conflict (#10071)", () => {
    resetOnboardResumeHintForTests();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-cross-driver-hint-"));
    try {
      writePreScopedGatewayConfig(stateDir, false, "docker");
      const podmanEnv = baseGatewayEnv(stateDir);
      Object.assign(podmanEnv, {
        OPENSHELL_DRIVERS: "podman",
        OPENSHELL_PODMAN_SOCKET: path.join(stateDir, "podman.sock"),
      });

      expect(() =>
        prepareDockerDriverGatewayConfigEnv(podmanEnv, stateDir, "/usr/bin/openshell-sandbox", {
          gatewayRuntime: podmanGatewayRuntime(podmanEnv),
        }),
      ).toThrow(/already configures a 'docker'-driver/);
      printOnboardResumeHint(true, console.error);
      const joined = errSpy.mock.calls.map((call) => String(call[0])).join("\n");
      // The generic hint repeats the exact command that just failed. Nothing
      // about host state changes between attempts, so it must not print.
      expect(joined).not.toContain("nemoclaw onboard --resume");
      expect(joined).not.toContain("nemoclaw onboard --experimental-profile portable --fresh");
    } finally {
      errSpy.mockRestore();
      resetOnboardResumeHintForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not suppress a later resume hint when an ownership probe swallows the conflict", () => {
    resetOnboardResumeHintForTests();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-probe-hint-"));
    try {
      writePreScopedGatewayConfig(stateDir, false, "podman");

      expect(hasStateScopedSandboxNamespace(stateDir)).toBe(false);
      const lines: string[] = [];
      printOnboardResumeHint(false, (line) => lines.push(line));
      expect(lines.join("\n")).toContain("nemoclaw onboard --resume");
    } finally {
      resetOnboardResumeHintForTests();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not rewrite an oversized gateway config (#8740)", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-oversized-"));
    try {
      const env = writeGatewayConfig(stateDir);
      const configPath = path.join(stateDir, "openshell-gateway.toml");
      fs.appendFileSync(configPath, `# ${"x".repeat(64 * 1024)}\n`);
      const oversizedToml = fs.readFileSync(configPath, "utf-8");

      expect(() =>
        prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox"),
      ).toThrow(
        /cannot prove its generated gateway identity \(the config could not be read safely:/,
      );
      expect(fs.readFileSync(configPath, "utf-8")).toBe(oversizedToml);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not accept a scoped namespace assignment embedded in TOML text", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-toml-text-"));
    try {
      writeGatewayConfig(stateDir);
      const configPath = path.join(stateDir, "openshell-gateway.toml");
      const namespace = gatewayIdForStateDir(stateDir);
      const misleadingToml = fs
        .readFileSync(configPath, "utf-8")
        .replace(
          /^sandbox_namespace = .*\n/m,
          `operator_note = """\nsandbox_namespace = "${namespace}"\n"""\n`,
        );
      fs.writeFileSync(configPath, misleadingToml, { encoding: "utf-8", mode: 0o600 });

      expect(hasStateScopedSandboxNamespace(stateDir)).toBe(false);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects a FIFO gateway config without blocking scoped cleanup proof",
    async () => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-fifo-"));
      let child: ReturnType<typeof spawn> | undefined;
      try {
        const configPath = path.join(stateDir, "openshell-gateway.toml");
        expect(spawnSync("mkfifo", [configPath]).status).toBe(0);
        const spawned = spawn(
          process.execPath,
          ["--import", "tsx", SCOPED_NAMESPACE_PROOF_DRIVER],
          {
            cwd: process.cwd(),
            env: { ...process.env, NEMOCLAW_TEST_GATEWAY_STATE_DIR: stateDir },
            stdio: "pipe",
          },
        );
        child = spawned;
        const result = await new Promise<{ code: number | null; stderr: string }>(
          (resolve, reject) => {
            let ready = false;
            let settled = false;
            let stdout = "";
            let stderr = "";
            let proofTimer: NodeJS.Timeout | undefined;
            const startupTimer = setTimeout(() => {
              settled ||
                ((settled = true),
                spawned.kill("SIGKILL"),
                reject(new Error("child did not finish importing the gateway config module")));
            }, 15_000);
            spawned.stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString("utf-8");
            });
            spawned.stdout.on("data", (chunk: Buffer) => {
              stdout += chunk.toString("utf-8");
              ready ||
                !stdout.includes("ready\n") ||
                ((ready = true),
                clearTimeout(startupTimer),
                (proofTimer = setTimeout(() => {
                  settled ||
                    ((settled = true),
                    spawned.kill("SIGKILL"),
                    reject(new Error("scoped cleanup proof blocked while opening a FIFO config")));
                }, 2_000)),
                spawned.stdin.write("run\n"));
            });
            spawned.once("error", (error) => {
              settled ||
                ((settled = true),
                clearTimeout(startupTimer),
                proofTimer && clearTimeout(proofTimer),
                reject(error));
            });
            spawned.once("exit", (code) => {
              settled ||
                ((settled = true),
                clearTimeout(startupTimer),
                proofTimer && clearTimeout(proofTimer),
                resolve({ code, stderr }));
            });
          },
        );

        expect(result.code, result.stderr).toBe(0);
      } finally {
        child?.kill("SIGKILL");
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it("does not preserve an incomplete generated driver config as a legacy identity", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-incomplete-"));
    try {
      const { configPath, env } = writePreScopedGatewayConfig(stateDir);
      const bundle = jwtBundlePaths(stateDir);
      const signingKeyBefore = fs.readFileSync(bundle.signingKeyPath, "utf-8");
      const incompleteToml = fs
        .readFileSync(configPath, "utf-8")
        .replace(/^supervisor_image = .*\n/m, "");
      fs.writeFileSync(configPath, incompleteToml, { encoding: "utf-8", mode: 0o600 });

      expect(() =>
        prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox"),
      ).toThrow(/driver config is incomplete/);
      expect(fs.readFileSync(configPath, "utf-8")).toBe(incompleteToml);
      expect(fs.readFileSync(bundle.signingKeyPath, "utf-8")).toBe(signingKeyBefore);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not recreate a missing config when durable gateway state remains", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-missing-config-"));
    try {
      fs.writeFileSync(path.join(stateDir, "openshell.db"), "durable-state", { mode: 0o600 });
      const env = baseGatewayEnv(stateDir);

      expect(() =>
        prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox"),
      ).toThrow(/durable gateway state exists without a config/);
      expect(fs.existsSync(path.join(stateDir, "openshell-gateway.toml"))).toBe(false);
      expect(fs.existsSync(path.join(stateDir, "jwt"))).toBe(false);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("creates the first authenticated config for a prepared OpenShell v0.0.44 pre-auth database", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-v0-0-55-"));
    try {
      writeOpenShell0044PreAuthState(stateDir);
      const env = baseGatewayEnv(stateDir);

      prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox", {
        allowOpenShell0044PreAuthDatabase: true,
      });

      const config = fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf-8");
      expect(parseTomlString(config, "gateway_id")).toBe(gatewayIdForStateDir(stateDir));
      expect(parseTomlString(config, "sandbox_namespace")).toBe(gatewayIdForStateDir(stateDir));
      expect(fs.readFileSync(path.join(stateDir, "openshell.db"), "utf-8")).toBe("legacy-database");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not treat a prepared authenticated-era database as pre-auth state", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-auth-era-"));
    try {
      fs.writeFileSync(path.join(stateDir, "openshell.db"), "current-database", { mode: 0o600 });
      writeDockerDriverGatewayRuntimeMarker(
        path.join(stateDir, "runtime.json"),
        buildDockerDriverGatewayRuntimeMarker({
          pid: 12_345,
          desiredEnv: { OPENSHELL_DISABLE_GATEWAY_AUTH: "false" },
          endpoint: "https://127.0.0.1:8080",
          gatewayBin: "/usr/local/bin/openshell-gateway",
          openshellVersion: "0.0.106",
        }),
      );
      const env = baseGatewayEnv(stateDir);

      expect(() =>
        prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox", {
          allowOpenShell0044PreAuthDatabase: true,
        }),
      ).toThrow(/durable gateway state exists without a config/);
      expect(fs.existsSync(path.join(stateDir, "openshell-gateway.toml"))).toBe(false);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not recreate a missing config when only the gateway JWT identity remains", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-jwt-only-"));
    try {
      const bundle = ensureDockerDriverGatewayJwtBundle(stateDir);
      const signingKeyBefore = fs.readFileSync(bundle.signingKeyPath, "utf-8");
      const env = baseGatewayEnv(stateDir);

      expect(() =>
        prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox"),
      ).toThrow(/durable gateway state exists without a config/);
      expect(fs.existsSync(path.join(stateDir, "openshell-gateway.toml"))).toBe(false);
      expect(fs.readFileSync(bundle.signingKeyPath, "utf-8")).toBe(signingKeyBefore);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it.each(["openshell-gateway.pid", "runtime.json"])(
    "creates a fresh config when only legacy runtime marker %s remains",
    (marker) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-pre-config-"));
      try {
        fs.writeFileSync(path.join(stateDir, marker), "retired-runtime", { mode: 0o600 });
        const env = baseGatewayEnv(stateDir);

        prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox");

        expect(fs.existsSync(path.join(stateDir, "openshell-gateway.toml"))).toBe(true);
        expect(
          parseTomlString(fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf-8"), "gateway_id"),
        ).toBe(gatewayIdForStateDir(stateDir));
      } finally {
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("does not trust or mutate a legacy JWT bundle in a non-private directory", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-jwt-mode-"));
    try {
      const { configPath, env } = writePreScopedGatewayConfig(stateDir);
      const bundle = jwtBundlePaths(stateDir);
      const configBefore = fs.readFileSync(configPath, "utf-8");
      const signingKeyBefore = fs.readFileSync(bundle.signingKeyPath, "utf-8");
      fs.chmodSync(path.dirname(bundle.signingKeyPath), 0o755);

      expect(() =>
        prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox"),
      ).toThrow(/JWT directory is not private and owner-controlled/);
      expect(fs.readFileSync(configPath, "utf-8")).toBe(configBefore);
      expect(fs.readFileSync(bundle.signingKeyPath, "utf-8")).toBe(signingKeyBefore);
      expect(fs.statSync(path.dirname(bundle.signingKeyPath)).mode & 0o777).toBe(0o755);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not normalize a non-canonical legacy state directory before rejecting it", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-state-mode-"));
    try {
      const { configPath, env } = writePreScopedGatewayConfig(stateDir);
      const bundle = jwtBundlePaths(stateDir);
      const configBefore = fs.readFileSync(configPath, "utf-8");
      const signingKeyBefore = fs.readFileSync(bundle.signingKeyPath, "utf-8");
      fs.chmodSync(stateDir, 0o500);

      expect(() =>
        prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox"),
      ).toThrow(/state directory is not owner-controlled with mode 0700/);
      expect(fs.statSync(stateDir).mode & 0o777).toBe(0o500);
      expect(fs.readFileSync(configPath, "utf-8")).toBe(configBefore);
      expect(fs.readFileSync(bundle.signingKeyPath, "utf-8")).toBe(signingKeyBefore);
    } finally {
      fs.chmodSync(stateDir, 0o700);
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("preserves the pre-scoped Podman JWT issuer on restart", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-upgrade-"));
    try {
      const { configPath, env, gatewayId } = writePreScopedGatewayConfig(stateDir, false, "podman");
      const bundle = jwtBundlePaths(stateDir);
      const kid = fs.readFileSync(bundle.kidPath, "utf-8").trim();
      const signingKeyBefore = fs.readFileSync(bundle.signingKeyPath, "utf-8");
      const token = mintOpenShellStyleSandboxJwt({
        signingKeyPath: bundle.signingKeyPath,
        kid,
        gatewayId,
        sandboxId: "legacy-podman-sandbox",
        iat: 1_700_000_000,
        exp: 0,
      });
      env.OPENSHELL_PODMAN_SOCKET = path.join(stateDir, "new-podman.sock");

      prepareDockerDriverGatewayConfigEnv(env, stateDir, "/usr/bin/openshell-sandbox", {
        gatewayRuntime: prepareNativePodmanGatewayHostRuntime({
          environment: { ...process.env, ...env },
          platform: "linux",
          socketPath: env.OPENSHELL_PODMAN_SOCKET,
        }),
      });

      const rewritten = fs.readFileSync(configPath, "utf-8");
      expect(rewritten).toContain('compute_drivers = ["podman"]');
      expect(rewritten).toContain("[openshell.drivers.podman]");
      expect(rewritten).not.toContain("sandbox_namespace");
      expect(parseTomlString(rewritten, "gateway_id")).toBe(gatewayId);
      expect(parseTomlString(rewritten, "socket_path")).toBe(
        path.join(stateDir, "new-podman.sock"),
      );
      expect(env[NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE_ENV]).toBeUndefined();
      expect(fs.readFileSync(bundle.signingKeyPath, "utf-8")).toBe(signingKeyBefore);
      expect(
        validateOpenShellStyleSandboxJwt({
          token,
          publicKeyPath: bundle.publicKeyPath,
          kid,
          gatewayId: parseTomlString(rewritten, "gateway_id"),
          now: 1_700_000_100,
          expectedSandboxId: "legacy-podman-sandbox",
        }),
      ).not.toBeNull();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("existing gateway config authority", () => {
  it("retains immutable Docker config identity without invoking state writers or runtime discovery", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-existing-gateway-"));
    const runtime = observedDockerGatewayRuntime();
    const env = writeGatewayConfig(stateDir);
    const before = fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG);
    const identity = fs.statSync(env.OPENSHELL_GATEWAY_CONFIG);
    const writers = (
      ["writeFileSync", "renameSync", "chmodSync", "mkdirSync", "rmSync"] as const
    ).map((method) =>
      vi.spyOn(fs, method).mockImplementation(() => {
        throw new Error("read-only authority attempted a write");
      }),
    );
    const inspect = vi.spyOn(runtime.network, "inspect");
    const run = vi.spyOn(runtime.network, "run");
    vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "podman");
    try {
      const authority = openExistingGatewayConfigAuthority(stateDir, runtime);
      try {
        expect(authority).toMatchObject({
          driver: "docker",
          sandboxNamespace: gatewayIdForStateDir(stateDir),
          socketPath: null,
          configPath: env.OPENSHELL_GATEWAY_CONFIG,
          configSha256: createHash("sha256").update(before).digest("hex"),
          gatewayId: gatewayIdForStateDir(stateDir),
        });
        expect(Object.isFrozen(authority)).toBe(true);
        expect(Reflect.set(authority, "driver", "podman")).toBe(false);
        expect(() => authority.assertCurrent()).not.toThrow();
        expect(fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG)).toEqual(before);
        expect(fs.statSync(env.OPENSHELL_GATEWAY_CONFIG).ino).toBe(identity.ino);
        expect(inspect).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        expect(writers.map((writer) => writer.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
      } finally {
        authority.close();
      }
      expect(() => authority.close()).not.toThrow();
      expect(() => authority.assertCurrent()).toThrow(/authority is closed/);
    } finally {
      vi.unstubAllEnvs();
      inspect.mockRestore();
      run.mockRestore();
      writers.forEach((writer) => writer.mockRestore());
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("projects only the validated Podman socket and preserves its omitted namespace", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-existing-podman-"));
    try {
      const env = {
        ...baseGatewayEnv(stateDir),
        OPENSHELL_PODMAN_SOCKET: path.join(stateDir, "podman.sock"),
      };
      const runtime = podmanGatewayRuntime(env);
      prepareDockerDriverGatewayConfigEnv(env, stateDir, null, { gatewayRuntime: runtime });
      const authority = openExistingGatewayConfigAuthority(stateDir, runtime);
      try {
        expect(authority).toMatchObject({
          driver: "podman",
          sandboxNamespace: null,
          socketPath: env.OPENSHELL_PODMAN_SOCKET,
        });
        expect(() => authority.assertCurrent()).not.toThrow();
      } finally {
        authority.close();
      }
      expect(() => {
        const mismatched = openExistingGatewayConfigAuthority(stateDir, {
          ...runtime,
          socketPath: path.join(stateDir, "another-podman.sock"),
        });
        mismatched.close();
      }).toThrow(/socket/);
      expect(() =>
        openExistingGatewayConfigAuthority(stateDir, observedDockerGatewayRuntime()),
      ).toThrow();
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("refuses missing and legacy configuration without creating or replacing state", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-existing-missing-"));
    try {
      const runtime = observedDockerGatewayRuntime();
      expect(() =>
        openExistingGatewayConfigAuthority(path.join(stateDir, "absent"), runtime),
      ).toThrow(/unavailable/);
      expect(fs.readdirSync(stateDir)).toEqual([]);
      expect(() => openExistingGatewayConfigAuthority(stateDir, runtime)).toThrow(/unavailable/);
      expect(fs.readdirSync(stateDir)).toEqual([]);
      const { configPath } = writePreScopedGatewayConfig(stateDir);
      const before = fs.readFileSync(configPath);
      expect(() => openExistingGatewayConfigAuthority(stateDir, runtime)).toThrow(
        /Legacy gateway config/,
      );
      expect(fs.readFileSync(configPath)).toEqual(before);
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it("rejects another owner's state and an unqualified driver", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-existing-owner-"));
    const env = writeGatewayConfig(stateDir);
    const runtime = observedDockerGatewayRuntime();
    const before = fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG);
    try {
      const owner = vi.spyOn(process, "getuid").mockReturnValue(fs.statSync(stateDir).uid + 1);
      try {
        expect(() => openExistingGatewayConfigAuthority(stateDir, runtime)).toThrow(
          /owner-controlled/,
        );
      } finally {
        owner.mockRestore();
      }
      expect(() =>
        openExistingGatewayConfigAuthority(stateDir, {
          ...runtime,
          openShellDriver: "unqualified",
        }),
      ).toThrow(/explicitly observed/);
      expect(fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG)).toEqual(before);
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it.each(["vm", "Docker", ""])(
    "rejects normalized driver alias %j even in generated TOML",
    (driver) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-existing-alias-"));
      try {
        const env = writeGatewayConfig(stateDir);
        const runtime = { ...observedDockerGatewayRuntime(), openShellDriver: driver };
        const toml = buildDockerDriverGatewayConfigToml(
          env,
          "/usr/bin/openshell-sandbox",
          jwtBundlePaths(stateDir),
          gatewayIdForStateDir(stateDir),
          runtime,
        );
        fs.writeFileSync(env.OPENSHELL_GATEWAY_CONFIG, toml);
        expect(() => {
          const authority = openExistingGatewayConfigAuthority(stateDir, runtime);
          authority.close();
        }).toThrow(/explicitly observed/);
        expect(fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf-8")).toBe(toml);
      } finally {
        fs.rmSync(stateDir, { force: true, recursive: true });
      }
    },
  );

  it("rejects state-directory replacement even when the original config inode is reused", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-existing-directory-"));
    const stateDir = path.join(root, "gateway");
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const env = writeGatewayConfig(stateDir);
    const authority = openExistingGatewayConfigAuthority(stateDir, observedDockerGatewayRuntime());
    try {
      fs.renameSync(stateDir, path.join(root, "prior"));
      fs.mkdirSync(stateDir, { mode: 0o700 });
      fs.renameSync(
        path.join(root, "prior", path.basename(env.OPENSHELL_GATEWAY_CONFIG)),
        env.OPENSHELL_GATEWAY_CONFIG,
      );
      expect(() => authority.assertCurrent()).toThrow(/state directory changed/);
    } finally {
      authority.close();
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it.each([
    [
      "spoofed namespace table",
      (text: string) =>
        text.replace(/^sandbox_namespace = .*\n/m, "") +
        '\n[spoof]\nsandbox_namespace = "default"\n',
    ],
    [
      "foreign namespace",
      (text: string) =>
        text.replace(/^sandbox_namespace = .*$/m, 'sandbox_namespace = "other-gateway"'),
    ],
    [
      "misplaced driver table",
      (text: string) => text.replace("[openshell.drivers.docker]", "[spoof.drivers.docker]"),
    ],
    ["duplicate driver table", (text: string) => text + "\n[openshell.drivers.docker]\n"],
    [
      "unauthenticated config",
      (text: string) =>
        text.replace("allow_unauthenticated_users = false", "allow_unauthenticated_users = true"),
    ],
    [
      "Docker socket override",
      (text: string) =>
        text.replace(
          "[openshell.drivers.docker]",
          '[openshell.drivers.docker]\nsocket_path = "/tmp/unowned.sock"',
        ),
    ],
  ] as const)("rejects %s without rewriting the config", (_label, change) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-existing-invalid-"));
    try {
      const env = writeGatewayConfig(stateDir);
      const invalid = change(fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf-8"));
      fs.writeFileSync(env.OPENSHELL_GATEWAY_CONFIG, invalid);
      expect(() =>
        openExistingGatewayConfigAuthority(stateDir, observedDockerGatewayRuntime()),
      ).toThrow();
      expect(fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf-8")).toBe(invalid);
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it.each([
    [
      "symlink",
      (file: string) => {
        fs.renameSync(file, `${file}.saved`);
        fs.symlinkSync(`${file}.saved`, file);
      },
    ],
    ["hard link", (file: string) => fs.linkSync(file, `${file}.linked`)],
    ["public config", (file: string) => fs.chmodSync(file, 0o644)],
    ["public state directory", (file: string) => fs.chmodSync(path.dirname(file), 0o755)],
  ] as const)("rejects an unsafe %s", (_label, change) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-existing-unsafe-"));
    try {
      const env = writeGatewayConfig(stateDir);
      change(env.OPENSHELL_GATEWAY_CONFIG);
      expect(() =>
        openExistingGatewayConfigAuthority(stateDir, observedDockerGatewayRuntime()),
      ).toThrow();
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });

  it.each([
    ["same-inode byte edit", (file: string) => fs.appendFileSync(file, "\n# changed\n")],
    [
      "same-byte inode replacement",
      (file: string) => {
        fs.copyFileSync(file, `${file}.replacement`);
        fs.renameSync(`${file}.replacement`, file);
      },
    ],
    ["new hard link", (file: string) => fs.linkSync(file, `${file}.linked`)],
    ["config permissions", (file: string) => fs.chmodSync(file, 0o400)],
    ["state-directory permissions", (file: string) => fs.chmodSync(path.dirname(file), 0o750)],
  ] as const)("rejects %s after opening authority", (_label, change) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-existing-drift-"));
    try {
      const env = writeGatewayConfig(stateDir);
      const authority = openExistingGatewayConfigAuthority(
        stateDir,
        observedDockerGatewayRuntime(),
      );
      try {
        change(env.OPENSHELL_GATEWAY_CONFIG);
        expect(() => authority.assertCurrent()).toThrow(/changed/);
      } finally {
        authority.close();
      }
    } finally {
      fs.rmSync(stateDir, { force: true, recursive: true });
    }
  });
});
