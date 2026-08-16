// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { OPENSHELL_V0106_QUALIFICATION } from "../fixtures/openshell-v0106-qualification.ts";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const TLS_SERVER_NAME_REMOVE = "remove(openshell_core::sandbox_env::GATEWAY_TLS_SERVER_NAME);";

export const OPENSHELL_V0106_TLS_SERVER_NAME_SOURCES = Object.freeze([
  {
    blobSha: "c92f05ceac0700ae753902d237d44582e4084af9",
    driver: "docker",
    mergeToken: "environment.extend(user_env.clone());",
    path: "crates/openshell-driver-docker/src/lib.rs",
    removeToken: `environment.${TLS_SERVER_NAME_REMOVE}`,
  },
  {
    blobSha: "df61a13e2d25678f8795f68174d975a144eab304",
    driver: "podman",
    mergeToken: "env.extend(user_env.clone());",
    path: "crates/openshell-driver-podman/src/container.rs",
    removeToken: `env.${TLS_SERVER_NAME_REMOVE}`,
  },
  {
    blobSha: "af914ec467b3300145db8d6e1b6a4d4fc20d9337",
    driver: "vm",
    mergeToken: "environment.extend(user_env.clone());",
    path: "crates/openshell-driver-vm/src/driver.rs",
    removeToken: `environment.${TLS_SERVER_NAME_REMOVE}`,
  },
] as const);

export const OPENSHELL_V0106_TLS_SERVER_NAME_REGRESSIONS = Object.freeze([
  {
    assertionToken: "GATEWAY_TLS_SERVER_NAME must be stripped from the supervisor environment",
    blobSha: "845def5524d6b4f96fce085d99de7fbf9f409464",
    driver: "docker",
    injectionToken: '"evil.attacker.example.com".to_string()',
    path: "crates/openshell-driver-docker/src/tests.rs",
    testToken: "fn build_environment_strips_gateway_tls_server_name()",
  },
  {
    assertionToken: "GATEWAY_TLS_SERVER_NAME must be stripped from the supervisor environment",
    blobSha: "df61a13e2d25678f8795f68174d975a144eab304",
    driver: "podman",
    injectionToken: '"evil.attacker.example.com".to_string()',
    path: "crates/openshell-driver-podman/src/container.rs",
    testToken: "fn build_env_strips_gateway_tls_server_name()",
  },
  {
    assertionToken: "GATEWAY_TLS_SERVER_NAME must be stripped from the guest environment",
    blobSha: "af914ec467b3300145db8d6e1b6a4d4fc20d9337",
    driver: "vm",
    injectionToken: '"evil.attacker.example.com".to_string()',
    path: "crates/openshell-driver-vm/src/driver.rs",
    testToken: "fn build_guest_environment_strips_gateway_tls_server_name()",
  },
] as const);

export interface OpenShellTlsServerNameSource {
  readonly blobSha: string;
  readonly driver: string;
  readonly mergeToken: string;
  readonly path: string;
  readonly removeToken: string;
}

export interface OpenShellTlsServerNameRegression {
  readonly assertionToken: string;
  readonly blobSha: string;
  readonly driver: string;
  readonly injectionToken: string;
  readonly path: string;
  readonly testToken: string;
}

function gitBlobSha(source: string): string {
  const content = Buffer.from(source, "utf8");
  const header = Buffer.from(`blob ${String(content.byteLength)}\0`, "utf8");
  return createHash("sha1").update(header).update(content).digest("hex");
}

