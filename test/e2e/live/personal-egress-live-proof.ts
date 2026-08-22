// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { parseOpenShellPolicy } from "../../../src/lib/policy/merge.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { HOSTED_INFERENCE_SECRET } from "../fixtures/hosted-inference.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import type { SecretStore } from "../fixtures/secrets.ts";
import { text } from "./common-egress-agent-helpers.ts";
import {
  runPersonalStockAgentAssertion,
  type PersonalStockAssertionResult,
} from "./openclaw-agent-assertion.ts";

export const PERSONAL_STOCK_PR_TARGET = "ubuntu-repo-cloud-openclaw";

interface NetworkPolicyEntry {
  binaries?: Array<{ path?: string }>;
  endpoints?: Array<{
    host?: string;
    hosts?: string[];
    port?: number | string;
    ports?: Array<number | string>;
  }>;
}

interface PolicyDocument {
  network_policies?: Record<string, NetworkPolicyEntry>;
}

export interface PersonalRuntimeEgressEvidence {
  deniedTargets: ["loopback", "link-local"];
  policyEntryMatchesReviewedPreset: true;
  publicFetchTools: ["curl", "python3"];
  webPorts: [80, 443];
  wildcardBinary: "/**";
}

export interface PersonalStockFetchEvidence {
  egress: PersonalRuntimeEgressEvidence;
  stock: PersonalStockAssertionResult;
}

export function requireRegistryTargetSecrets(
  targetId: string,
  requiredSecrets: readonly string[],
  secrets: SecretStore,
): void {
  for (const secret of requiredSecrets) {
    if (targetId === PERSONAL_STOCK_PR_TARGET && !secrets.optional(secret)) {
      throw new Error(`target '${targetId}' requires E2E secret '${secret}'`);
    }
    secrets.required(secret);
  }
}

export async function verifyPersonalStockFetchForTarget(
  targetId: string,
  policyTier: string | undefined,
  agent: string,
  sandbox: SandboxClient,
  host: HostCliClient,
  artifacts: ArtifactSink,
  secrets: SecretStore,
  sandboxName: string,
  announcePhase: () => void,
): Promise<PersonalStockFetchEvidence | undefined> {
  if (targetId !== PERSONAL_STOCK_PR_TARGET) return undefined;
  expect(policyTier).toBe("personal");
  expect(agent).toBe("openclaw");
  announcePhase();
  const egress = await assertPersonalRuntimeEgress(sandbox, sandboxName, "registry-personal");
  const stock = await runPersonalStockAgentAssertion(host, sandbox, artifacts, {
    apiKey: secrets.required(HOSTED_INFERENCE_SECRET),
    label: "registry-personal-stock",
    sandboxName,
  });
  return { egress, stock };
}

function commandEnv(): NodeJS.ProcessEnv {
  return {
    ...buildAvailabilityProbeEnv(),
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_RECREATE_SANDBOX: "1",
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY ?? "nemoclaw",
  };
}

