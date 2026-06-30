#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const GOOGLE_CHAT_CERT_URL =
  "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat%40system.gserviceaccount.com";
const TEST_PROXY_URL = "http://127.0.0.1:3128";
type GuardedFetchResult = {
  release: () => Promise<void> | void;
  response: Response;
};

type FetchInitWithDispatcher = RequestInit & {
  dispatcher?: { constructor?: { name?: string } } | null;
};

type GuardedFetchParams = {
  auditContext: string;
  fetchImpl: (url: string, init?: FetchInitWithDispatcher) => Promise<Response>;
  lookupFn: () => Promise<never>;
  url: string;
};

type FetchWithSsrFGuard = (params: GuardedFetchParams) => Promise<GuardedFetchResult>;

type RuntimeVerificationResult = {
  blockedTargets: string[];
  dispatcherName: string;
  fetchGuardFile: string;
  googleChatCertProxyWithoutLocalDns: true;
  redirectToPrivateBlocked: true;
};

const BLOCKED_TARGETS: ReadonlyArray<readonly [string, string]> = [
  ["localhost", "http://localhost/"],
  ["IPv4 loopback", "http://127.0.0.1/"],
  ["IPv4 private", "http://10.0.0.1/"],
  ["IPv6 loopback", "http://[::1]/"],
  ["IPv6 link-local", "http://[fe80::1]/"],
  ["IPv6 unique-local", "http://[fd00::1]/"],
];
const PATCH_MARKER = "nemoclaw: default bare guarded fetches to trusted env proxy";
const PROXY_ENV_KEYS: readonly string[] = [
  "OPENSHELL_SANDBOX",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
];

function listJavaScriptFiles(root: string): string[] {
  const files: string[] = [];
  const pending: string[] = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(target);
    }
  }
  return files;
}

function findPatchedFetchGuard(distDirectory: string): string {
  const candidates = listJavaScriptFiles(distDirectory).filter((file) => {
    const source = fs.readFileSync(file, "utf8");
    return (
      source.includes("async function fetchWithSsrFGuard(params)") &&
      source.includes("function resolveGuardedFetchMode(params)")
    );
  });
  assert.equal(
    candidates.length,
    1,
    `expected exactly one compiled fetch guard in ${distDirectory}, found ${candidates.length}`,
  );
  const file = candidates[0];
  assert.match(fs.readFileSync(file, "utf8"), new RegExp(PATCH_MARKER));
  return file;
}

function restoreEnvironment(snapshot: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function isSsrfBlock(error: unknown): boolean {
  return /blocked|private|loopback|special-use/i.test(String(error));
}

async function assertTargetBlocked(
  fetchWithSsrFGuard: FetchWithSsrFGuard,
  label: string,
  url: string,
): Promise<void> {
  let fetchCalls = 0;
  let lookupCalls = 0;
  await assert.rejects(
    () =>
      fetchWithSsrFGuard({
        auditContext: `nemoclaw-build-verification-${label}`,
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response("unexpected fetch");
        },
        lookupFn: async () => {
          lookupCalls += 1;
          throw new Error("unexpected DNS lookup");
        },
        url,
      }),
    isSsrfBlock,
    `${label} must be rejected by the compiled fetch guard`,
  );
  assert.equal(fetchCalls, 0, `${label} reached fetch before SSRF rejection`);
  assert.equal(lookupCalls, 0, `${label} reached DNS before SSRF rejection`);
}

