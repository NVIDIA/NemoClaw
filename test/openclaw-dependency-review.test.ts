// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob, type WorkflowStep } from "./helpers/e2e-workflow-contract";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const DEPENDENCY_REVIEW = path.join(
  REPO_ROOT,
  "internal",
  "security-reviews",
  "openclaw-2026.6.10-dependency-review.md",
);
const ACTIVE_DEPENDENCY_REVIEW = path.join(
  REPO_ROOT,
  "internal",
  "security-reviews",
  "openclaw-2026.7.1-dependency-review.md",
);
const MCP_TROUBLESHOOTING = path.join(
  REPO_ROOT,
  "docs",
  "reference",
  "troubleshoot-mcp-servers.mdx",
);
const CODEX_ACP_TARBALL =
  "https://registry.npmjs.org/@zed-industries/codex-acp/-/codex-acp-0.11.1.tgz";
const OPENCLAW_TARBALL = "https://registry.npmjs.org/openclaw/-/openclaw-2026.7.1.tgz";
const MESSAGING_BUILD_APPLIER = path.join(
  REPO_ROOT,
  "src",
  "lib",
  "messaging",
  "applier",
  "build",
  "messaging-build-applier.mts",
);
const ISSUE_4434_PATCH = path.join(
  REPO_ROOT,
  "scripts",
  "patch-openclaw-issue-4434-diagnostics.mts",
);
const DEVICE_SELF_APPROVAL_PATCH = path.join(
  REPO_ROOT,
  "scripts",
  "patch-openclaw-device-self-approval.mts",
);
const SHARED_STATE_PERMISSIONS_PATCH = path.join(
  REPO_ROOT,
  "scripts",
  "patch-openclaw-shared-state-permissions.mts",
);
const MCP_RELIABILITY_PATCH = path.join(REPO_ROOT, "scripts", "patch-openclaw-mcp-reliability.mts");
const MCP_TOOLS_LIST_TIMEOUT_PATCH = path.join(
  REPO_ROOT,
  "scripts",
  "patch-openclaw-mcp-tools-list-timeout.mts",
);
const REBUILD_RESUME_SESSION = path.join(
  REPO_ROOT,
  "src",
  "lib",
  "actions",
  "sandbox",
  "rebuild-resume-session.ts",
);

type Workflow = {
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

function requiredStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  expect(step, `Missing workflow step: ${name}`).toBeDefined();
  return step as WorkflowStep;
}

function findProductionBuildGuardCoverage(
  workflowName: string,
  workflow: Workflow,
): Array<{ label: string; guarded: boolean }> {
  return Object.entries(workflow.jobs).flatMap(([jobName, job]) => {
    const steps = job.steps ?? [];
    return steps
      .map((step, index) => ({ step, index, run: step.run ?? "" }))
      .filter(
        ({ step, run }) =>
          (/\bdocker build\b/.test(run) &&
            /(?:^|\s)-t\s+["']?nemoclaw-(?:hermes-)?production(?:-arm64)?["']?(?:\s|$)/.test(
              run,
            )) ||
          String(step.uses ?? "").startsWith("docker/build-push-action@"),
      )
      .map(({ step, index, run }) => ({
        label: `${workflowName}:${jobName}:${step.name ?? step.uses}`,
        guarded:
          (run.indexOf("scripts/check-production-build-args.sh") >= 0 &&
            run.indexOf("scripts/check-production-build-args.sh") < run.indexOf("docker build")) ||
          steps
            .slice(0, index)
            .some((candidate) =>
              (candidate.run ?? "").includes("scripts/check-production-build-args.sh"),
            ),
      }));
  });
}

function workflowContracts(): Array<{ name: string; workflow: Workflow }> {
  return readdirSync(path.join(REPO_ROOT, ".github", "workflows"))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({
      name: name.replace(/\.ya?ml$/, ""),
      workflow: readYaml<Workflow>(`.github/workflows/${name}`),
    }));
}

