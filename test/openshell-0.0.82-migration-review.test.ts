// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const review = fs.readFileSync(
  path.join(repoRoot, "docs", "security", "openshell-0.0.82-migration-review.md"),
  "utf8",
);

const adjacentRanges = [
  { from: "v0.0.72", to: "v0.0.73", commits: 5, paths: 27 },
  { from: "v0.0.73", to: "v0.0.74", commits: 6, paths: 25 },
  { from: "v0.0.74", to: "v0.0.75", commits: 2, paths: 26 },
  { from: "v0.0.75", to: "v0.0.76", commits: 3, paths: 28 },
  { from: "v0.0.76", to: "v0.0.77", commits: 3, paths: 7 },
  { from: "v0.0.77", to: "v0.0.78", commits: 6, paths: 23 },
  { from: "v0.0.78", to: "v0.0.79", commits: 1, paths: 1 },
  { from: "v0.0.79", to: "v0.0.80", commits: 5, paths: 15 },
  { from: "v0.0.80", to: "v0.0.81", commits: 4, paths: 9 },
  { from: "v0.0.81", to: "bb72d012", commits: 11, paths: 75 },
] as const;

const auditedCommits = [
  "afc06dd2",
  "a5161d0b",
  "a2268060",
  "f27ff150",
  "474d2d4a",
  "ed0026aa",
  "0a25fdf5",
  "5477e2f2",
  "914da339",
  "450685c7",
  "45614a3f",
  "abcd15d1",
  "45060f44",
  "43bb0302",
  "5f9bf9ce",
  "6461677c",
  "f852d07b",
  "6252aa17",
  "31807d68",
  "5656240c",
  "290297ff",
  "9c14de7b",
  "eba5dd75",
  "abe42fb5",
  "a7271169",
  "f7aa3aa3",
  "2e2b497f",
  "ed8ce820",
  "5207f118",
  "ff9af8e3",
  "709aa0fe",
  "83131d7e",
  "88710225",
  "49701088",
  "420a855d",
  "5f38b7c4",
  "ccdac9ce",
  "caaa5165",
  "8c0ecac8",
  "233d207e",
  "10702133",
  "bebf440b",
  "8eacb477",
  "614c8c16",
  "40194f93",
  "bb72d012",
] as const;