export async function assertPersonalRuntimeEgress(
  sandbox: SandboxClient,
  sandboxName: string,
  artifactPrefix: string,
  phases: {
    beforeDeniedTargets?: () => void;
    beforePublicFetch?: () => void;
  } = {},
): Promise<PersonalRuntimeEgressEvidence> {
  const policy = await sandbox.openshell(["policy", "get", "--full", sandboxName], {
    artifactName: `${artifactPrefix}-policy`,
    env: commandEnv(),
    timeoutMs: 60_000,
  });
  expect(policy.exitCode, text(policy)).toBe(0);
  const policyYaml = parseOpenShellPolicy(policy.stdout).yamlBody;
  expect(policyYaml).toContain("personal_open_internet");
  expect(policyYaml).toContain("169.255.0.0/16");
  expect(policyYaml).toContain("2000::/3");
  expect(policyYaml).not.toContain("api.search.brave.com");
  expect(policyYaml).not.toContain("api.tavily.com");

  const document = YAML.parse(policyYaml) as PolicyDocument;
  const reviewedDocument = YAML.parse(
    fs.readFileSync(
      path.join(REPO_ROOT, "nemoclaw-blueprint/policies/presets/personal-open-internet.yaml"),
      "utf8",
    ),
  ) as PolicyDocument;
  const livePersonalEntry = document.network_policies?.personal_open_internet;
  const reviewedPersonalEntry = reviewedDocument.network_policies?.personal_open_internet;
  expect(reviewedPersonalEntry).toBeDefined();
  expect(livePersonalEntry).toEqual(reviewedPersonalEntry);
  expect(livePersonalEntry?.binaries).toEqual([{ path: "/**" }]);
  expect(livePersonalEntry?.endpoints).toHaveLength(1);
  expect(livePersonalEntry?.endpoints?.[0]).not.toHaveProperty("host");
  expect(livePersonalEntry?.endpoints?.[0]).not.toHaveProperty("hosts");
  const webPortClaims = Object.entries(document.network_policies ?? {})
    .flatMap(([policyName, entry]) =>
      (entry.endpoints ?? []).flatMap((endpoint) => {
        const ports = endpoint.ports ?? (endpoint.port === undefined ? [] : [endpoint.port]);
        return ports
          .map(Number)
          .filter((port) => port === 80 || port === 443)
          .map((port) => ({ policy: policyName, port }));
      }),
    )
    .sort((left, right) => left.policy.localeCompare(right.policy) || left.port - right.port);
  expect(webPortClaims).toEqual([
    { policy: "personal_open_internet", port: 80 },
    { policy: "personal_open_internet", port: 443 },
  ]);

  const keyless = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      'test -z "${BRAVE_API_KEY:-}" && test -z "${TAVILY_API_KEY:-}" && printf "PERSONAL_KEYLESS_FETCH_OK\\n"',
    ),
    {
      artifactName: `${artifactPrefix}-keyless-fetch`,
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(keyless.exitCode, text(keyless)).toBe(0);
  expect(keyless.stdout).toContain("PERSONAL_KEYLESS_FETCH_OK");

  phases.beforePublicFetch?.();
  const multiBinary = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(String.raw`
set -eu
curl_bin="$(command -v curl)"
python_bin="$(command -v python3)"
test -n "$curl_bin"
test -n "$python_bin"
test "$curl_bin" != "$python_bin"
curl_body="$(mktemp)"
trap 'rm -f "$curl_body"' EXIT
"$curl_bin" -fsSL --max-time 30 -o "$curl_body" https://example.com/
grep -Fq 'Example Domain' "$curl_body"
"$python_bin" -c 'import sys, urllib.request; body = urllib.request.urlopen(sys.argv[1], timeout=30).read(20000); raise SystemExit(0 if b"Example Domain" in body else 1)' https://example.com/
printf 'PERSONAL_PUBLIC_MULTI_BINARY_OK curl=%s python=%s\n' "$curl_bin" "$python_bin"
`),
    {
      artifactName: `${artifactPrefix}-public-multi-binary`,
      env: commandEnv(),
      timeoutMs: 90_000,
    },
  );
  expect(multiBinary.exitCode, text(multiBinary)).toBe(0);
  expect(multiBinary.stdout).toContain("PERSONAL_PUBLIC_MULTI_BINARY_OK");

  phases.beforeDeniedTargets?.();
  const deniedTargets = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(String.raw`
set -eu
probe_denied() {
  label="$1"
  target="$2"
  body="/tmp/nemoclaw-personal-denial-$label.body"
  stderr="/tmp/nemoclaw-personal-denial-$label.stderr"
  rm -f "$body" "$stderr"
  set +e
  status="$(curl --noproxy '' -sS -o "$body" -w '%{http_code}' --connect-timeout 5 --max-time 10 "$target" 2>"$stderr")"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ] || [ "$status" != "403" ]; then
    printf 'PERSONAL_DENIAL_FAILED label=%s status=%s rc=%s\n' "$label" "$status" "$rc" >&2
    head -c 1000 "$body" 2>/dev/null || true
    head -c 1000 "$stderr" >&2 2>/dev/null || true
    rm -f "$body" "$stderr"
    return 1
  fi
  rm -f "$body" "$stderr"
  printf 'PERSONAL_DENIAL_OK label=%s status=%s rc=%s\n' "$label" "$status" "$rc"
}
probe_denied loopback http://127.0.0.1:80/
probe_denied link-local http://169.254.169.254/latest/meta-data/
`),
    {
      artifactName: `${artifactPrefix}-loopback-link-local-denial`,
      env: commandEnv(),
      timeoutMs: 60_000,
    },
  );
  expect(deniedTargets.exitCode, text(deniedTargets)).toBe(0);
  expect(deniedTargets.stdout).toContain("PERSONAL_DENIAL_OK label=loopback");
  expect(deniedTargets.stdout).toContain("PERSONAL_DENIAL_OK label=link-local");

  return {
    deniedTargets: ["loopback", "link-local"],
    policyEntryMatchesReviewedPreset: true,
    publicFetchTools: ["curl", "python3"],
    webPorts: [80, 443],
    wildcardBinary: "/**",
  };
}
