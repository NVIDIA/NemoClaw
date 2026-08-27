// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildDockerDriverGatewayConfigToml } from "../../src/lib/onboard/docker-driver-gateway-config.js";
import { PORTABLE_HOST_GATEWAY_IP } from "../../src/lib/onboard/experimental/portable-profile.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const review = fs.readFileSync(
  path.join(repoRoot, "internal", "security-reviews", "openshell-0.0.101-migration-review.md"),
  "utf8",
);

type CredentialManifest = {
  readonly openshellVersion: string;
  readonly openshellCommit: string;
  readonly sources: readonly string[];
  readonly nemoclawSources: readonly string[];
  readonly generation?: {
    readonly method: string;
    readonly upstreamSourceEvidence: readonly {
      readonly gitObjectId: string;
      readonly path: string;
      readonly sha256: string;
    }[];
    readonly nemoclawSourceEvidence: readonly {
      readonly path: string;
      readonly sha256: string;
    }[];
  };
  readonly rawChildValueKeys: readonly string[];
  readonly rewrittenChildValueKeys: readonly string[];
  readonly runtimeControlKeys: readonly string[];
  readonly runtimeControlPrefixes: readonly string[];
};

const manifest = JSON.parse(
  fs.readFileSync(
    path.join(
      repoRoot,
      "src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.101.json",
    ),
    "utf8",
  ),
) as CredentialManifest;
const previousManifest = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, "src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.99.json"),
    "utf8",
  ),
) as CredentialManifest;

const SOURCE_COMMIT = "8ddd98c3dff62619a3963f99ba1e055b67650e72";
const NEW_COMMITS = [
  "5548405fcbfeb97964bbe429fb5cc6b823bd16de",
  "f383ee1038f91921e104405cd01e4150d533fdbe",
  "284da54de5c7710482c553eb15a8aa020744e223",
  "c5f8366cd31860e5d6f00480d4fc01f8cc3b3c0f",
  "85d992f768bf2152fc5b815fc4031c61eae1ac52",
  "d2c44b0e5393e3746eae5783aa99ac31be08daae",
  "0c7e59a95355cabc15ccaddb86fcbe6a1d30eaaa",
  "d85339d621e0e96697499a9d4c8780ee9b9c1324",
  SOURCE_COMMIT,
] as const;

const RANGES = [
  ["v0.0.85 -> v0.0.86", 12, 109],
  ["v0.0.86 -> v0.0.87", 5, 12],
  ["v0.0.87 -> v0.0.88", 15, 169],
  ["v0.0.88 -> v0.0.89", 9, 49],
  ["v0.0.89 -> v0.0.90", 9, 24],
  ["v0.0.90 -> v0.0.91", 3, 33],
  ["v0.0.91 -> v0.0.92", 11, 55],
  ["v0.0.92 -> v0.0.93", 7, 24],
  ["v0.0.93 -> v0.0.94", 12, 68],
  ["v0.0.94 -> v0.0.95", 7, 107],
  ["v0.0.95 -> v0.0.96", 5, 38],
  ["v0.0.96 -> v0.0.97", 12, 144],
  ["v0.0.97 -> v0.0.98", 3, 50],
  ["v0.0.98 -> v0.0.99", 7, 79],
  ["v0.0.99 -> v0.0.100", 7, 158],
  ["v0.0.100 -> v0.0.101", 2, 13],
] as const;

const FULL_SELECTORS = [
  "openshell-00101-docker-clean-install",
  "openshell-00099-to-00101-docker-upgrade",
  "openshell-00085-to-00101-docker-upgrade",
  "openshell-00101-rootless-podman-controlled",
  "openshell-00101-rootless-podman-clean-install",
  "openshell-00099-to-00101-rootless-podman-upgrade",
  "openshell-00085-to-00101-rootless-podman-upgrade",
  "openshell-00101-keepalive",
  "openshell-00101-policy-credentials",
  "openshell-00101-credential-store-lifecycle",
  "openshell-00101-component-coherence",
  "openshell-00101-runtime-identity",
  "openshell-00101-upgrade-recovery",
  "openshell-00101-same-name-isolation",
] as const;

const FINAL_SELECTORS = [
  "openshell-00101-docker-clean-install",
  "openshell-00085-to-00101-docker-upgrade",
  "openshell-00101-rootless-podman-clean-install",
  "openshell-00085-to-00101-rootless-podman-upgrade",
  "openshell-00101-keepalive",
  "openshell-00101-policy-credentials",
  "openshell-00101-credential-store-lifecycle",
  "openshell-00101-component-coherence",
  "openshell-00101-runtime-identity",
  "openshell-00101-upgrade-recovery",
  "openshell-00101-same-name-isolation",
] as const;

