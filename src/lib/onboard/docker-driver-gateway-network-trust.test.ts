// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { parse } from "smol-toml";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  baseGatewayEnv,
  jwtBundlePaths,
} from "../../../test/support/openshell-gateway-config-helpers";
import { PEM, PRIVATE_KEY, tmpDir, writeCa } from "./__test-helpers__/corporate-ca-fixtures";
import { resolveCorporateCa } from "./corporate-ca";
import { prepareDockerDriverGatewayConfigEnv } from "./docker-driver-gateway-config";
import {
  assertDockerDriverGatewayAuthConfigSafe,
  buildDockerDriverGatewayEnv,
  buildDockerGatewayDebEnvFile,
  configureDockerDriverGatewayExternalComponent,
} from "./docker-driver-gateway-env";
import { hashDockerDriverGatewayEnv } from "./docker-driver-gateway-runtime-marker";
import { NEMOCLAW_GATEWAY_NETWORK_TRUST_SHA256_ENV } from "./gateway/network-trust";
import { prepareNativePodmanGatewayHostRuntime } from "./runtime-provider/podman-runtime-surfaces";

function resolved(pem = PEM) {
  return {
    pem,
    sourcePath: "/not-needed-after-validation/ca.pem",
    sourceEnv: "NEMOCLAW_CORPORATE_CA_BUNDLE",
  };
}

function trustPath(env: Record<string, string>): string {
  const parsed = parse(fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf8")) as unknown as {
    openshell: { supervisor: { network: { additional_ca_bundle: string } } };
  };
  return parsed.openshell.supervisor.network.additional_ca_bundle;
}

