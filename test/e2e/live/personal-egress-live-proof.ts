// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseOpenShellPolicy } from "../../../src/lib/policy/merge.ts";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { HOSTED_INFERENCE_SECRET } from "../fixtures/hosted-inference.ts";
import type { SecretStore } from "../fixtures/secrets.ts";
import { text } from "./common-egress-agent-helpers.ts";
import {
  runPersonalPublicFetchAgentAssertion,
  type PersonalPublicFetchAssertionResult,
} from "./openclaw-agent-assertion.ts";

export const PERSONAL_PUBLIC_FETCH_PR_TARGET = "ubuntu-repo-cloud-openclaw";

export interface PersonalRuntimeEgressEvidence {
  deniedTargets: ["loopback", "link-local"];
  personalPolicyActive: true;
  publicFetchTools: ["curl"];
  searchCredentialsAbsent: true;
}

export interface PersonalPublicFetchEvidence {
  egress: PersonalRuntimeEgressEvidence;
  publicFetch: PersonalPublicFetchAssertionResult;
}

export function requireRegistryTargetSecrets(
  targetId: string,
  requiredSecrets: readonly string[],
  secrets: SecretStore,
): void {
  for (const secret of requiredSecrets) {
    if (targetId === PERSONAL_PUBLIC_FETCH_PR_TARGET && !secrets.optional(secret)) {
      throw new Error(`target '${targetId}' requires E2E secret '${secret}'`);
    }
    secrets.required(secret);
  }
}

export async function verifyPersonalPublicFetchForTarget(
  targetId: string,
  policyTier: string | undefined,
  agent: string,
  sandbox: SandboxClient,
  host: HostCliClient,
  artifacts: ArtifactSink,
  secrets: SecretStore,
  sandboxName: string,
  announcePhase: () => void,
): Promise<PersonalPublicFetchEvidence | undefined> {
  if (targetId !== PERSONAL_PUBLIC_FETCH_PR_TARGET) return undefined;
  expect(policyTier).toBe("personal");
  expect(agent).toBe("openclaw");
  announcePhase();
  const egress = await assertPersonalRuntimeEgress(sandbox, sandboxName, "registry-personal");
  const publicFetch = await runPersonalPublicFetchAgentAssertion(host, sandbox, artifacts, {
    apiKey: secrets.required(HOSTED_INFERENCE_SECRET),
    label: "registry-personal-public-fetch",
    sandboxName,
  });
  return { egress, publicFetch };
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

  const absentSearchCredentials = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      'test -z "${BRAVE_API_KEY:-}" && test -z "${TAVILY_API_KEY:-}" && printf "PERSONAL_SEARCH_CREDENTIALS_ABSENT\\n"',
    ),
    {
      artifactName: `${artifactPrefix}-absent-search-credentials`,
      env: commandEnv(),
      timeoutMs: 30_000,
    },
  );
  expect(absentSearchCredentials.exitCode, text(absentSearchCredentials)).toBe(0);
  expect(absentSearchCredentials.stdout).toContain("PERSONAL_SEARCH_CREDENTIALS_ABSENT");

  phases.beforePublicFetch?.();
  const publicFetch = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(String.raw`
set -eu
curl_bin="$(command -v curl)"
test -n "$curl_bin"
curl_body="$(mktemp)"
trap 'rm -f "$curl_body"' EXIT
"$curl_bin" -fsSL --max-time 30 -o "$curl_body" https://example.com/
grep -Fq 'Example Domain' "$curl_body"
printf 'PERSONAL_PUBLIC_CURL_OK curl=%s\n' "$curl_bin"
`),
    {
      artifactName: `${artifactPrefix}-public-curl`,
      env: commandEnv(),
      timeoutMs: 90_000,
    },
  );
  expect(publicFetch.exitCode, text(publicFetch)).toBe(0);
  expect(publicFetch.stdout).toContain("PERSONAL_PUBLIC_CURL_OK");

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
    personalPolicyActive: true,
    publicFetchTools: ["curl"],
    searchCredentialsAbsent: true,
  };
}
