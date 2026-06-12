// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest migration for test/e2e/test-credential-sanitization.sh.
 *
 * Keep the replacement direct and small: local product-code assertions cover the
 * sanitization/digest contract, then a real install/onboard verifies the
 * sandbox filesystem does not expose credential artifacts or secret-shaped
 * values. No new scenario framework, registry, or shared helper is introduced.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import YAML from "yaml";

import {
  isCredentialField,
  isSensitiveFile,
  sanitizeConfigFile,
  stripCredentials,
} from "../../../src/lib/security/credential-filter.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, validateSandboxName } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "bin", "nemoclaw.js");
const BLUEPRINT_FILE = path.join(REPO_ROOT, "nemoclaw-blueprint", "blueprint.yaml");
const SANDBOX_NAME =
  process.env.NEMOCLAW_SANDBOX_NAME ?? `e2e-credential-sanitization-${process.pid}`;
const INSTALL_TIMEOUT_MS = 45 * 60_000;
const SANDBOX_PROBE_TIMEOUT_MS = 120_000;
validateSandboxName(SANDBOX_NAME);

const runCredentialSanitizationTest = test;

type CommandText = { stdout: string; stderr: string };

type Blueprint = {
  digest?: unknown;
  components?: { sandbox?: { image?: unknown } };
};

function resultText(result: CommandText): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function testEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const base = buildAvailabilityProbeEnv();
  return {
    ...base,
    HOME: home,
    PATH: [path.join(home, ".local", "bin"), base.PATH].filter(Boolean).join(":"),
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
    ...extra,
  };
}

async function bestEffort(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup probes are intentionally best-effort: local failures can happen
    // before install.sh has put OpenShell on this test HOME's PATH.
  }
}

async function cleanupCredentialSanitizationState(
  host: HostCliClient,
  home: string,
): Promise<void> {
  const env = testEnv(home);
  await bestEffort(() =>
    host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "destroy", "--yes"], {
      artifactName: "cleanup-nemoclaw-destroy-credential-sanitization",
      env,
      timeoutMs: 120_000,
    }),
  );
  await bestEffort(() =>
    host.command("openshell", ["sandbox", "delete", SANDBOX_NAME], {
      artifactName: "cleanup-openshell-sandbox-delete-credential-sanitization",
      env,
      timeoutMs: 60_000,
    }),
  );
  await bestEffort(() =>
    host.command("openshell", ["gateway", "destroy", "-g", "nemoclaw"], {
      artifactName: "cleanup-openshell-gateway-destroy-credential-sanitization",
      env,
      timeoutMs: 120_000,
    }),
  );
}

function removeSensitiveFiles(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      removeSensitiveFiles(fullPath);
    } else if (entry.isFile() && isSensitiveFile(entry.name)) {
      fs.rmSync(fullPath, { force: true });
    }
  }
}

