// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { OPENSHELL_V012_QUALIFICATION } from "../fixtures/openshell-v0116-qualification.ts";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const TLS_SERVER_NAME_REMOVE = "remove(openshell_core::sandbox_env::GATEWAY_TLS_SERVER_NAME);";

export type OpenShellTlsServerNameCheck = {
  readonly category: "driver" | "regression";
  readonly driver: string;
  readonly orderedTokens: readonly string[];
};

export type OpenShellTlsServerNameSource = {
  readonly blobSha: string;
  readonly checks: readonly OpenShellTlsServerNameCheck[];
  readonly path: string;
};

export const OPENSHELL_V0116_TLS_SERVER_NAME_SOURCES: readonly OpenShellTlsServerNameSource[] =
  Object.freeze([
    {
      blobSha: "b1859f54cc1a5505d18af5ff86c70569d288fe73",
      checks: [
        {
          category: "driver",
          driver: "docker",
          orderedTokens: [
            "environment.extend(user_env.clone());",
            `environment.${TLS_SERVER_NAME_REMOVE}`,
          ],
        },
      ],
      path: "crates/openshell-driver-docker/src/lib.rs",
    },
    {
      blobSha: "b52cb87836999de3970da9fbfdc97a2fbc73e908",
      checks: [
        {
          category: "regression",
          driver: "docker",
          orderedTokens: [
            "fn build_environment_strips_gateway_tls_server_name()",
            '"evil.attacker.example.com".to_string()',
            "GATEWAY_TLS_SERVER_NAME must be stripped from the supervisor environment",
          ],
        },
      ],
      path: "crates/openshell-driver-docker/src/tests.rs",
    },
    {
      blobSha: "abb9d69dd21d6e06e243ba92ddb1e7be2c9ed4f5",
      checks: [
        {
          category: "driver",
          driver: "podman",
          orderedTokens: ["env.extend(user_env.clone());", `env.${TLS_SERVER_NAME_REMOVE}`],
        },
        {
          category: "regression",
          driver: "podman",
          orderedTokens: [
            "fn build_env_strips_gateway_tls_server_name()",
            '"evil.attacker.example.com".to_string()',
            "GATEWAY_TLS_SERVER_NAME must be stripped from the supervisor environment",
          ],
        },
      ],
      path: "crates/openshell-driver-podman/src/container.rs",
    },
    {
      blobSha: "13e57f546d0a9a9fc2904b906264994d4087c94b",
      checks: [
        {
          category: "driver",
          driver: "vm",
          orderedTokens: [
            "environment.extend(user_env.clone());",
            `environment.${TLS_SERVER_NAME_REMOVE}`,
          ],
        },
        {
          category: "regression",
          driver: "vm",
          orderedTokens: [
            "fn build_guest_environment_strips_gateway_tls_server_name()",
            '"evil.attacker.example.com".to_string()',
            "GATEWAY_TLS_SERVER_NAME must be stripped from the guest environment",
          ],
        },
      ],
      path: "crates/openshell-driver-vm/src/driver.rs",
    },
  ]);