async function readBoundedSource(response: Response, driver: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${driver} source response has no body.`);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_SOURCE_BYTES) {
      await reader.cancel();
      throw new Error(`${driver} source exceeds the reviewed byte limit.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function assertTlsServerNameRemovedAfterUserEnvironmentMerge(
  contract: OpenShellTlsServerNameSource,
  source: string,
): void {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error(`${contract.driver} source exceeds the reviewed byte limit.`);
  }
  if (gitBlobSha(source) !== contract.blobSha) {
    throw new Error(`${contract.driver} source does not match its reviewed OpenShell blob.`);
  }
  const mergeIndex = source.indexOf(contract.mergeToken);
  const removeIndex = source.indexOf(contract.removeToken);
  if (mergeIndex < 0 || removeIndex <= mergeIndex) {
    throw new Error(
      `${contract.driver} must remove OPENSHELL_GATEWAY_TLS_SERVER_NAME after merging user environment.`,
    );
  }
}

export function assertTlsServerNameRegressionInjectsAndRejects(
  contract: OpenShellTlsServerNameRegression,
  source: string,
): void {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    throw new Error(`${contract.driver} regression source exceeds the reviewed byte limit.`);
  }
  if (gitBlobSha(source) !== contract.blobSha) {
    throw new Error(`${contract.driver} regression does not match its reviewed OpenShell blob.`);
  }
  const testIndex = source.indexOf(contract.testToken);
  const injectionIndex = source.indexOf(contract.injectionToken, testIndex);
  const assertionIndex = source.indexOf(contract.assertionToken, injectionIndex);
  if (testIndex < 0 || injectionIndex <= testIndex || assertionIndex <= injectionIndex) {
    throw new Error(
      `${contract.driver} regression must inject and reject the TLS server-name override.`,
    );
  }
}

export async function verifyOpenShellTlsServerNameSourceBoundary(
  fetchSource: typeof fetch = fetch,
  contracts: readonly OpenShellTlsServerNameSource[] = OPENSHELL_V0106_TLS_SERVER_NAME_SOURCES,
  regressions: readonly OpenShellTlsServerNameRegression[] = OPENSHELL_V0106_TLS_SERVER_NAME_REGRESSIONS,
): Promise<{
  drivers: Array<{ blobSha: string; driver: string; path: string; status: "passed" }>;
  regressions: Array<{ blobSha: string; driver: string; path: string; status: "passed" }>;
  sourceRevision: string;
  version: string;
}> {
  const drivers: Array<{
    blobSha: string;
    driver: string;
    path: string;
    status: "passed";
  }> = [];
  const verifiedRegressions: Array<{
    blobSha: string;
    driver: string;
    path: string;
    status: "passed";
  }> = [];
  for (const contract of contracts) {
    const url =
      `https://raw.githubusercontent.com/NVIDIA/OpenShell/` +
      `${OPENSHELL_V0106_QUALIFICATION.sourceRevision}/${contract.path}`;
    const response = await fetchSource(url, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(
        `Could not read the exact OpenShell ${contract.driver} source (${String(response.status)}).`,
      );
    }
    const source = await readBoundedSource(response, contract.driver);
    assertTlsServerNameRemovedAfterUserEnvironmentMerge(contract, source);
    drivers.push({
      blobSha: contract.blobSha,
      driver: contract.driver,
      path: contract.path,
      status: "passed" as const,
    });
  }
  for (const regression of regressions) {
    const url =
      `https://raw.githubusercontent.com/NVIDIA/OpenShell/` +
      `${OPENSHELL_V0106_QUALIFICATION.sourceRevision}/${regression.path}`;
    const response = await fetchSource(url, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(
        `Could not read the exact OpenShell ${regression.driver} regression (${String(response.status)}).`,
      );
    }
    const source = await readBoundedSource(response, `${regression.driver} regression`);
    assertTlsServerNameRegressionInjectsAndRejects(regression, source);
    verifiedRegressions.push({
      blobSha: regression.blobSha,
      driver: regression.driver,
      path: regression.path,
      status: "passed" as const,
    });
  }
  return {
    drivers,
    regressions: verifiedRegressions,
    sourceRevision: OPENSHELL_V0106_QUALIFICATION.sourceRevision,
    version: OPENSHELL_V0106_QUALIFICATION.version,
  };
}