function assertLocalCredentialSanitizationContract(): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cred-sanitize-"));
  try {
    const bundleDir = path.join(tmp, "bundle", "openclaw");
    const authDir = path.join(bundleDir, "agents", "main", "agent");
    const workspaceDir = path.join(bundleDir, "workspace");
    fs.mkdirSync(authDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const fakeNvidiaKey = "test-fake-nvidia-key-0000000000000000";
    const fakeGithubToken = "test-fake-github-token-1111111111111111";
    const fakeNpmToken = "test-fake-npm-token-2222222222222222";
    const fakeGatewayToken = "test-fake-gateway-token-333333333333";

    fs.writeFileSync(
      path.join(bundleDir, "openclaw.json"),
      JSON.stringify(
        {
          agents: {
            defaults: {
              model: { primary: "nvidia/nemotron-3-super-120b-a12b" },
              workspace: workspaceDir,
            },
          },
          gateway: { mode: "local", auth: { token: fakeGatewayToken } },
          nvidia: { apiKey: fakeNvidiaKey },
          mcpServers: { github: { env: { GITHUB_TOKEN: fakeGithubToken } } },
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(authDir, "auth-profiles.json"),
      JSON.stringify({
        "github:pat": { token: fakeGithubToken },
        "npm:publish": { token: fakeNpmToken },
      }),
    );
    fs.writeFileSync(path.join(workspaceDir, "project.md"), "# My Project\n");

    sanitizeConfigFile(path.join(bundleDir, "openclaw.json"));
    removeSensitiveFiles(bundleDir);

    const serialized = fs.readFileSync(path.join(bundleDir, "openclaw.json"), "utf8");
    expect(serialized).not.toContain(fakeNvidiaKey);
    expect(serialized).not.toContain(fakeGithubToken);
    expect(serialized).not.toContain(fakeGatewayToken);
    expect(fs.existsSync(path.join(authDir, "auth-profiles.json"))).toBe(false);

    const sanitized = JSON.parse(serialized) as {
      agents?: { defaults?: { model?: { primary?: string } } };
      nvidia?: { apiKey?: string };
      mcpServers?: { github?: { env?: { GITHUB_TOKEN?: string } } };
      gateway?: unknown;
    };
    expect(sanitized.nvidia?.apiKey).toBe("[STRIPPED_BY_MIGRATION]");
    expect(sanitized.mcpServers?.github?.env?.GITHUB_TOKEN).toBe("[STRIPPED_BY_MIGRATION]");
    expect(sanitized.gateway).toBeUndefined();
    expect(sanitized.agents?.defaults?.model?.primary).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(fs.readFileSync(path.join(workspaceDir, "project.md"), "utf8")).toBe("# My Project\n");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function assertCredentialFieldDetectionContract(): void {
  const credentialFields = [
    "accessToken",
    "refreshToken",
    "privateKey",
    "clientSecret",
    "signingKey",
    "bearerToken",
    "sessionToken",
    "authKey",
  ];
  for (const field of credentialFields) {
    expect(isCredentialField(field), `${field} should be credential-bearing`).toBe(true);
  }

  const config = {
    provider: Object.fromEntries(
      credentialFields.map((field) => [field, `test-${field}-value`]),
    ) as Record<string, string>,
    displayName: "should-be-preserved",
    sortKey: "should-also-be-preserved",
    modelName: "nvidia/nemotron-3-super-120b-a12b",
    keyRef: { source: "env", id: "NVIDIA_API_KEY" },
    description: "A secret garden (but not a real secret)",
    tokenizer: "sentencepiece",
    endpoint: "https://api.nvidia.com/v1",
    sessionId: "abc-123",
    accessLevel: "admin",
    publicUrl: "https://example.com",
  };

  const sanitized = stripCredentials(config);
  for (const value of Object.values(sanitized.provider)) {
    expect(value).toBe("[STRIPPED_BY_MIGRATION]");
  }
  expect(sanitized.displayName).toBe(config.displayName);
  expect(sanitized.sortKey).toBe(config.sortKey);
  expect(sanitized.modelName).toBe(config.modelName);
  expect(sanitized.keyRef).toEqual(config.keyRef);
  expect(sanitized.description).toBe(config.description);
  expect(sanitized.tokenizer).toBe(config.tokenizer);
  expect(sanitized.endpoint).toBe(config.endpoint);
  expect(sanitized.sessionId).toBe(config.sessionId);
  expect(sanitized.accessLevel).toBe(config.accessLevel);
  expect(sanitized.publicUrl).toBe(config.publicUrl);
}

function assertBlueprintDigestContract(): void {
  const blueprint = YAML.parse(fs.readFileSync(BLUEPRINT_FILE, "utf8")) as Blueprint;
  const topLevelDigest = typeof blueprint.digest === "string" ? blueprint.digest : "";
  expect(topLevelDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

  const image =
    typeof blueprint.components?.sandbox?.image === "string"
      ? blueprint.components.sandbox.image
      : "";
  const imageDigest = image.match(/@sha256:([0-9a-f]{64})$/)?.[1] ?? "";
  expect(`sha256:${imageDigest}`).toBe(topLevelDigest);
}

async function assertSandboxCredentialBoundary(
  sandbox: SandboxClient,
  home: string,
  apiKey: string,
): Promise<void> {
  const env = testEnv(home);
  const authProbe = await sandbox.exec(
    SANDBOX_NAME,
    [
      "sh",
      "-lc",
      "find /sandbox -name auth-profiles.json -not -path '*/node_modules/*' -not -path '*/dist/*' -print 2>/dev/null | head -5",
    ],
    {
      artifactName: "sandbox-auth-profiles-probe-credential-sanitization",
      env,
      timeoutMs: SANDBOX_PROBE_TIMEOUT_MS,
    },
  );
  expect(authProbe.exitCode, resultText(authProbe)).toBe(0);
  expect(authProbe.stdout.trim(), "auth-profiles.json must not be present in sandbox state").toBe(
    "",
  );

  const secretProbe = await sandbox.exec(
    SANDBOX_NAME,
    [
      "sh",
      "-lc",
      "for dir in /sandbox/.openclaw /sandbox/.nemoclaw; do " +
        '[ -d "$dir" ] || continue; ' +
        "grep -rE 'nvapi-|ghp_|npm_' \"$dir\" 2>/dev/null " +
        "| grep -v 'STRIPPED' " +
        "| grep -v '/policies/' " +
        "| grep -v '/plugin-runtime-deps/' " +
        "| grep -Ev '/extensions/[^/]+/(dist|node_modules)/' " +
        "| head -5 || true; " +
        "done",
    ],
    {
      artifactName: "sandbox-secret-pattern-probe-credential-sanitization",
      env,
      redactionValues: [apiKey],
      timeoutMs: SANDBOX_PROBE_TIMEOUT_MS,
    },
  );
  expect(secretProbe.exitCode, resultText(secretProbe)).toBe(0);
  expect(secretProbe.stdout.trim(), "sandbox config must not contain secret-shaped tokens").toBe(
    "",
  );
}

runCredentialSanitizationTest(
  "credential sanitization strips migration bundles and keeps sandbox secrets out of agent state",
  { timeout: INSTALL_TIMEOUT_MS + 10 * 60_000 },
  async ({ artifacts, cleanup, host, sandbox, secrets, skip }) => {
    expect(
      fs.existsSync(CLI_ENTRYPOINT),
      "run `npm run build:cli` before live repo CLI scenarios",
    ).toBe(true);

    await artifacts.writeJson("scenario.json", {
      id: "credential-sanitization",
      runner: "vitest",
      boundary: "install-sh-onboard-and-sandbox-exec",
      legacySource: "test/e2e/test-credential-sanitization.sh",
      sandboxName: SANDBOX_NAME,
      contracts: [
        "credential fields are stripped from migration bundle config while non-secret state survives",
        "auth-profiles.json is removed from migration bundle state",
        "pattern-based credential field detection strips token/key/secret/password suffixes without corrupting benign fields",
        "shipped blueprint digest is non-empty and matches the pinned sandbox image digest",
        "install.sh onboards a real Docker/OpenShell sandbox on the ubuntu-latest runner class",
        "sandbox filesystem does not expose auth-profiles.json or secret-shaped token values in agent state",
      ],
    });

    assertLocalCredentialSanitizationContract();
    assertCredentialFieldDetectionContract();
    assertBlueprintDigestContract();

    const apiKey = secrets.required("NVIDIA_API_KEY");
    expect(apiKey.startsWith("nvapi-"), "NVIDIA_API_KEY must start with nvapi-").toBe(true);

    const docker = await host.command("docker", ["info"], {
      artifactName: "prereq-docker-info-credential-sanitization",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    });
    if (docker.exitCode !== 0) {
      if (process.env.GITHUB_ACTIONS === "true") {
        throw new Error(
          `Docker is required for credential sanitization live E2E: ${resultText(docker)}`,
        );
      }
      skip("Docker is required for credential sanitization live E2E");
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cred-sanitization-home-"));
    cleanup.add(`remove credential sanitization state for ${SANDBOX_NAME}`, async () => {
      await cleanupCredentialSanitizationState(host, home);
      fs.rmSync(home, { recursive: true, force: true });
    });

    await cleanupCredentialSanitizationState(host, home);

    const install = await host.command(
      "bash",
      ["install.sh", "--non-interactive", "--yes-i-accept-third-party-software"],
      {
        artifactName: "install-and-onboard-credential-sanitization",
        cwd: REPO_ROOT,
        env: testEnv(home, {
          NVIDIA_API_KEY: apiKey,
          NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
          NEMOCLAW_RECREATE_SANDBOX: "1",
        }),
        redactionValues: [apiKey],
        timeoutMs: INSTALL_TIMEOUT_MS,
      },
    );
    expect(install.exitCode, resultText(install)).toBe(0);

    const status = await host.command("node", [CLI_ENTRYPOINT, SANDBOX_NAME, "status"], {
      artifactName: "nemoclaw-status-credential-sanitization",
      env: testEnv(home),
      timeoutMs: 60_000,
    });
    expect(status.exitCode, resultText(status)).toBe(0);

    await assertSandboxCredentialBoundary(sandbox, home, apiKey);
  },
);