const RELEASE_IDENTITIES = [
  "6ace3b8d657d3d65589d9ce61fe4672400f30955",
  "fc9b7ecee4e81048ab0f2c73c513cd606313797a",
  "f389c9d872775006ae069473f58250fa8f3ad40f",
  "9c90869d00b109b5ac1062b1a9808a592c2311d3c0c4926bae44d136b979d8a9",
  "dcb3f1917713bf2a8e8e1803ac42c5e39d9dd41e644136b05def32b077082777",
  "d16f7d369c54d74d36c7df036565267a960e7ce6fb143012fe9d77f257d6e8b3",
  "7d49ab2a5ff0b826bd2bdca5e0244010f832dfc6901c808ea8c8467004c26913",
  "b553d3bfc08e9354b990a10fb8abd976e039afeec2d3947f8a112018be40d296",
  "9daaccdb9e30e220d56dd6d6bf4bd00ccca8ae4ad2845f5f0d9b9da3eb8ee881",
  "eaeb094ccf7dcb1fe00c7e926e6aa9aaaefb89ecbef8343720628b0fd2d84654",
  "ac842ccc2ab8b5682f7479d71532cc650839250a8a41dbfae2b871cbbdfd3279",
  "0f9e195b7cde57f4c2080df95159c5e7e72b0248306abc242ae00a3bb6f07f14",
  "953b90eaa7d2fc1bb7bdf38eb0ada6fad7902b13f9f895ca20b89caeac483a9e",
  "c39b7ba3cf212b88712a00d2a0e3d28e2c1e0e9f47a9a6ca818a8f06ed2140aa",
  "a2704babbb468fd0a359bfdd9844de71095b730758541b4ca8cbab77d4018920",
  "88300e35f153123e4dc3021c537834dd6c0a09665a4a6d3974cd285d512345c4",
  "87fadc7b0c854aa44f71d5b3a206865070117cd27825d59c61da252a99f402a2",
  "sha256:b58be5e40c788977ffa0e8305a8cad9c656efdf1a3fe182582a00ca870bb0edb",
  "sha256:44aecbbbf4a4b46e88de3fea28476ca2abf043f543d1e9cb9089bcec1ee3aa74",
  "sha256:d30bb067e4769c743cdf020e736cf88f090dc2d66cc01cbaf18f0098cfb90da1",
] as const;

function sha256File(relativePath: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(path.join(repoRoot, relativePath)))
    .digest("hex");
}

function parseRangeTable(): Map<string, readonly [number, number]> {
  const result = new Map<string, readonly [number, number]>();
  for (const match of review.matchAll(/^\| `(v0\.0\.\d+ -> v0\.0\.\d+)` \| (\d+) \| (\d+) \|/gmu)) {
    result.set(match[1], [Number(match[2]), Number(match[3])]);
  }
  return result;
}