function runBaseImageBuildArgGuard(
  step: WorkflowStep,
  openclawVersion: string,
  agent = "openclaw",
): { output: string; result: ReturnType<typeof spawnSync> } {
  const tmp = mkdtempSync(path.join(tmpdir(), "nemoclaw-base-image-build-args-"));
  const githubOutput = path.join(tmp, "github-output");
  try {
    const result = spawnSync("bash", ["-c", step.run ?? ""], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        AGENT: agent,
        GITHUB_OUTPUT: githubOutput,
        OPENCLAW_VERSION_INPUT: openclawVersion,
      },
    });
    const output = existsSync(githubOutput) ? readFileSync(githubOutput, "utf-8") : "";
    return { output, result };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("OpenClaw 2026.6.10 dependency review contract", () => {
  it("pins the active diagnostics Jaeger remediation to the shipped install path", () => {
    const review = readFileSync(ACTIVE_DEPENDENCY_REVIEW, "utf-8");

    expect(review).toContain("GHSA-45rx-2jwx-cxfr");
    expect(review).toContain("@opentelemetry/propagator-jaeger@2.9.0");
    expect(review).toContain("nested `@opentelemetry/core@2.9.0`");
    expect(review).toContain(
      "sha512-4mYGty27rYvSM0jtp1ZUOqd3LfVRCYg9H5G9OFzSx5HViYToU21MFhWfco7x1HwXr7ER8yGOiCIHZUwjPksc0Q==",
    );
    expect(review).toContain(
      "sha512-m2nckMT80NnmjTYSPjJQObBJ+8dgkoajEOUbznL8AHZ3T3yHRk2P7gI1PhEBc1+lOnrYE9UWrWHqJDsmqjmNbw==",
    );
    expect(review).toContain(
      "sha512-2qyDTRPqNs97jo/pAWWfxAkVZyCXYqui/IjrGf4eEfYop1eGN8qBMJ/Kp/bJ/V18RNnYpMxHi5ECFelekVxcAQ==",
    );
    expect(review).toContain("SDK Node `0.219.0`");
    expect(review).toContain("preexisting nested Core");
    expect(review).toContain("test/openclaw-diagnostics-jaeger-runtime.test.ts");
    expect(review).toContain("NEMOCLAW_REAL_OPENCLAW_JAEGER_HARNESS=1");
  });

  it("records the version-scoped transient remote MCP startup recovery patch (#7958)", () => {
    const review = readFileSync(ACTIVE_DEPENDENCY_REVIEW, "utf-8");
    const troubleshooting = readFileSync(MCP_TROUBLESHOOTING, "utf-8");

    expect(review).toContain("## Transient Remote MCP Startup Recovery");
    expect(review).toContain("scripts/patch-openclaw-mcp-reliability.mts");
    expect(review).toContain(
      'identifies its target by the `"openclaw-bundle-mcp"` client identity',
    );
    expect(review).toContain("One retry, and only one, for a server *startup* failure");
    expect(review).toContain("are never retried");
    expect(review).toContain("dropped at the next agent run boundary");
    expect(review).toContain("test/openclaw-mcp-reliability-patch.test.ts");
    expect(review).toContain("test/helpers/openclaw-real-mcp-start-retry-proof.ts");
    expect(review).toContain("NEMOCLAW_REAL_OPENCLAW_DIST_HARNESS=1");
    expect(review).toContain(
      "Removal criterion: drop this patch when the reviewed OpenClaw release",
    );
    expect(review).toContain("only when the *surviving* failure is itself transient");
    expect(review).toContain("credentials and configuration were not rejected");
    expect(review).not.toContain("explicitly clears credentials and configuration");
    expect(review).not.toContain("a refused destination is deterministic");
    expect(troubleshooting).toMatch(
      /<AgentOnly variant="openclaw">\n\n## Remote MCP Tools Are Missing for One Agent Turn[\s\S]*?<\/AgentOnly>/,
    );
  });

  it("records the version-scoped managed outbound transport diagnostics patch (#7957)", () => {
    const review = readFileSync(ACTIVE_DEPENDENCY_REVIEW, "utf-8");

    expect(review).toContain("## Managed Outbound Transport Diagnostics");
    expect(review).toContain("scripts/patch-openclaw-managed-transport-diagnostics.mts");
    expect(review).toContain("The sibling SSE transport boundary is deliberately left unwrapped.");
    expect(review).toContain("Failure-only by default.");
    expect(review).toContain("`NEMOCLAW_MCP_SHADOW_DIAGNOSTICS=1`");
    expect(review).toContain("successful-request `managed_transport_shadow` timing events");
    expect(review).toContain("never retries, never alters the request");
    expect(review).toContain("`route=proxy_configured` means that `HTTPS_PROXY`");
    expect(review).toContain("report configuration evidence");
    expect(review).toContain("do not prove whether the failed request used a proxy");
    expect(review).toContain(
      "returns the original response without waiting for asynchronous sampling",
    );
    expect(review).toContain("waits at most 250 ms");
    expect(review).toContain("retains at most 2,048 response bytes");
    expect(review).toContain("Non-2xx response diagnostics are best-effort.");
    expect(review).toContain("port, and a redacted message");
    expect(review).toContain("a thrown `UND_ERR_HEADERS_TIMEOUT` failure");
    expect(review).toContain("no response headers or `http_status`");
    expect(review).toContain("The `transport_phase` field classifies a thrown failure");
    expect(review).toContain("A returned non-2xx response sets `transport_phase=response_headers`");
    expect(review).toContain("transport-phase signal");
    expect(review).toContain("does not inspect a 2xx response body");
    expect(review).toContain("report a validated JSON-RPC method");
    expect(review).toContain("reports the configured server name as `mcp_server`");
    expect(review).toContain("Shadow recommendations apply only to `tools/list`");
    expect(review).toContain("An explicit HTTP 503 produces no timeout recommendation.");
    expect(review).toContain("structured credentials such as `access_token`");
    expect(review).toContain("The peer address is not recorded.");
    expect(review).toContain("The `mcp-session-id` value is never emitted.");
    expect(review).toContain("inert unless `OPENSHELL_SANDBOX=1`");
    expect(review).toContain("test/openclaw-managed-transport-diagnostics-patch.test.ts");
    expect(review).toContain("executes that exact helper");
    expect(review).toContain("local 32-character hexadecimal `diagnostic_id`");
    expect(review).toContain("not a distributed trace identifier");
    expect(review).toContain(
      "Managed transport diagnostics remains separate from `scripts/patch-openclaw-mcp-reliability.mts`.",
    );
    expect(review).toContain("wraps every failed remote Streamable HTTP fetch");
    expect(review).toContain("The reliability patch owns startup catalog and retry behavior.");
    expect(review).toContain("The two patches compose independently.");
    expect(review).toContain(
      "A reusable source schema is deferred until a production consumer requires one.",
    );
    expect(review).not.toContain("src/lib/observability/managed-transport.test.ts");
    expect(review).toContain("NVIDIA/OpenShell#2508");
  });

  it("records the bounded MCP tool discovery timeout patch (#7957)", () => {
    const review = readFileSync(ACTIVE_DEPENDENCY_REVIEW, "utf-8");
    const troubleshooting = readFileSync(MCP_TROUBLESHOOTING, "utf-8");

    expect(review).toContain("## Bounded MCP Tool Discovery Timeout");
    expect(review).toContain("scripts/patch-openclaw-mcp-tools-list-timeout.mts");
    expect(review).toContain("OpenClaw `2026.7.1` gives `tools/list` 1,500 ms");
    expect(review).toContain("from 1,500 through 10,000 ms");
    expect(review).toContain("only for catalog `tools/list` requests");
    expect(review).toContain("does not change the 30,000 ms connection timeout");
    expect(review).toContain("60,000 ms default used by tool calls");
    expect(review).toContain("test/openclaw-mcp-tools-list-timeout-patch.test.ts");
    expect(review).toContain("composition with managed transport diagnostics");
    expect(troubleshooting).toContain("### Adjust the Tool Discovery Timeout");
    expect(troubleshooting).toContain("NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS=3000");
    expect(troubleshooting).toContain("mcp_tools_list_timeout_override_ms=3000");
    expect(troubleshooting).toContain("Advance from `3000` to `5000`, and then to `10000`");
    expect(troubleshooting).toContain("McpError: MCP error -32001: Request timed out");
    expect(troubleshooting).toContain("connection timed out after 30000ms");
  });

  it("records the active mcporter advisory remediations", () => {
    const review = readFileSync(ACTIVE_DEPENDENCY_REVIEW, "utf-8");

    expect(review).toContain("GHSA-9mqv-5hh9-4cgg");
    expect(review).toContain("@hono/node-server@^1.19.9");
    expect(review).toContain("`2.0.11`");
    expect(review).toContain("GHSA-v2hh-gcrm-f6hx");
    expect(review).toContain("GHSA-7p8r-x3mc-p8w7");
    expect(review).toContain("fast-uri@^3.0.1");
    expect(review).toContain("`3.1.5`");
    expect(review).toContain("GHSA-8xcm-r25x-g524");
    expect(review).toContain("GHSA-4cwx-7wf7-3272");
    expect(review).toContain("undici@8.10.0");
    expect(review).toContain("GHSA-mwp4-54f8-5fhr");
    expect(review).toContain("ip-address@^10.2.0");
    expect(review).toContain("ip-address@10.3.1");
    expect(review).toContain("hono@4.12.34");
    expect(review).toContain("GHSA-54fx-42gc-7vw4");
    expect(review).toContain("GHSA-f23p-vx2j-j53r");
    expect(review).toContain("GHSA-79qm-7rj5-m7r9");
  });

  it("keeps advisor disposition evidence in the dependency review note", () => {
    const review = readFileSync(DEPENDENCY_REVIEW, "utf-8");

    expect(review).toContain("Issue #5591 Acceptance Mapping");
    expect(review).toContain('"Latest stable version of Hermes"');
    expect(review).toContain('"Latest version of OpenShell"');
    expect(review).toContain('"Latest stable version of OpenClaw"');
    expect(review).toContain("merged PR #5594");
    expect(review).toContain("merged PR #5596");
    expect(review).toContain("references rather than closes #5591");
    expect(review).toContain(CODEX_ACP_TARBALL);
    expect(review).toContain("bind reviewed npm installs to verified local archives");
    expect(review).toContain("downloaded tarball integrity");
    expect(review).toContain("npm pack --json");
    expect(review).toContain("install the verified archive path");
    expect(review).toContain("contained regular-file basename in a fresh directory");
    expect(review).toContain("unsafe reported archive filenames");
    expect(review).toContain("no installer code consumes raw `npm pack --json` filenames");
    expect(review).toContain("The #4434 compatibility-shim disposition is explicitly accepted");
    expect(review).toContain(
      "The assembled-image and rebuilt-sandbox proof residual is explicitly accepted",
    );
    expect(review).toContain(
      "No single lane combines the final production image, a live `host.openshell.internal` SSRF-negative matrix",
    );
    expect(review).toContain(
      "The literal issue #2478 Local Ollama plus Telegram inbound recovery residual is explicitly accepted",
    );
    expect(review).toContain(
      "This does not reproduce `nemotron-3-super:120b` on Local Ollama or originate a Telegram inbound update after the crash",
    );
    expect(review).not.toContain("PRA-5");
    expect(review).toContain("3/3 fields are present in the NemoClaw-patched runtime output");
    expect(review).toContain(
      "3/3 fields are missing in the upstream-shaped `openclaw@2026.6.10` output",
    );
    expect(review).toContain("OpenClaw Patch Source-of-Truth Table");
    expect(review).toContain(
      "| Patch | Invalid state | Source boundary | Why upstream/source cannot be fixed here | Regression test | Removal condition |",
    );

    for (const [patch, requiredTerms] of [
      ["Patch 2:", ["assertExplicitProxyAllowed", "OPENSHELL_SANDBOX=1", "upstream"]],
      ["Patch 2b:", ["host.openshell.internal", "useEnvProxy", "allowedHostnames"]],
      ["Patch 4:", ["managed-proxy activation", "dispatcherPolicy", "strict fetches"]],
      [
        "Patch 6:",
        ["cron model-provider preflight", "trusted_env_proxy", "cron-model-provider-preflight"],
      ],
      [
        "Patch 7:",
        [
          "#4434 TUI unreachable-inference diagnostic enrichment",
          "OPENSHELL_SANDBOX=1",
          "formatRawAssistantErrorForUi",
        ],
      ],
      [
        "Patch 8:",
        ["bounded same-device device scope approval", "operator.pairing", "approveDevicePairing"],
      ],
    ] as const) {
      const row = review.split("\n").find((line) => line.includes(`| ${patch}`));
      expect(row, patch).toBeDefined();
      expect(
        row
          ?.split("|")
          .slice(1, -1)
          .every((cell) => cell.trim().length > 0),
        patch,
      ).toBe(true);
      for (const term of requiredTerms) {
        expect(row, `${patch} ${term}`).toContain(term);
      }
    }

    expect(review).toContain("OpenClaw Diagnostics OTEL Host Gateway Boundary");
    expect(review).toContain("openclaw-diagnostics-otel-local");
    expect(review).toContain("separate from the `web_fetch` host-gateway exception");
    expect(review).toContain("contains no `web_fetch`, `fetchWithSsrFGuard`");

    expect(review).toContain("Microsoft Teams Live E2E Disposition");
    expect(review).toContain("No real Microsoft Teams tenant proof is included in this PR");
    expect(review).toContain("tracked as a follow-up outside this dependency bump");
    expect(review).toContain("must not be described as a Teams round trip");
    expect(review).not.toContain("teams-message-round-trip");

    expect(review).toContain("Advisor Disposition");
    expect(review).toContain("Release Checklist for Accepted Residual Risk");
    expect(review).toContain("test/openclaw-real-patched-dist-harness.test.ts");
    expect(review).toContain("NEMOCLAW_REAL_OPENCLAW_DIST_HARNESS=1");
    expect(review).toContain("PR CI intentionally does not treat PR-authored harness code");
    expect(review).toContain("applies the Dockerfile patch block");
    expect(review).toContain("test/openclaw-issue-4434-diagnostics-patch.test.ts");
    expect(review).toContain("scripts/patch-openclaw-issue-4434-diagnostics.mts");
    expect(review).toContain("scripts/patch-openclaw-device-self-approval.mts");
    expect(review).toContain("NemoClaw no longer reads or writes device state during approval");
    expect(review).toContain("Merge disposition for this OpenClaw 2026.6.10 bump");
    expect(review).toContain("Issue #4434 full live acceptance");
    expect(review).toContain("code-backed for the reviewed `openclaw@2026.6.10` artifact");
    expect(review).toContain("src/lib/messaging/channels/manifests.test.ts");
    expect(review).toContain("npm audit result in this note remains a point-in-time snapshot");
    expect(review).toContain("Advisory audit revalidated: 2026-07-21");
    expect(review).toContain(
      "`0` info, `1` low, `12` moderate, `0` high, and `0` critical findings across `767` total dependencies",
    );
    expect(review).toContain(
      "The mcporter locked graph reported no findings across `138` dependencies",
    );
    expect(review).toContain("`@hono/node-server` to patched release `2.0.11`");
    expect(review).toContain("GHSA-frvp-7c67-39w9");
    expect(review).toContain("Hono finding remains in the reviewed OpenClaw graph");
    expect(review).toContain("GHSA-v422-hmwv-36x6");
    expect(review).toContain("reviewed Slack and Microsoft Teams plugin graphs");
    expect(review).toContain("GHSA-j3f2-48v5-ccww");
    expect(review).toContain("reviewed diagnostics OTEL and WhatsApp plugin graphs");
    expect(review).toContain("Node `v22.22.2`");
    expect(review).toContain("public npm registry");
    expect(review).toContain("engine requirement of `>=22.19.0`");
    expect(review).toContain(
      "separate `wechat-runtime-audit` gate uses Node `22.19.0` and npm `10.9.4`",
    );
    expect(review).toContain("Node `22.19.0` and npm `10.9.4`");
    expect(review).toContain("fails on any low-or-higher production advisory");
    expect(review).toContain("Default PR and main CI now rematerialize");
    expect(review).toContain("`npm audit --omit=dev --json`");
    expect(review).toContain("configured threshold in `ci/reviewed-npm-audit.json` is `high`");
    expect(review).toContain(
      "exception registry at `ci/npm-audit-exceptions.json` is empty by default",
    );
    expect(review).toContain("contains no exception for `GHSA-v2hh-gcrm-f6hx`");
    expect(review).toContain("Transitive Dependency Graph Rationale");
    expect(review).toContain("Transitive Remediation Boundary");
    expect(review).toContain("point-in-time record of the remediation shipped for the");
    expect(review).toContain("current 2026.7.1 path also remediates its source `tar`");
    expect(review).toContain("openclaw-2026.7.1-dependency-review.md");
    expect(review).toContain("Transitive Remediation Concern Ledger");
    expect(review).toContain("`openclaw@2026.6.10`, the helper makes these changes");
    expect(review).toContain("`tar@7.5.16` with `tar@7.5.21`");
    expect(review).toContain("`brace-expansion@5.0.6` with `brace-expansion@5.0.7`");
    expect(review).toContain("`@openclaw/fs-safe@0.3.0`");
    expect(review).toContain("removes its duplicate optional `tar` and `jszip` declarations");
    expect(review).toContain("direct `tar@7.5.21` and `jszip@3.10.1` dependencies");
    expect(review).toContain("`axios@1.16.0` with `axios@1.18.0`");
    expect(review).toContain("`https-proxy-agent@5.0.1` and `agent-base@6.0.2`");
    expect(review).toContain("`@opentelemetry/propagator-jaeger@2.8.0` with `2.9.0`");
    expect(review).toContain("bundled `@opentelemetry/sdk-node@0.219.0`");
    expect(review).toContain("Nests reviewed `@opentelemetry/core@2.9.0`");
    expect(review).toContain("complete published `v2.8.0..v2.9.0` range");
    expect(review).toContain("`b1c196d49d54caae59741cca0a9d57d101d7ea88`");
    expect(review).toContain("unrelated breaking notice only deprecates the OpenTracing shim");
    expect(review).toContain("Node `^18.19.0 || >=20.6.0`");
    expect(review).toContain("exact registry SRI and tarball URL");
    expect(review).toContain(
      "rejects unsafe archive members before extraction and after repacking",
    );
    expect(review).toContain("committed SHA-512 metadata value");
    expect(review).toContain(
      "core value also covers the bundled `@openclaw/fs-safe` package manifest",
    );
    for (const integrity of [
      "sha512-XdhtCvlMywwxpCW8YEq3lOXBJpUPTR2OHHcwLPO3HwsJqOHa2Ok/oJ7ruGzp+JrKoRPVCzJwAdEjqLW/vNRPHA==",
      "sha512-7oFy703dxfY3/NLxC1fh2SUCQ0H9rmAY+5EpDVfXjUTTs+HEwR2nYaqLv+GWcTsumwxPfiz6CzCNkwXwBUwqCA==",
      "sha512-uIBE441CIt1kIURoP9qRGKZ8LkGyfD9ZzeESjwAd29ZPWtghws/5GR3Pjb67jKdcJHP1I6roNXcvnhzAU7lHlA==",
      "sha512-E32NzpYKp++W7XRe52rHiXV2ehxmh3wbdgO7MHeFM+vqxLBYHzt0ElkiImtOBxtOmyp0yoC8C6uESVV84Y2/hw==",
      "sha512-dFcAjpTQFgoLMzC2VwU+C/CbS7uRL0lWmxDITmqm7C+7F0Odmj6s9l6alZc6AELXhrnggM2CeWSXHGOdX2YtwA==",
      "sha512-RZNwNclF7+MS/8bDg70amg32dyeZGZxiDuQmZxKLAlQjr3jGyLx+4Kkk58UO7D2QdgFIQCovuSuZESne6RG6XQ==",
      "sha512-4mYGty27rYvSM0jtp1ZUOqd3LfVRCYg9H5G9OFzSx5HViYToU21MFhWfco7x1HwXr7ER8yGOiCIHZUwjPksc0Q==",
      "sha512-m2nckMT80NnmjTYSPjJQObBJ+8dgkoajEOUbznL8AHZ3T3yHRk2P7gI1PhEBc1+lOnrYE9UWrWHqJDsmqjmNbw==",
      "sha512-XMycUUV7gCzUYbjgwrglER0AQEtfuKUz6wyo4ilm/7nSSkLocYUYVkrJuBFYPW3no8Y5FW/1+2hWCssIyjxn3g==",
      "sha512-ByLYBs3KXz3u0mPuj9DcP/xPTJNgQaLTPxazybhyIC1VjyftEmKQuoZufPZ8z8CjwBsOPm6NbjMQB2BfX36TTg==",
      "sha512-AXllGzI+m33jUq3w1nCVXngLA1m9kH8c9XryHSoPzuVhGP6xwWpzgKl3yyfOMoIykN0GKcka59ZZbjEwkxFudQ==",
      "sha512-eTTIpA8HzcBwXBLt6UZDoFgOUmkRgIhcZFBOwg+5Jfgt8HDwtfPnqKo6vm2DdDdPMPhu08FbEzU5Gt3RoL5fIw==",
    ]) {
      expect(review).toContain(integrity);
    }
    for (const tarball of [
      "https://registry.npmjs.org/tar/-/tar-7.5.21.tgz",
      "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.7.tgz",
      "https://registry.npmjs.org/@openclaw/fs-safe/-/fs-safe-0.3.0.tgz",
      "https://registry.npmjs.org/axios/-/axios-1.18.0.tgz",
      "https://registry.npmjs.org/https-proxy-agent/-/https-proxy-agent-5.0.1.tgz",
      "https://registry.npmjs.org/agent-base/-/agent-base-6.0.2.tgz",
      "https://registry.npmjs.org/@opentelemetry/propagator-jaeger/-/propagator-jaeger-2.9.0.tgz",
      "https://registry.npmjs.org/@opentelemetry/core/-/core-2.9.0.tgz",
    ]) {
      expect(review).toContain(tarball);
    }
    expect(review).toContain("ignore-scripts+reviewed-lifecycle+transitive-remediation-v1");
    expect(review).toContain("The replacement graph has no repository-generated lock-derived SBOM");
    expect(review).toContain(
      "`https-proxy-agent@5.0.1` and `agent-base@6.0.2` tarballs declare MIT in package metadata but contain no license file",
    );
    expect(review).toContain("The other replacement tarballs include license files");
    expect(review).toContain("`tar@7.5.21` declares BlueOak-1.0.0");
    expect(review).toContain("the OpenTelemetry packages declare Apache-2.0");
    expect(review).toContain("the other packages declare MIT");
    expect(review).toContain(
      "The OpenClaw 2026.6.10 bump does not newly introduce an unfrozen OpenClaw transitive graph",
    );
    expect(review).toContain(
      "The reviewed `openclaw@2026.6.10` artifact ships `npm-shrinkwrap.json`",
    );
    expect(review).toContain(
      "the previous reviewed `openclaw@2026.6.9` artifact also shipped `npm-shrinkwrap.json`",
    );
    expect(review).toContain("lockfile version `3`, `306` package entries");
    expect(review).toContain("no resolved package entries missing integrity metadata");
    expect(review).toContain("`@openclaw/diagnostics-otel@2026.6.10`");
    expect(review).toContain("`@openclaw/brave-plugin@2026.6.10`");
    expect(review).toContain("`@openclaw/discord@2026.6.10`");
    expect(review).toContain("`@openclaw/slack@2026.6.10`");
    expect(review).toContain("`@openclaw/whatsapp@2026.6.10`");
    expect(review).toContain("`@openclaw/msteams@2026.6.10`");
    expect(review).toContain("`@zed-industries/codex-acp@0.11.1` has no declared npm dependencies");
    expect(review).toContain(
      "only reviewed messaging plugin without a package-internal shrinkwrap was the existing non-OpenClaw Tencent WeChat plugin",
    );
    expect(review).toContain("Current NemoClaw builds close that residual");
    expect(review).toContain("copies it into a disposable writable cache");
    expect(review).toContain("Current NemoClaw closes the WeChat residual");
    expect(review).toContain("stale nonterminal rebuild-resume repair");
    expect(review).toContain("tracked against #4533");
    expect(review).toContain("src/lib/actions/sandbox/rebuild-resume-session.test.ts");
    expect(review).toContain("test/onboard-resume-provider-recovery.test.ts");
    expect(review).toContain("machine.state='openclaw'");
    expect(review).toContain("scripts/check-production-build-args.sh");
    expect(review).toContain("every declared integrity/tarball ARG override");
    expect(review).toContain("future-shaped positional pin names");
    expect(review).toContain("Recovered Gateway Credential Boundary");
    expect(review).toContain("OpenClaw Device Approval Convergence Boundary");
    expect(review).toContain("device-token authentication");
    expect(review).toContain("repeats current pending identity, role, repair-marker");
    expect(review).toContain("NemoClaw no longer reads or writes device state during approval");
    expect(review).toContain(
      "delete Patch 8 when a reviewed OpenClaw release completes this bounded same-device flow",
    );
    expect(review).toContain("src/lib/onboard/recovered-provider-reuse.ts");
    expect(review).toContain("passes that route only in memory to the same sandbox's recreate");
    expect(review).toContain("test/onboard-remote-recreate-credential-reuse.test.ts");
    expect(review).toContain("Image-Managed OpenClaw Extension Restore Boundary");
    expect(review).toContain("src/lib/state/openclaw-managed-extensions.ts");
    expect(review).toContain("issue #5896");
    expect(review).toContain("route-provenance additions remain with their");
    expect(review).toContain("`src/lib/state/sandbox.ts` is 100 lines smaller");
    expect(review).toContain("Shared #5896 Archive and Audit Contract");
    expect(review).toContain("`scripts/lib/reviewed-npm-archive.mts`");
    expect(review).toContain("protected exact provenance marker");
    expect(review).toContain("mcporter package, SRI, tarball URL, lockfile SHA-256");
    expect(review).toContain("removes the marker before applying NemoClaw patches");
    expect(review).toContain("fifteen fallback states");
    expect(review).toContain("Issue #5896 section 2");
    expect(review).toContain("issue #5896 section 9");
    expect(review).toContain("direct source- and target-traversal vectors");
    expect(review).toContain("Live gateway display output is treated as untrusted text");
    expect(review).toContain("gateway-provider-metadata.ts");
    expect(review).toContain("Partial, oversized, duplicated, malformed, or ambiguous output");
    expect(review).toContain("Retained older OpenClaw pins are inactive compatibility/rollback");
    expect(review).toContain("fails closed on unknown or ambiguous formatter shapes");
    expect(review).toContain('OPENCLAW_VERSION="${OPENCLAW_VERSION}"');
    expect(review).toContain("test/messaging-build-applier-integrity.test.ts");
    expect(review).toContain("test/messaging-build-applier-render-safety.test.ts");
    expect(review).toContain("test/onboard-resume-provider-recovery.test.ts");
  });

  it("keeps every reviewed archive boundary on the shared invariant matrix (#5896)", () => {
    const result = spawnSync(
      "bash",
      [
        "-lc",
        `
set -euo pipefail

messaging_build_applier=${JSON.stringify(MESSAGING_BUILD_APPLIER)}
reviewed_archive_helper=scripts/lib/reviewed-npm-archive.mts
remediation_helper=scripts/lib/openclaw-npm-remediation.mts

boundary_marker_count="$(grep -hF 'Reviewed-archive invariants (#5896):' Dockerfile Dockerfile.base "$messaging_build_applier" | wc -l | tr -d ' ')"
test "$boundary_marker_count" -eq 5

check_contains() {
  haystack="$1"
  needle="$2"
  label="$3"
  case "$haystack" in
    *"$needle"*) ;;
    *) echo "missing $label: $needle" >&2; exit 1 ;;
  esac
}

check_not_contains() {
  haystack="$1"
  needle="$2"
  label="$3"
  case "$haystack" in
    *"$needle"*) echo "superseded $label remains: $needle" >&2; exit 1 ;;
    *) ;;
  esac
}

codex_acp_block="$(sed -n '/AS codex-acp-runtime/,/AS wechat-npm-cache/p' Dockerfile)"
check_contains "$(cat Dockerfile)" '${CODEX_ACP_TARBALL}' "codex-acp tarball"
check_contains "$(cat Dockerfile)" 'sha256:b287fe7bce0dc0b3d0c69400ab7d47567680439628ad22a89f0557cc736d64b8' "codex-acp immutable archive"
check_contains "$codex_acp_block" 'ARG CODEX_ACP_0_11_1_INTEGRITY' "codex-acp reviewed identity"
check_contains "$codex_acp_block" 'ARG CODEX_ACP_LINUX_AMD64_0_11_1_INTEGRITY' "codex-acp amd64 identity"
check_contains "$codex_acp_block" 'ARG CODEX_ACP_LINUX_ARM64_0_11_1_INTEGRITY' "codex-acp arm64 identity"
check_contains "$codex_acp_block" 'RUN --network=none' "codex-acp offline install"
check_contains "$codex_acp_block" 'npm install -g --offline --no-audit --no-fund --no-progress --ignore-scripts' "codex-acp local install path"
check_contains "$codex_acp_block" 'rm -rf /tmp/codex-acp' "codex-acp cleanup"
check_not_contains "$codex_acp_block" 'pack_reviewed_npm_tarball' "codex-acp inline pack helper"

for dockerfile in Dockerfile Dockerfile.base; do
  case "$dockerfile" in
    Dockerfile) end_marker='# Patch OpenClaw media fetch' ;;
    Dockerfile.base) end_marker='# Baseline health check.' ;;
  esac
  openclaw_block="$(sed -n "/ARG OPENCLAW_VERSION=2026.7.1/,/$end_marker/p" "$dockerfile")"
  check_contains "$openclaw_block" "ARG OPENCLAW_2026_7_1_TARBALL=${OPENCLAW_TARBALL}" "$dockerfile tarball arg"
  check_contains "$openclaw_block" '/scripts/lib/reviewed-npm-archive.mts' "$dockerfile shared helper"
  check_contains "$openclaw_block" '--package-spec "openclaw@\${OPENCLAW_VERSION}" --integrity "$EXPECTED_INTEGRITY"' "$dockerfile reviewed identity"
  check_contains "$openclaw_block" '--tarball-url "$EXPECTED_TARBALL"' "$dockerfile reviewed tarball"
  check_contains "$openclaw_block" '"$OPENCLAW_PACK_PATH"' "$dockerfile local install path"
  check_contains "$openclaw_block" 'OPENCLAW_PACK_DIR="$(dirname "$OPENCLAW_PACK_PATH")"' "$dockerfile pack directory"
  if [ "$dockerfile" = Dockerfile.base ]; then
    check_contains "$openclaw_block" '[ ! -f "$OPENCLAW_SOURCE_PACK_PATH" ]' "$dockerfile source archive path guard"
  fi
  check_contains "$openclaw_block" '--archive "$OPENCLAW_SOURCE_PACK_PATH" --package-spec "openclaw@\${OPENCLAW_VERSION}"' "$dockerfile legacy remediated identity"
  check_contains "$openclaw_block" 'if (!value.remediated || typeof value.archivePath !== "string")' "$dockerfile remediation result guard"
  check_contains "$openclaw_block" 'rm -rf "$OPENCLAW_PACK_DIR"' "$dockerfile cleanup"
  check_not_contains "$openclaw_block" 'REGISTRY_INTEGRITY=$(npm view' "$dockerfile inline integrity lookup"
  check_not_contains "$openclaw_block" 'pack_reviewed_npm_tarball' "$dockerfile inline pack helper"
  check_contains "$openclaw_block" 'openclaw-base-provenance-v1' "$dockerfile base provenance path"
  check_contains "$openclaw_block" "OPENCLAW_RECIPE='ignore-scripts+reviewed-lifecycle-v1'" "$dockerfile direct provenance recipe"
  check_contains "$openclaw_block" "OPENCLAW_RECIPE='ignore-scripts+reviewed-lifecycle+transitive-remediation-v1'" "$dockerfile remediated provenance recipe"
  check_contains "$openclaw_block" '"recipe=\${OPENCLAW_RECIPE}"' "$dockerfile selected provenance recipe"
  check_contains "$openclaw_block" 'mcporter-package=mcporter@' "$dockerfile mcporter provenance package"
  check_contains "$openclaw_block" 'mcporter-integrity=' "$dockerfile mcporter provenance integrity"
  check_contains "$openclaw_block" 'mcporter-lock-sha256=' "$dockerfile mcporter provenance lock hash"
  check_contains "$openclaw_block" 'mcporter-audit-policy-sha256=' "$dockerfile mcporter audit policy hash"
  check_contains "$openclaw_block" 'mcporter-audit-status=' "$dockerfile mcporter audit status"
  check_contains "$openclaw_block" 'mcporter-audit-exceptions=' "$dockerfile mcporter audit exceptions"
  check_contains "$openclaw_block" 'mcporter-recipe=locked-ci+reviewed-audit-v3' "$dockerfile mcporter provenance recipe"
done

check_contains "$(cat Dockerfile.base)" 'chmod 0444 "$OPENCLAW_PROVENANCE_TMP"' "base provenance protected mode"
check_contains "$(cat Dockerfile)" "stat -c '%u:%g:%a'" "runtime provenance metadata format"
check_contains "$(cat Dockerfile)" '0:0:444' "runtime provenance exact metadata"
check_contains "$(cat Dockerfile)" 'rm -rf "$OPENCLAW_PROVENANCE_PATH"' "runtime provenance consumption"

wechat_cache_block="$(sed -n '/AS wechat-npm-cache/,/# Group repository-owned files/p' Dockerfile)"
check_contains "$wechat_cache_block" 'reviewed-npm-archive.mts' "WeChat cache shared helper"
check_contains "$wechat_cache_block" 'seed-reviewed-npm-cache.mts' "WeChat cache offline seed"
check_contains "$wechat_cache_block" '--lockfile /opt/wechat-runtime/package-lock.json' "WeChat cache reviewed lock"
check_contains "$wechat_cache_block" '--cache /out/wechat-npm-cache' "WeChat cache boundary"
check_contains "$wechat_cache_block" '--registry-origin https://registry.npmjs.org/' "WeChat reviewed registry"
check_contains "$wechat_cache_block" 'NPM_CONFIG_OFFLINE=true' "WeChat cache offline verification"
check_contains "$wechat_cache_block" 'RUN --network=none' "WeChat cache offline materialization"

optional_plugin_block="$(sed -n '/# Install non-messaging OpenClaw plugins that need to match the runtime./,/^RUN OPENCLAW_VERSION=/p' Dockerfile)"
check_contains "$optional_plugin_block" '/scripts/lib/reviewed-npm-archive.mts' "optional plugin shared helper"
check_contains "$optional_plugin_block" '--package-spec "$plugin_spec" --integrity "$expected_integrity"' "optional plugin reviewed identity"
check_contains "$optional_plugin_block" '--tarball-url "$expected_tarball"' "optional plugin reviewed tarball"
check_contains "$optional_plugin_block" '/scripts/lib/openclaw-npm-remediation.mts' "optional plugin remediation helper"
check_contains "$optional_plugin_block" '"@openclaw/diagnostics-otel@2026.7.1")' "diagnostics remediation identity"
check_contains "$optional_plugin_block" '--working-directory "$plugin_work_root"' "diagnostics remediation workspace"
check_contains "$optional_plugin_block" 'if (!value.remediated || typeof value.archivePath !== "string")' "diagnostics remediation result guard"
check_contains "$optional_plugin_block" 'plugin_source_root="$(dirname "$plugin_archive")"' "optional plugin source root"
check_contains "$optional_plugin_block" 'plugin_work_root="$(mktemp -d /tmp/nemoclaw-openclaw-plugin.XXXXXX)"' "optional plugin writable workspace"
check_contains "$optional_plugin_block" 'plugin_install_archive="$plugin_archive"' "optional plugin default archive"
check_contains "$optional_plugin_block" 'openclaw plugins install "npm-pack:\${plugin_install_archive}"' "optional plugin npm-pack install"
check_contains "$optional_plugin_block" 'rm -rf "$plugin_work_root"' "optional plugin workspace cleanup"
check_contains "$optional_plugin_block" 'if [ -z "\${NEMOCLAW_REVIEWED_NPM_ARCHIVE_DIR:-}" ]; then rm -rf "$plugin_source_root"; fi' "optional plugin fallback source cleanup"
check_not_contains "$optional_plugin_block" 'pack_reviewed_npm_tarball' "optional plugin inline pack helper"

	grep -Fq 'packReviewedNpmArchive({' "$messaging_build_applier"
	grep -Fq '["openclaw", "plugins", "install", \`npm-pack:\${packed.archivePath}\`]' "$messaging_build_applier"
	grep -Fq 'rmSync(packed.rootDir, { recursive: true, force: true })' "$messaging_build_applier"
	grep -Fq 'from "../../../../../scripts/lib/reviewed-npm-archive.mts"' "$messaging_build_applier"
	grep -Fq 'from "../../../../../scripts/lib/openclaw-npm-remediation.mts"' "$messaging_build_applier"
	grep -Fq 'remediateReviewedOpenClawPluginArchive({' "$messaging_build_applier"
	grep -Fq 'spawnSync(request.npmExecutable ?? "npm", args' "$reviewed_archive_helper"
	grep -Fq '["view", request.packageSpec, "dist.integrity"]' "$reviewed_archive_helper"
	grep -Fq '["view", request.packageSpec, "dist.tarball"]' "$reviewed_archive_helper"
	grep -Fq '["pack", request.tarballUrl, "--pack-destination", rootDirectory, "--json"]' "$reviewed_archive_helper"
	grep -Fq 'reported unsafe archive filename' "$reviewed_archive_helper"
	grep -Fq 'expectedPatchedTreeIntegrity' "$remediation_helper"
	grep -Fq 'expectedPatchedMetadataIntegrity' "$remediation_helper"
	grep -Fq 'hashPackageTree' "$remediation_helper"
	grep -Fq 'patchOpenClawCorePackageGraph' "$remediation_helper"
	grep -Fq 'patchOpenClawDiagnosticsPackageGraph' "$remediation_helper"
	for package_spec in \
		'openclaw@2026.3.11' \
		'openclaw@2026.6.10' \
		'@openclaw/diagnostics-otel@2026.6.10' \
		'@openclaw/slack@2026.6.10' \
		'@openclaw/msteams@2026.6.10' \
		'@openclaw/diagnostics-otel@2026.7.1' \
		'@openclaw/slack@2026.7.1' \
		'@openclaw/msteams@2026.7.1'; do
		grep -Fq "$package_spec" "$remediation_helper"
	done
	grep -Fq 'validateArchiveMembers(archivePath' "$remediation_helper"
	remediation_cli_block="$(sed -n '/if (isMainModule())/,$p' "$remediation_helper")"
	check_contains "$remediation_cli_block" 'remediateReviewedOpenClawPluginArchive({' "remediation CLI tree-integrity enforcement"
	check_not_contains "$remediation_cli_block" 'buildRemediatedOpenClawPluginArchive({' "unenforced remediation CLI path"
	! grep -Fq 'npmViewString(' "$messaging_build_applier"
	! grep -Fq 'resolveNpmPackArchivePath(' "$messaging_build_applier"
	issue_4434_patch=${JSON.stringify(ISSUE_4434_PATCH)}
	grep -Fq 'formatRawAssistantErrorForUi' "$issue_4434_patch"
	grep -Fq 'OPENSHELL_SANDBOX !== "1"' "$issue_4434_patch"
		grep -Fq 'nemoclaw: #4434 structured unreachable-inference diagnostic' "$issue_4434_patch"
		grep -Fq 'COPY scripts/patch-openclaw-issue-4434-diagnostics.mts /usr/local/lib/nemoclaw/patch-openclaw-issue-4434-diagnostics.mts' Dockerfile
		grep -Fq 'node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-issue-4434-diagnostics.mts \\' Dockerfile
		grep -Fq 'COPY scripts/patch-openclaw-tool-catalog.mts /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts' Dockerfile
		grep -Fq 'node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts \\' Dockerfile
		! grep -Fq 'patch-openclaw-tool-catalog.js' Dockerfile
		device_self_approval_patch=${JSON.stringify(DEVICE_SELF_APPROVAL_PATCH)}
		grep -Fq 'nemoclaw: reach gateway for bounded same-device scope approval' "$device_self_approval_patch"
		grep -Fq 'nemoclaw: bounded same-device scope approval' "$device_self_approval_patch"
		grep -Fq 'nemoclaw: validate bounded self-approval inside pairing lock' "$device_self_approval_patch"
		grep -Fq 'COPY scripts/patch-openclaw-device-self-approval.mts /usr/local/lib/nemoclaw/patch-openclaw-device-self-approval.mts' Dockerfile
		grep -Fq 'node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-device-self-approval.mts \\' Dockerfile
	shared_state_permissions_patch=${JSON.stringify(SHARED_STATE_PERMISSIONS_PATCH)}
	grep -Fq 'nemoclaw: group-shared OpenClaw state' "$shared_state_permissions_patch"
	grep -Fq 'nemoclaw: group-shared OpenClaw agent state' "$shared_state_permissions_patch"
	grep -Fq 'keep generic credential and identity stores owner-only' "$shared_state_permissions_patch"
	! grep -Fq 'nemoclaw: group-shared OpenClaw private store' "$shared_state_permissions_patch"
	! grep -Fq 'nemoclaw: group-shared OpenClaw file-store defaults' "$shared_state_permissions_patch"
	grep -Fq 'nemoclaw: group-shared OpenClaw models file' "$shared_state_permissions_patch"
	grep -Fq 'nemoclaw: ignore legacy OpenClaw update-check state' "$shared_state_permissions_patch"
	grep -Fq 'COPY scripts/patch-openclaw-shared-state-permissions.mts /usr/local/lib/nemoclaw/patch-openclaw-shared-state-permissions.mts' Dockerfile
	grep -Fq 'node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-shared-state-permissions.mts \\' Dockerfile
	mcp_reliability_patch=${JSON.stringify(MCP_RELIABILITY_PATCH)}
	grep -Fq 'nemoclaw mcp transient startup recovery (#7958)' "$mcp_reliability_patch"
	grep -Fq 'nemoClawIsTransientMcpStartFailure' "$mcp_reliability_patch"
	grep -Fq 'nemoClawCatalogHasStartDiagnostics' "$mcp_reliability_patch"
	grep -Fq 'COPY scripts/patch-openclaw-mcp-reliability.mts /usr/local/lib/nemoclaw/patch-openclaw-mcp-reliability.mts' Dockerfile
	grep -Fq 'node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-mcp-reliability.mts \\' Dockerfile
	! grep -Fq 'patch-openclaw-mcp-reliability.js' Dockerfile
	mcp_tools_list_timeout_patch=${JSON.stringify(MCP_TOOLS_LIST_TIMEOUT_PATCH)}
	grep -Fq 'NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS' "$mcp_tools_list_timeout_patch"
	grep -Fq 'TOOLS_LIST_TIMEOUT_MIN_MS = 1500' "$mcp_tools_list_timeout_patch"
	grep -Fq 'TOOLS_LIST_TIMEOUT_MAX_MS = 10_000' "$mcp_tools_list_timeout_patch"
	grep -Fq 'COPY scripts/patch-openclaw-mcp-tools-list-timeout.mts /usr/local/lib/nemoclaw/patch-openclaw-mcp-tools-list-timeout.mts' Dockerfile
	grep -Fq 'node --experimental-strip-types /usr/local/lib/nemoclaw/patch-openclaw-mcp-tools-list-timeout.mts \\' Dockerfile
	! grep -Fq 'patch-openclaw-mcp-tools-list-timeout.js' Dockerfile

	phase_count="$(grep -Ec -- '--phase (runtime-setup|agent-install|post-agent-install)' Dockerfile)"
test "$phase_count" -eq 3
grep -Fq -- '--phase runtime-setup' Dockerfile
grep -Fq -- '--phase agent-install' Dockerfile
grep -Fq -- '--phase post-agent-install' Dockerfile
`,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      },
    );

    expect(result.stderr).toBe("");
    expect(result.status, result.stdout).toBe(0);
  });

  it("records the fail-closed messaging plugin provenance boundary", () => {
    const review = readFileSync(DEPENDENCY_REVIEW, "utf-8");
    const source = readFileSync(MESSAGING_BUILD_APPLIER, "utf-8");

    expect(review).toContain("Messaging Plugin Registry Provenance Boundary");
    expect(review).toContain("`registryTarballUrl` policy is `must-match-committed-url`");
    expect(review).toContain("committed exact URL matching registry `dist.tarball`");
    expect(review).toContain("carry exact tarball URLs for every messaging plugin");
    expect(source).toContain('registryTarballField: "dist.tarball"');
    expect(source).toContain('registryTarballUrl: "must-match-committed-url"');
  });

  it("keeps the rebuild-resume compatibility shim tied to its removal tracker", () => {
    const source = readFileSync(REBUILD_RESUME_SESSION, "utf-8");

    expect(source).toContain("Invalid legacy shape");
    expect(source).toContain("Removal condition");
    expect(source).toContain("#4533");
  });

  it.each([
    "NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1",
    "OPENCLAW_VERSION=2026.3.11",
    "OPENCLAW_VERSION=2026.4.24",
    "OPENCLAW_2026_3_11_INTEGRITY",
    "OPENCLAW_2026_3_11_TARBALL",
    "OPENCLAW_2026_4_24_INTEGRITY",
    "OPENCLAW_2026_4_24_TARBALL",
  ])(
    "keeps production Docker build workflows behind the build-arg guard [%s]",
    (fixtureSelector) => {
      const workflows = workflowContracts();
      const discoveredBuilds = workflows.flatMap(({ name, workflow }) =>
        findProductionBuildGuardCoverage(name, workflow),
      );

      expect(discoveredBuilds.length).toBeGreaterThan(0);
      expect(discoveredBuilds.filter(({ guarded }) => !guarded)).toEqual([]);

      const productionWorkflowContract = JSON.stringify(workflows);

      expect(productionWorkflowContract).not.toContain(fixtureSelector);
    },
  );

  it("accepts reviewed base-image versions and rejects injected build arguments", () => {
    const action = readYaml<{ runs: { steps: WorkflowStep[] } }>(
      ".github/actions/build-base-image-platform/action.yaml",
    );
    const guard = requiredStep(
      { steps: action.runs.steps },
      "Validate production Docker build args",
    );

    for (const [input, expectedOutput] of [
      ["", "openclaw_build_arg=\n"],
      ["2026", "openclaw_build_arg=OPENCLAW_VERSION=2026\n"],
      ["2026.6.10", "openclaw_build_arg=OPENCLAW_VERSION=2026.6.10\n"],
      ["1.2.3.4", "openclaw_build_arg=OPENCLAW_VERSION=1.2.3.4\n"],
    ]) {
      const { output, result } = runBaseImageBuildArgGuard(guard, input);
      expect(result.status, `${JSON.stringify(input)}: ${result.stderr}`).toBe(0);
      expect(output).toBe(expectedOutput);
    }

    for (const agent of ["hermes", "langchain-deepagents-code"]) {
      const { output, result } = runBaseImageBuildArgGuard(guard, "2026.6.10", agent);
      expect(result.status, `${agent}: ${result.stderr}`).toBe(0);
      expect(output).toBe("openclaw_build_arg=\n");
    }

    for (const input of ["v2026.6.10", "2026.6.10-beta.1", "2026.6.10 trailing", "2026.4.24"]) {
      const { output, result } = runBaseImageBuildArgGuard(guard, input);
      expect(result.status, JSON.stringify(input)).toBe(1);
      expect(output).toBe("");
    }

    for (const input of [
      "2026.6.10\r",
      "2026.6.9\nNEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1\nOPENCLAW_VERSION=2026.4.24",
    ]) {
      const { output, result } = runBaseImageBuildArgGuard(guard, input);
      expect(result.status, JSON.stringify(input)).toBe(1);
      expect(output).toBe("");
      expect(result.stderr).toContain(
        "production Docker build arguments must not contain CR or LF characters",
      );
    }
  });
});
