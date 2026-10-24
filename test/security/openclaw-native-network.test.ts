// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { runDockerfilePatchBlock } from "../helpers/fetch-guard-patch-harness";
import {
  patchNativeNetworkText,
  patchOpenClawNativeNetwork,
} from "../../scripts/lib/patch-openclaw-native-network.mts";

// Exercise the reviewed loop against special-use DNS answers.
// The complete pinned classifier is checked by the package probe.
const DNS_BOUNDARY = [
  "function assertAllowedResolvedAddressesOrThrow(results, policy) {",
  "\tfor (const entry of results) if (isBlockedHostnameOrIp(entry.address, policy)) throw new SsrFBlockedError(BLOCKED_RESOLVED_IP_MESSAGE);",
  "}",
].join("\n");

function checkSpecialUseAnswers(addresses: string[], insideOpenShell: boolean): void {
  const source = patchNativeNetworkText(DNS_BOUNDARY, "dns").replace(
    'import { isIP as nemoclawIsIP } from "node:net";',
    "",
  );
  vm.runInNewContext(`${source}\nassertAllowedResolvedAddressesOrThrow(results, {});`, {
    nemoclawIsIP: isIP,
    process: { env: { OPENSHELL_SANDBOX: insideOpenShell ? "1" : undefined } },
    // All supplied fixtures are special-use addresses. Upstream's real IP
    // classifier is exercised separately against the integrity-pinned package.
    isBlockedHostnameOrIp: () => true,
    SsrFBlockedError: Error,
    BLOCKED_RESOLVED_IP_MESSAGE: "blocked DNS answer",
    results: addresses.map((address) => ({ address })),
  });
}

describe("OpenClaw native DNS boundary", () => {
  it.each([
    "198.18.0.2",
    "198.19.255.255",
    "fd23:6f70:656e::2",
    "FD23:6F70:656E:0000:0000:0000:0000:0002",
  ])("accepts mapped DNS answer %s only inside OpenShell", (address) => {
    expect(() => checkSpecialUseAnswers([address], true)).not.toThrow();
    expect(() => checkSpecialUseAnswers([address], false)).toThrow("blocked DNS answer");
  });

  it.each([
    "198.18.0.1", // OpenShell's sandbox-local API is not an external DNS mapping.
    "198.17.255.255",
    "198.20.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "fd23:6f70:656f::2",
    "fd00::2",
    "::1",
    "::ffff:198.18.0.2",
    "fd23:6f70:656e::2%eth0",
    "198.18.0.256",
  ])("retains rejection of unmapped or malformed DNS answer %s", (address) => {
    expect(() => checkSpecialUseAnswers([address], true)).toThrow("blocked DNS answer");
  });

  it("rejects mixed mapped and private DNS answers", () => {
    expect(() => checkSpecialUseAnswers(["198.18.0.2", "10.0.0.1"], true)).toThrow(
      "blocked DNS answer",
    );
  });

  it.each(["", `${DNS_BOUNDARY}\n${DNS_BOUNDARY}`])(
    "refuses missing or duplicated DNS boundaries",
    (source) => {
      expect(() => patchNativeNetworkText(source, "dns")).toThrow("expected one reviewed target");
    },
  );
});

const WEB_BOUNDARY = [
  "function run(resolved, useEnvProxy) {",
  "return fetchWithSsrFGuard(useEnvProxy ? withTrustedEnvProxyGuardedFetchMode(resolved) : withStrictGuardedFetchMode(resolved));",
  "}",
  "run(input, false);",
].join("\n");

describe("OpenClaw host-gateway fetch policy", () => {
  it.each([
    [true, "host.openshell.internal", ["existing.example", "host.openshell.internal"]],
    [false, "host.openshell.internal", ["existing.example"]],
    [true, "other.internal", ["existing.example"]],
  ])("keeps caller restrictions with sandbox=%s and host=%s", (inside, hostname, allowed) => {
    const result = vm.runInNewContext(patchNativeNetworkText(WEB_BOUNDARY, "web-fetch"), {
      URL,
      process: { env: { OPENSHELL_SANDBOX: inside ? "1" : undefined } },
      input: {
        url: `https://${hostname}/`,
        policy: {
          allowedHostnames: ["existing.example"],
          hostnameAllowlist: ["permitted.example"],
          blockedHostnames: ["blocked.example"],
        },
      },
      fetchWithSsrFGuard: (params: unknown) => params,
      withTrustedEnvProxyGuardedFetchMode: () => {
        throw new Error("unexpected proxy path");
      },
      withStrictGuardedFetchMode: (params: object) => ({ ...params, mode: "strict" }),
    });
    expect(result).toEqual({
      url: `https://${hostname}/`,
      mode: "strict",
      policy: {
        allowedHostnames: allowed,
        hostnameAllowlist: ["permitted.example"],
        blockedHostnames: ["blocked.example"],
      },
    });
  });
});

it("rejects an unreviewed module before modifying either target", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-native-network-"));
  try {
    const dist = path.join(directory, "dist");
    fs.mkdirSync(dist);
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.9.2" }),
    );
    const files = ["ssrf-0QyXWOVG.js", "web-guarded-fetch-DfTFSIPT.js"];
    fs.writeFileSync(path.join(dist, files[0]), "unreviewed source\n");
    fs.writeFileSync(path.join(dist, files[1]), "unreviewed source\n");
    expect(() => patchOpenClawNativeNetwork(dist)).toThrow("Unreviewed OpenClaw network module");
    expect(files.map((file) => fs.readFileSync(path.join(dist, file), "utf8"))).toEqual([
      "unreviewed source\n",
      "unreviewed source\n",
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("OpenClaw image network selection", () => {
  it("refuses a symbolic link module without changing its target", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-network-symlink-"));
    try {
      const dist = path.join(directory, "dist");
      fs.mkdirSync(dist);
      fs.writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.2" }),
      );
      const victim = path.join(directory, "outside-module.js");
      fs.writeFileSync(victim, "keep this file unchanged\n");
      fs.symlinkSync(victim, path.join(dist, "ssrf-0QyXWOVG.js"));
      expect(() => patchOpenClawNativeNetwork(dist)).toThrow();
      expect(fs.readFileSync(victim, "utf8")).toBe("keep this file unchanged\n");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "rejects modified current modules even with legacy fixture=%s",
    (legacyFixture) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-image-network-"));
      try {
        const dist = path.join(root, "dist");
        fs.mkdirSync(dist);
        fs.writeFileSync(
          path.join(root, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2026.9.2" }),
        );
        const modulePath = path.join(dist, "ssrf-0QyXWOVG.js");
        fs.writeFileSync(modulePath, "unreviewed input");
        const result = runDockerfilePatchBlock(
          dist,
          root,
          "# --- Patch 3: follow symlinks",
          "2026.9.2",
          legacyFixture,
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Unreviewed OpenClaw network module");
        expect(fs.readFileSync(modulePath, "utf8")).toBe("unreviewed input");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("refuses legacy network patches without the E2E fixture selector", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-image-network-"));
    try {
      const result = runDockerfilePatchBlock(
        root,
        root,
        "# --- Patch 3: follow symlinks",
        "2026.4.24",
        false,
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Native network patch requires the reviewed current version");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
