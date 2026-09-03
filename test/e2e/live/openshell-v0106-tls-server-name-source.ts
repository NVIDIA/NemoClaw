// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { OPENSHELL_V0106_QUALIFICATION } from "../fixtures/openshell-v0106-qualification.ts";

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

export const OPENSHELL_V0106_TLS_SERVER_NAME_SOURCES: readonly OpenShellTlsServerNameSource[] =
  Object.freeze([
    {
      blobSha: "c92f05ceac0700ae753902d237d44582e4084af9",
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
      blobSha: "845def5524d6b4f96fce085d99de7fbf9f409464",
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
      blobSha: "df61a13e2d25678f8795f68174d975a144eab304",
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
      blobSha: "af914ec467b3300145db8d6e1b6a4d4fc20d9337",
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
  reviewedSources: readonly OpenShellTlsServerNameSource[] = OPENSHELL_V0106_TLS_SERVER_NAME_SOURCES,
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
      `${OPENSHELL_V0106_QUALIFICATION.sourceRevision}/${reviewedSource.path}`;
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
    sourceRevision: OPENSHELL_V0106_QUALIFICATION.sourceRevision,
    version: OPENSHELL_V0106_QUALIFICATION.version,
  };
}