describe("Gateway private destination trust", () => {
  beforeEach(() => {
    for (const key of [
      "NEMOCLAW_CORPORATE_CA_BUNDLE",
      "REQUESTS_CA_BUNDLE",
      "CURL_CA_BUNDLE",
      "SSL_CERT_FILE",
      "NEMOCLAW_CORPORATE_CA_IMPORT",
    ]) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv("NEMOCLAW_CORPORATE_CA_ANCHOR_DIRS", "");
  });

  it.each(["docker", "podman"] as const)(
    "preserves %s destination trust and authentication on restart without the original source",
    (driver) => {
      const root = tmpDir();
      const env = baseGatewayEnv(root);
      const runtime =
        driver === "podman"
          ? prepareNativePodmanGatewayHostRuntime({
              environment: { OPENSHELL_DRIVERS: "podman" },
              platform: "linux",
              socketPath: path.join(root, "podman.sock"),
            })
          : undefined;
      prepareDockerDriverGatewayConfigEnv(env, root, null, {
        gatewayRuntime: runtime,
        corporateCa: resolved(),
      });
      const original = fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf8");
      const savedCa = trustPath(env);
      const jwt = Object.values(jwtBundlePaths(root)).map((file) => fs.readFileSync(file, "utf8"));
      const restarted = baseGatewayEnv(root);
      prepareDockerDriverGatewayConfigEnv(restarted, root, null, { gatewayRuntime: runtime });
      expect(fs.readFileSync(restarted.OPENSHELL_GATEWAY_CONFIG, "utf8")).toBe(original);
      expect(trustPath(restarted)).toBe(savedCa);
      expect(hashDockerDriverGatewayEnv(restarted)).toBe(hashDockerDriverGatewayEnv(env));
      expect(
        Object.values(jwtBundlePaths(root)).map((file) => fs.readFileSync(file, "utf8")),
      ).toEqual(jwt);
      const parsed = parse(original) as unknown as {
        openshell: { gateway: Record<string, unknown> };
      };
      expect(parsed.openshell.gateway).toMatchObject({
        guest_tls_ca: path.join(root, "tls", "ca.crt"),
        tls: { client_ca_path: path.join(root, "tls", "ca.crt") },
        mtls_auth: { enabled: true },
        auth: { allow_unauthenticated_users: false },
      });
      expect(() =>
        assertDockerDriverGatewayAuthConfigSafe(restarted, {}, "linux", runtime),
      ).not.toThrow();
    },
  );

  it("changes the runtime identity for rotation and removal while retaining old snapshots and JWT keys", () => {
    const root = tmpDir();
    const env = baseGatewayEnv(root);
    prepareDockerDriverGatewayConfigEnv(env, root, null, { corporateCa: resolved() });
    const first = { ...env };
    const oldPath = trustPath(env);
    const jwt = fs.readFileSync(jwtBundlePaths(root).signingKeyPath, "utf8");
    prepareDockerDriverGatewayConfigEnv(env, root, null, { corporateCa: resolved(PEM + PEM) });
    const rotated = { ...env };
    expect(hashDockerDriverGatewayEnv(rotated)).not.toBe(hashDockerDriverGatewayEnv(first));
    expect(trustPath(env)).not.toBe(oldPath);
    prepareDockerDriverGatewayConfigEnv(env, root, null, { corporateCa: null });
    expect(hashDockerDriverGatewayEnv(env)).not.toBe(hashDockerDriverGatewayEnv(rotated));
    expect(env[NEMOCLAW_GATEWAY_NETWORK_TRUST_SHA256_ENV]).toBe("none");
    expect(fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf8")).not.toContain(
      "additional_ca_bundle",
    );
    expect(fs.readFileSync(oldPath, "utf8")).toBe(PEM);
    expect(fs.readFileSync(jwtBundlePaths(root).signingKeyPath, "utf8")).toBe(jwt);
    expect(() => prepareDockerDriverGatewayConfigEnv(first, root)).toThrow(
      /network trust configuration changed/,
    );
  });

  it("keeps the old config and identity after invalid CA material or snapshot tampering", () => {
    const root = tmpDir();
    const env = baseGatewayEnv(root);
    prepareDockerDriverGatewayConfigEnv(env, root, null, { corporateCa: resolved() });
    const original = fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf8");
    const jwt = fs.readFileSync(jwtBundlePaths(root).signingKeyPath, "utf8");
    expect(() =>
      prepareDockerDriverGatewayConfigEnv(env, root, null, {
        corporateCa: resolved(PEM + PRIVATE_KEY),
      }),
    ).toThrow(/only normalized PEM/);
    const saved = trustPath(env);
    fs.chmodSync(saved, 0o644);
    expect(() => prepareDockerDriverGatewayConfigEnv(env, root)).toThrow(
      /read-only certificate snapshot/,
    );
    expect(fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf8")).toBe(original);
    expect(fs.readFileSync(jwtBundlePaths(root).signingKeyPath, "utf8")).toBe(jwt);
  });

  it("preserves a retained legacy gateway issuer and namespace when adding destination trust", () => {
    const root = tmpDir();
    const env = baseGatewayEnv(root);
    prepareDockerDriverGatewayConfigEnv(env, root);
    const legacyId = `nemoclaw-${path.basename(root)}`;
    const config = fs
      .readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf8")
      .replace(/^gateway_id = .*$/mu, `gateway_id = "${legacyId}"`)
      .replace(/^sandbox_label = .*$/mu, 'sandbox_label = "default"');
    fs.writeFileSync(env.OPENSHELL_GATEWAY_CONFIG, config);
    const jwt = fs.readFileSync(jwtBundlePaths(root).signingKeyPath, "utf8");
    prepareDockerDriverGatewayConfigEnv(env, root, null, { corporateCa: resolved() });
    const next = fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf8");
    expect(next).toContain(`gateway_id = "${legacyId}"`);
    expect(next).toContain('sandbox_label = "default"');
    expect(next).toContain("additional_ca_bundle");
    expect(fs.readFileSync(jwtBundlePaths(root).signingKeyPath, "utf8")).toBe(jwt);
  });

  it("uses validated source certificates, preserves them during component changes, and honors explicit import removal", () => {
    const root = tmpDir();
    const source = writeCa(tmpDir(), PEM + PRIVATE_KEY);
    vi.stubEnv("NEMOCLAW_CORPORATE_CA_BUNDLE", source);
    const build = () =>
      buildDockerDriverGatewayEnv({
        stateDir: root,
        platform: "linux",
        getDockerSupervisorImage: () => "supervisor:test",
        resolveSandboxBin: () => null,
      });
    const env = build();
    const saved = trustPath(env);
    expect(fs.readFileSync(saved, "utf8")).toBe(resolveCorporateCa()!.pem);
    expect(fs.readFileSync(saved, "utf8")).not.toContain("PRIVATE");
    configureDockerDriverGatewayExternalComponent(env, {
      componentId: "policy-governance",
      interceptorSocketPath: "/run/user/1000/component/interceptor.sock",
    });
    expect(trustPath(env)).toBe(saved);
    const serviceEnv = buildDockerGatewayDebEnvFile(
      "NEMOCLAW_GATEWAY_NETWORK_TRUST_SHA256=stale\n",
      env,
    );
    expect(serviceEnv).toContain(
      `${NEMOCLAW_GATEWAY_NETWORK_TRUST_SHA256_ENV}=${env[NEMOCLAW_GATEWAY_NETWORK_TRUST_SHA256_ENV]}\n`,
    );
    expect(serviceEnv).not.toContain("stale");
    fs.unlinkSync(source);
    vi.stubEnv("NEMOCLAW_CORPORATE_CA_BUNDLE", undefined);
    expect(trustPath(build())).toBe(saved);
    vi.stubEnv("NEMOCLAW_CORPORATE_CA_IMPORT", "false");
    const removed = build();
    expect(removed[NEMOCLAW_GATEWAY_NETWORK_TRUST_SHA256_ENV]).toBe("none");
    expect(fs.readFileSync(saved, "utf8")).toBe(PEM);
  });
});