describe("OpenShell 0.0.82 migration review", () => {
  it("records every adjacent release range and all 46 audited commits", () => {
    expect(adjacentRanges.reduce((total, range) => total + range.commits, 0)).toBe(46);
    for (const range of adjacentRanges) {
      expect(review).toContain(
        `| \`${range.from} -> ${range.to}\` | ${range.commits} | ${range.paths} |`,
      );
    }
    for (const commit of auditedCommits) {
      expect(review, `missing audited OpenShell commit ${commit}`).toContain(commit);
    }
    expect(review).toContain("174 distinct changed paths");
  });

  it("keeps source ancestry, release publication, and artifact provenance as separate gates", () => {
    expect(review).toContain("This is a candidate migration review, not approval to ship");
    expect(review).toContain("v0.0.81` is a source tag");
    expect(review).toContain("it has no GitHub release");
    expect(review).toContain("failed the Ubuntu 26.04 rootless-Podman E2E job");
    expect(review).toContain("no verifiable source-to-image attestation");
    expect(review).toContain("reject archive traversal, links, devices, duplicates");
  });

  it("records exact development identities without treating them as a stable release", () => {
    expect(review).toContain("0.0.82-dev.11+gbb72d012");
    expect(review).toContain("0.0.82-dev.11+gbb72d0123");
    expect(review).toContain("0.0.82.dev11+gbb72d0123");
    expect(review).toContain("8266446648");
    expect(review).toContain("8266452366");
    expect(review).toContain("8266435047");
    expect(review).toContain(
      "sha256:fc441051102b1a16ffcabf59878fa464d3c548f29bfbfa6e4acb232ab67198b7",
    );
    expect(review).toContain("8266448422");
    expect(review).toContain("8266451406");
    expect(review).toContain("attestationStatus: absent");
    expect(review).toContain("final stable release must be audited anew");
  });

  it("tracks every material migration concern and refuses false-green evidence", () => {
    for (let number = 1; number <= 17; number += 1) {
      const id = `OS82-${String(number).padStart(2, "0")}`;
      expect(review.split(`| \`${id}\` |`), `${id} concern row`).toHaveLength(2);
    }
    expect(review).toContain("An unresolved critical or high concern blocks");
    expect(review).toContain("full managed MCP lifecycle");
    expect(review).toContain("without a conditional skip or expected failure");
    expect(review).toContain("executes its checker and parser from the PR base SHA");
    expect(review).toContain(
      "using the head checker would let reviewed code define its own trust rules",
    );
    expect(review).toMatch(/sequence of nine\s+distinct rotation updates/u);
    expect(review).toContain("expired_retained_generation_does_not_resolve");
    expect(review).toContain("--credential-expires-at");
    expect(review).toMatch(/removes that key while\s+the provider remains attached/u);
  });

  it("keeps exact-main runtime proofs separate from upstream-only fault injection", () => {
    expect(review).toContain("This boundary deliberately does not fake fault injection");
    expect(review).toContain("fails only `report_policy_status`");
    expect(review).toMatch(/no downstream control\s+between individual required nft commands/u);
    expect(review).toContain("policy-accept output chain");
    expect(review).toContain("exactly one IPv4/IPv6 TCP/UDP port-unreachable reject each");
    expect(review).toMatch(/old process to remain\s+allowed before and after replacement/u);
    expect(review).toMatch(/new altered process at the\s+same path receives HTTP 403/u);
    expect(review).toMatch(/Argument and result\s+canaries/u);
    expect(review).toMatch(/No OpenShell repository mutation is part of this\s+NemoClaw work/u);

    const helper = fs.readFileSync(
      path.join(repoRoot, "test", "e2e", "live", "openshell-exact-main-runtime-contracts.ts"),
      "utf8",
    );
    expect(helper).toContain('chain.policy !== "accept"');
    expect(helper).toContain("expected exactly one ${family} ${protocol} reject rule");
    expect(helper).toContain("DIRECT_BYPASS_PROBE_CODE");
    expect(helper).toContain('sha256sum \\"/proc/$old_pid/exe\\"');
    expect(helper).toContain('[ "$new_status" = 403 ]');
    expect(helper).toContain("line.includes(`tools=${options.expectedTool}`)");
    expect(helper).toContain("not.toMatch(/\\barguments\\b[\"']?\\s*[:=]/iu)");
    expect(helper).not.toContain("iptables -F");
    expect(helper).not.toContain("nft flush ruleset");

    const mcpBridge = fs.readFileSync(
      path.join(repoRoot, "test", "e2e", "live", "mcp-bridge.test.ts"),
      "utf8",
    );
    expect(mcpBridge).toContain("assertExactMainPolicyNftAndIdentityContracts({");
    expect(mcpBridge).toContain("assertExactMainMcpLogPrivacy({");
    expect(review).toContain("capctl 0.2.4");
    expect(review).toContain("4a6e71767585f51c2a33fed6d67147ec0343725fc3c03bf4b89fe67fede56aa5");
    expect(review).toContain("THIRD-PARTY-NOTICES");
    expect(review).toContain("Alpine `3.22.5`");
    expect(review).toContain("29 installed APK records");
    expect(review).toContain("executes only the extracted binary");
    expect(review).toContain("cache identity omits resolved `sandbox_uid`");
  });

  it("keeps the stable pin and physical Spark proof blocked until final evidence exists", () => {
    const blueprint = fs.readFileSync(
      path.join(repoRoot, "nemoclaw-blueprint", "blueprint.yaml"),
      "utf8",
    );
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(
          repoRoot,
          "src",
          "lib",
          "actions",
          "sandbox",
          "openshell-child-visible-credentials.v0.0.72.json",
        ),
        "utf8",
      ),
    ) as { openshellVersion: string };

    expect(blueprint).toContain('min_openshell_version: "0.0.72"');
    expect(blueprint).toContain('max_openshell_version: "0.0.72"');
    expect(manifest.openshellVersion).toBe("0.0.72");
    expect(review).toContain("remains pinned to `0.0.72`");
    expect(review).toContain("physical Docker 27 DGX Spark");
    expect(review).toContain("loopback first-byte test");
    expect(review).not.toContain("did not add a true connection-level test");
    expect(review).toContain("Inclusion of `40194f93` alone cannot close");
  });

  it("does not reintroduce newline-only code transports at migrated consumers", () => {
    expect(review).toContain("The newline migration was audited beyond the public `exec` guard");
    expect(review).toContain("32 KiB per-argument ceiling");
    expect(review).toContain("owned secret-boundary exception");

    const migratedConsumers = [
      ["test/e2e/live/brave-search-helpers.ts", ["singleLineShell", "base64 -d"]],
      ["test/e2e/live/network-policy.test.ts", ["shellEvalArg", "nemoclaw-web-fetch-e2e.mjs"]],
      ["test/e2e/live/bedrock-runtime-compatible-anthropic.test.ts", ["base64 -d | sh"]],
      ["test/e2e/live/kimi-inference-compat-helpers.ts", ["base64 -d", 'toString("base64")']],
      ["test/e2e/live/rebuild-openclaw.test.ts", ["b64decode", 'toString("base64")']],
      [
        "test/e2e/live/messaging-compatible-endpoint.test.ts",
        ["nodeEvalArg", 'toString("base64")'],
      ],
      ["test/e2e/live/cron-preflight-inference-local.test.ts", ["probeShell", "base64 -d"]],
      ["test/e2e/live/openclaw-inference-switch.test.ts", ["singleLineSandboxShellScript"]],
      ["test/e2e/live/openclaw-skill-cli.test.ts", ["singleLineSandboxScript"]],
      ["test/e2e/live/phase6-messaging-helpers.ts", ["sandboxEncodedSh", "base64(script)"]],
      [
        "test/e2e/live/gateway-guard-recovery.test.ts",
        ["SUPERVISOR_TOPOLOGY_COMMAND", "b64decode"],
      ],
      [
        "test/e2e/live/openclaw-plugin-runtime-exdev.test.ts",
        ["data:text/javascript;base64", "nemoclaw-exdev-guard.sh"],
      ],
      [
        "test/e2e/live/mcp-bridge.test.ts",
        ["mcpCallScriptB64", "nemoclaw-mcp-provider-rewrite-proof.cjs"],
      ],
      [
        "src/lib/actions/sandbox/sessions/gateway-rpc.ts",
        ["GATEWAY_ADMIN_RPC_LOADER", "GATEWAY_ADMIN_RPC_SCRIPT_B64"],
      ],
      [
        "test/e2e/e2e-cloud-experimental/checks/03-deepagents-code-nemotron-ultra-profile.sh",
        ["encode_source", "base64 -d"],
      ],
      [
        "test/e2e/e2e-cloud-experimental/checks/04-deepagents-code-fresh-reonboard.sh",
        ["encode_source", "base64 -d"],
      ],
      ["test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh", ["base64 -d"]],
      ["test/e2e/e2e-cloud-experimental/checks/09-deepagents-code-tavily-opt-in.sh", ["base64 -d"]],
      [
        "test/e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh",
        ["b64decode", "base64 | tr -d"],
      ],
    ] as const;

    for (const [relativePath, forbidden] of migratedConsumers) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
      for (const obsoleteTransport of forbidden) {
        expect(source, `${relativePath} still contains ${obsoleteTransport}`).not.toContain(
          obsoleteTransport,
        );
      }
    }

    const phase6 = fs.readFileSync(
      path.join(repoRoot, "test/e2e/live/phase6-messaging-helpers.ts"),
      "utf8",
    );
    expect(phase6).toContain('["sh", "-c", script, "nemoclaw-e2e-script", ...args]');

    const pythonEgress = fs.readFileSync(
      path.join(
        repoRoot,
        "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
      ),
      "utf8",
    );
    expect(pythonEgress).toContain('"$python_bin" -c "$source" "$url"');
    expect(pythonEgress).toContain("NATIVE_MULTILINE_ARGV");
  });

  it("treats OpenShell TLS identity as supervisor-only in every managed agent", () => {
    const hermesBoundary = fs.readFileSync(
      path.join(repoRoot, "agents", "hermes", "validate-env-secret-boundary.py"),
      "utf8",
    );
    const dcodeWrapper = fs.readFileSync(
      path.join(repoRoot, "agents", "langchain-deepagents-code", "dcode-wrapper.sh"),
      "utf8",
    );
    const dcodeRuntime = fs.readFileSync(
      path.join(repoRoot, "agents", "langchain-deepagents-code", "managed-dcode-runtime.py"),
      "utf8",
    );
    const boundaries = [hermesBoundary, dcodeWrapper, dcodeRuntime];

    for (const name of ["OPENSHELL_TLS_CA", "OPENSHELL_TLS_CERT", "OPENSHELL_TLS_KEY"]) {
      expect(
        boundaries.every((source) => source.includes(name)),
        name,
      ).toBe(true);
    }
    expect(hermesBoundary).not.toContain("RUNTIME_ALLOWED_PLATFORM_PATH_VALUES");
    expect(dcodeWrapper).not.toContain("is_allowed_openshell_runtime_value");
    expect(dcodeRuntime).not.toContain("/etc/openshell/tls/client/tls.key");
    expect(review).toContain("Hermes and Deep Agents now reject all three variables");
  });
});