async function verifyGoogleCertProxyPath(fetchWithSsrFGuard: FetchWithSsrFGuard): Promise<string> {
  let fetchCalls = 0;
  let lookupCalls = 0;
  let dispatcherName = "";
  const guarded = await fetchWithSsrFGuard({
    auditContext: "nemoclaw-build-verification-google-chat-cert",
    fetchImpl: async (url, init) => {
      fetchCalls += 1;
      assert.equal(url, GOOGLE_CHAT_CERT_URL);
      assert.equal(init?.redirect, "manual");
      dispatcherName = init?.dispatcher?.constructor?.name ?? "";
      return new Response("certificate", { status: 200 });
    },
    lookupFn: async () => {
      lookupCalls += 1;
      throw new Error("Google certificate fetch attempted local DNS");
    },
    url: GOOGLE_CHAT_CERT_URL,
  });
  try {
    assert.equal(guarded.response.status, 200);
    assert.equal(await guarded.response.text(), "certificate");
  } finally {
    await guarded.release();
  }
  assert.equal(fetchCalls, 1);
  assert.equal(lookupCalls, 0);
  assert.ok(dispatcherName, "Google certificate fetch did not receive a proxy dispatcher");
  return dispatcherName;
}

async function verifyRedirectToPrivateIsBlocked(
  fetchWithSsrFGuard: FetchWithSsrFGuard,
): Promise<void> {
  let fetchCalls = 0;
  let lookupCalls = 0;
  await assert.rejects(
    () =>
      fetchWithSsrFGuard({
        auditContext: "nemoclaw-build-verification-private-redirect",
        fetchImpl: async () => {
          fetchCalls += 1;
          assert.equal(fetchCalls, 1, "private redirect target reached fetch");
          return new Response(null, {
            headers: { location: "http://169.254.169.254/latest/meta-data" },
            status: 302,
          });
        },
        lookupFn: async () => {
          lookupCalls += 1;
          throw new Error("redirect verification attempted local DNS");
        },
        url: GOOGLE_CHAT_CERT_URL,
      }),
    isSsrfBlock,
    "redirect to metadata must be rejected by the compiled fetch guard",
  );
  assert.equal(fetchCalls, 1);
  assert.equal(lookupCalls, 0);
}

export async function verifyOpenClawFetchGuardRuntime(
  distDirectory: string,
): Promise<RuntimeVerificationResult> {
  assert.ok(fs.statSync(distDirectory).isDirectory(), `${distDirectory} is not a directory`);
  const fetchGuardFile = findPatchedFetchGuard(distDirectory);
  const module = (await import(pathToFileURL(fetchGuardFile).href)) as Record<string, unknown>;
  const fetchWithSsrFGuard = Object.values(module).find(
    (value) => typeof value === "function" && value.name === "fetchWithSsrFGuard",
  );
  assert.equal(typeof fetchWithSsrFGuard, "function", "compiled fetch guard export not found");
  const guardedFetch = fetchWithSsrFGuard as FetchWithSsrFGuard;

  const environment = new Map<string, string | undefined>(
    PROXY_ENV_KEYS.map((key): [string, string | undefined] => [key, process.env[key]]),
  );
  process.env.OPENSHELL_SANDBOX = "1";
  process.env.HTTP_PROXY = TEST_PROXY_URL;
  process.env.HTTPS_PROXY = TEST_PROXY_URL;
  process.env.http_proxy = TEST_PROXY_URL;
  process.env.https_proxy = TEST_PROXY_URL;
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;

  try {
    const dispatcherName = await verifyGoogleCertProxyPath(guardedFetch);
    for (const [label, url] of BLOCKED_TARGETS) {
      await assertTargetBlocked(guardedFetch, label, url);
    }
    await verifyRedirectToPrivateIsBlocked(guardedFetch);
    return {
      blockedTargets: BLOCKED_TARGETS.map(([label]) => label),
      dispatcherName,
      fetchGuardFile: path.basename(fetchGuardFile),
      googleChatCertProxyWithoutLocalDns: true,
      redirectToPrivateBlocked: true,
    };
  } finally {
    restoreEnvironment(environment);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const distDirectory = process.argv[2];
  if (!distDirectory) throw new Error("usage: verify-openclaw-fetch-guard-runtime.mjs <dist-dir>");
  const result = await verifyOpenClawFetchGuardRuntime(path.resolve(distDirectory));
  console.log(
    `OpenClaw compiled fetch-guard runtime verification passed: ${JSON.stringify(result)}`,
  );
}