// Preserve the historical checks above. The split supervisor uses a protected
// child-environment filter; Podman mediates user variables and VM guests receive
// only driver-owned boot metadata. Bind each reviewed implementation and test.
export const OPENSHELL_V012_TLS_SERVER_NAME_SOURCES: readonly OpenShellTlsServerNameSource[] =
  Object.freeze([
    {
      ...OPENSHELL_V0116_TLS_SERVER_NAME_SOURCES[0]!,
      blobSha: "1f4c91f5e4eae31603f49df11955b37abe9710df",
      checks: [
        {
          category: "driver",
          driver: "docker",
          orderedTokens: [
            "fn docker_child_environment(sandbox: &DriverSandbox)",
            "environment.extend(spec.environment.clone());",
            "openshell_core::sandbox_env::GATEWAY_TLS_SERVER_NAME,",
            "environment.remove(protected);",
          ],
        },
      ],
    },
    {
      ...OPENSHELL_V0116_TLS_SERVER_NAME_SOURCES[1]!,
      blobSha: "c5036f45473c3b1af179c60fa41e3c48d1c7c4c2",
      checks: [
        {
          category: "regression",
          driver: "docker",
          orderedTokens: [
            "fn docker_child_environment_strips_supervisor_control_keys()",
            "openshell_core::sandbox_env::GATEWAY_TLS_SERVER_NAME,",
            '.insert(key.to_string(), "spoofed".to_string());',
            "let env = docker_child_environment(&sandbox);",
            'assert!(!env.values().any(|value| value == "spoofed"));',
          ],
        },
      ],
    },
    {
      ...OPENSHELL_V0116_TLS_SERVER_NAME_SOURCES[2]!,
      blobSha: "bb4ee88c9f7010835a56e75a570785b6dfed09b7",
      checks: [
        {
          category: "driver",
          driver: "podman",
          orderedTokens: [
            "user_env.insert(k.clone(), v.clone());",
            "env.insert(openshell_core::sandbox_env::USER_ENVIRONMENT.into(), json);",
            `env.${TLS_SERVER_NAME_REMOVE}`,
          ],
        },
        OPENSHELL_V0116_TLS_SERVER_NAME_SOURCES[2]!.checks[1]!,
      ],
    },
    {
      ...OPENSHELL_V0116_TLS_SERVER_NAME_SOURCES[3]!,
      blobSha: "8cdabb22c5bd087178dd43345980452047248598",
      checks: [
        {
          category: "driver",
          driver: "vm",
          orderedTokens: [
            "fn build_guest_environment(sandbox: &Sandbox, config: &VmDriverConfig)",
            "let mut environment: HashMap<String, String> = HashMap::new();",
            "let mut pairs = environment.into_iter().collect::<Vec<_>>();",
            "fn build_guest_environment_keeps_user_values_in_child_channel()",
            'assert!(!env.iter().any(|entry| entry.starts_with("LD_PRELOAD=")));',
          ],
        },
        OPENSHELL_V0116_TLS_SERVER_NAME_SOURCES[3]!.checks[1]!,
      ],
    },
  ]);

function gitBlobSha(source: string): string {
  const content = Buffer.from(source, "utf8");
  const header = Buffer.from(`blob ${String(content.byteLength)}\0`, "utf8");
  return createHash("sha1").update(header).update(content).digest("hex");
}

async function readBoundedSource(response: Response, path: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${path} response has no body.`);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_SOURCE_BYTES) {
      await reader.cancel();
      throw new Error(`${path} exceeds the reviewed byte limit.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function assertOpenShellTlsServerNameSource(
  reviewedSource: OpenShellTlsServerNameSource,
  source: string,
): void {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error(`${reviewedSource.path} exceeds the reviewed byte limit.`);
  }
  if (gitBlobSha(source) !== reviewedSource.blobSha) {
    throw new Error(`${reviewedSource.path} does not match its reviewed OpenShell blob.`);
  }
  for (const check of reviewedSource.checks) {
    let previousIndex = -1;
    for (const token of check.orderedTokens) {
      const tokenIndex = source.indexOf(token, previousIndex + 1);
      if (tokenIndex < 0) {
        throw new Error(
          `${check.driver} ${check.category} does not preserve the reviewed TLS server-name boundary.`,
        );
      }
      previousIndex = tokenIndex;
    }
  }
}

type VerificationResult = {
  blobSha: string;
  driver: string;
  path: string;
  status: "passed";
};

export async function verifyOpenShellTlsServerNameSourceBoundary(
  fetchSource: typeof fetch = fetch,
  reviewedSources: readonly OpenShellTlsServerNameSource[] = OPENSHELL_V012_TLS_SERVER_NAME_SOURCES,
  qualification: Readonly<{
    sourceRevision: string;
    version: string;
  }> = OPENSHELL_V012_QUALIFICATION,
): Promise<{
  drivers: VerificationResult[];
  regressions: VerificationResult[];
  sourceRevision: string;
  version: string;
}> {
  const drivers: VerificationResult[] = [];
  const regressions: VerificationResult[] = [];
  for (const reviewedSource of reviewedSources) {
    const url =
      `https://raw.githubusercontent.com/NVIDIA/OpenShell/` +
      `${qualification.sourceRevision}/${reviewedSource.path}`;
    const response = await fetchSource(url, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(
        `Could not read the exact OpenShell source ${reviewedSource.path} (${String(response.status)}).`,
      );
    }
    const source = await readBoundedSource(response, reviewedSource.path);
    assertOpenShellTlsServerNameSource(reviewedSource, source);
    for (const check of reviewedSource.checks) {
      const result = {
        blobSha: reviewedSource.blobSha,
        driver: check.driver,
        path: reviewedSource.path,
        status: "passed" as const,
      };
      (check.category === "driver" ? drivers : regressions).push(result);
    }
  }
  return {
    drivers,
    regressions,
    sourceRevision: qualification.sourceRevision,
    version: qualification.version,
  };
}
