// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
describe("OpenShell migration executable contracts", () => {
  it("keeps exact-main runtime proofs separate from upstream-only fault injection", () => {

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

    const mcpProof = fs.readFileSync(
      path.join(repoRoot, "test", "e2e", "live", "openshell-exact-main-mcp-proof.ts"),
      "utf8",
    );
    expect(mcpProof).toContain("assertExactMainPolicyNftAndIdentityContracts({");
    expect(mcpProof).toContain("assertExactMainMcpLogPrivacy({");
  });

  it("binds selected-driver and tmpfs claims to the stable release runtime", () => {

    const helper = fs.readFileSync(
      path.join(repoRoot, "test/e2e/live/openshell-exact-main-driver-config.ts"),
      "utf8",
    );
    expect(helper).toContain("parse as parseToml");
    expect(helper).toContain('expect(gateway.compute_drivers).toEqual(["docker"])');
    expect(helper).toContain("Object.keys(drivers)");
    expect(helper).toContain("fs.realpathSync(`/proc/${gatewayPid}/exe`)");
    expect(helper).toContain('["-H", "-ltnp"]');
    expect(helper).toContain('"{{json .HostConfig.Binds}}"');
    expect(helper).not.toContain('tmpfsMarker: "present"');
    expect(helper.match(/tmpfsMarker: "absent",/gu)).toHaveLength(2);
    expect(helper).toContain('"same-container-tmpfs-remounted-and-durable-state-retained"');

    const mcpProof = fs.readFileSync(
      path.join(repoRoot, "test/e2e/live/openshell-exact-main-mcp-proof.ts"),
      "utf8",
    );
    expect(mcpProof).toContain("prepareExactMainDriverConfigProof(");
    expect(mcpProof).toContain("driverConfig.assertAfterOnboard()");
    expect(mcpProof).toContain("driverConfig.assertAfterRebuild()");
    expect(mcpProof).toContain("from deepagents_code import _nemoclaw_managed as managed");
    expect(mcpProof).not.toContain("/opt/nemoclaw-deepagents-code/managed-dcode-runtime.py");
    expect(mcpProof).toContain("def reject_primary_tmpfile(path, flags, *args, **kwargs):");
    expect(mcpProof).toContain("if directory == managed._MCP_ANONYMOUS_DIRECTORY:");
    expect(mcpProof).toContain("managed._MCP_PRIVATE_ANONYMOUS_DIRECTORY,");
  });
  it("keeps current stable selectors aligned", () => {
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
          "openshell-child-visible-credentials.v0.0.106.json",
        ),
        "utf8",
      ),
    ) as { openshellVersion: string };

    expect(blueprint).toContain('min_openshell_version: "0.0.106"');
    expect(blueprint).toContain('max_openshell_version: "0.0.106"');
    expect(manifest.openshellVersion).toBe("0.0.106");
  });
  it("does not reintroduce newline-only code transports at migrated consumers", () => {

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

    migratedConsumers.forEach(([relativePath, forbidden]) => {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
      expect(forbidden.every((obsoleteTransport) => !source.includes(obsoleteTransport))).toBe(true);
    });

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

  it.each(
    ["OPENSHELL_TLS_CA", "OPENSHELL_TLS_CERT", "OPENSHELL_TLS_KEY"],
  )("treats OpenShell TLS identity as supervisor-only in every managed agent [%s]", (name) => {
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

    expect(
      boundaries.every((source) => source.includes(name)),
      name,
    ).toBe(true);

    expect(hermesBoundary).not.toContain("RUNTIME_ALLOWED_PLATFORM_PATH_VALUES");
    expect(dcodeWrapper).not.toContain("is_allowed_openshell_runtime_value");
    expect(dcodeRuntime).not.toContain("/etc/openshell/tls/client/tls.key");
  });
});