function parseNumberedSelectors(start: string, end: string): string[] {
  const section = review.split(start)[1]?.split(end)[0] ?? "";
  return [...section.matchAll(/^\d+\. `(openshell-[^`]+)`$/gmu)].map((match) => match[1]);
}

function parseTableIds(pattern: RegExp): string[] {
  return [...review.matchAll(pattern)].map((match) => match[1]);
}

describe("OpenShell 0.0.101 migration review", () => {
  it.each(RELEASE_IDENTITIES)(
    "binds the complete source and artifact review to exact v0.0.101 identities [case %#] (#8599)",
    (identity) => {
      const commitRows = parseTableIds(/^\| `([0-9a-f]{40})` \|/gmu);
      expect(commitRows).toEqual(NEW_COMMITS);
      expect(new Set(commitRows).size).toBe(9);
      expect(review).toContain("9 commits and 170 changed paths");
      expect(review).toContain("126 commits, 628 distinct");
      expect(review).toMatch(/all 20\s+checksum-manifest entries were/u);
      expect(review).toContain("all 11 archives passed path-safety inspection");
      expect(review).toContain("This was a high-severity");
      expect(review).toContain("canonical GitHub release URL, and SHA-256 tuple");
      expect(review).toContain("second candidate-controlled identity binding");
      expect(review).toContain("selected release's complete trusted set");
      expect(review).toContain("Both findings are closed with no new blocker");
      expect(review).toContain("this prerequisite is satisfied");
      expect(review).toContain("parent epic `#8590`");
      expect(review).toContain(identity);

      const ranges = parseRangeTable();
      expect([...ranges]).toEqual(RANGES.map(([name, commits, paths]) => [name, [commits, paths]]));
      expect([...ranges.values()].reduce((sum, [commits]) => sum + commits, 0)).toBe(126);
    },
  );

  it.each([{ scenario: "Docker" }, { scenario: "Podman" }])(
    "selects only Docker or Podman without configuring new v0.0.101 surfaces [$scenario] (#8599)",
    ({ scenario }) => {
      const untrustedNewSurfaceInputs = {
        OPENSHELL_CREDENTIAL_DRIVERS: "vault",
        OPENSHELL_CREDENTIAL_STORAGE: "/untrusted/store",
        OPENSHELL_DEFAULT_CREDENTIAL_DRIVER: "vault",
        OPENSHELL_EGRESS_ADAPTER: "unreviewed",
        OPENSHELL_VM_RUNTIME: "unreviewed",
      };
      const dockerToml = buildDockerDriverGatewayConfigToml({
        ...untrustedNewSurfaceInputs,
        OPENSHELL_DRIVERS: "vm",
        OPENSHELL_GRPC_ENDPOINT: "https://127.0.0.1:8080",
        OPENSHELL_DOCKER_NETWORK_NAME: "openshell-docker",
        OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor:test",
      });
      const podmanToml = buildDockerDriverGatewayConfigToml({
        ...untrustedNewSurfaceInputs,
        OPENSHELL_DRIVERS: "podman",
        OPENSHELL_GRPC_ENDPOINT: `https://${PORTABLE_HOST_GATEWAY_IP}:8080`,
        OPENSHELL_DOCKER_NETWORK_NAME: "openshell-podman",
        OPENSHELL_DOCKER_SUPERVISOR_IMAGE: "supervisor:test",
        OPENSHELL_PODMAN_SOCKET: "/run/user/1001/podman/podman.sock",
      });

      expect(dockerToml).toContain('compute_drivers = ["docker"]');
      expect(dockerToml).toContain("[openshell.drivers.docker]");
      expect(podmanToml).toContain('compute_drivers = ["podman"]');
      expect(podmanToml).toContain("[openshell.drivers.podman]");
      expect(podmanToml).toContain('socket_path = "/run/user/1001/podman/podman.sock"');
      const toml = ({ Docker: dockerToml, Podman: podmanToml } as const)[scenario]!;
      expect(toml).not.toMatch(/credential_(?:drivers|storage)|default_credential_driver/iu);
      expect(toml).not.toContain("[openshell.drivers.vm]");
      expect(toml).not.toMatch(/egress_adapter|sdk\/go/iu);
    },
  );

  it("retains every inherited invariant and assigns each correction once (#8599)", () => {
    expect(parseTableIds(/^\| `(OS101-I\d{2})` \|/gmu)).toEqual(
      Array.from({ length: 16 }, (_, index) => `OS101-I${String(index + 1).padStart(2, "0")}`),
    );
    expect(parseTableIds(/^\| `(OS99-\d{2})` \|/gmu)).toEqual(
      Array.from({ length: 23 }, (_, index) => `OS99-${String(index + 1).padStart(2, "0")}`),
    );

    const corrections = [...review.matchAll(/^\| `(OS101-C\d{2})` \|.*\| `(#\d+)` \|$/gmu)].map(
      ([, id, owner]) => [id, owner],
    );
    expect(corrections).toEqual([
      ["OS101-C01", "#8601"],
      ["OS101-C02", "#8602"],
      ["OS101-C03", "#8603"],
      ["OS101-C04", "#8604"],
      ["OS101-C05", "#8605"],
    ]);
    expect(new Set(corrections.map(([, owner]) => owner)).size).toBe(5);
    expect(review).toMatch(/default encrypted database\s+credential store is active/u);
    expect(review).toContain("No external Kubernetes, Vault, or UDS credential driver");
    expect(review).not.toContain("No new credential driver");
    expect(review).toMatch(/does not perform an automatic\s+wholesale at-rest migration/u);
    expect(review).toContain("known crash window after");
  });

  it("freezes the accepted qualification selector and final-acceptance sets (#8599)", () => {
    expect(
      parseNumberedSelectors(
        "The full accepted selector set is exactly:",
        "The exact final acceptance subset contains 11 selectors:",
      ),
    ).toEqual(FULL_SELECTORS);
    expect(
      parseNumberedSelectors(
        "The exact final acceptance subset contains 11 selectors:",
        "The two v0.0.99 upgrade selectors",
      ),
    ).toEqual(FINAL_SELECTORS);
    expect(review).toContain("ci/openshell-0.0.101-qualification-v1.json");
    expect(review).toContain(".github/workflows/openshell-0.0.101-qualification.yaml");
    expect(review).toContain(".github/workflows/e2e.yaml");
    expect(review).toContain(".github/workflows/podman-cpu-proof.yaml");
    expect(review).toContain("`Rootless Podman CPU lifecycle with Docker disabled`");
    expect(review).toContain("`podman-cpu-lifecycle` is navigation only");
    expect(review).toContain("`aggregation: all`");
  });
});
