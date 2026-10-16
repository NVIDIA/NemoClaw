// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileIdentity, errorDetail } from "./probe-component-workload.mts";
import { personalCommand } from "./probe-personal-workload.mts";
import { hermesBrowserBootstrapPythonSource } from "../runtime/native-hermes-browser-bootstrap.mts";
import {
  startNativeEdgeBrowser,
  verifyNativeEdgeIdentityLauncher,
  type NativeEdgeBrowserOwner,
  type NativeEdgeIdentityLauncher,
} from "../runtime/native-edge-browser.mts";
import { startNativeBrokerRelay } from "../runtime/native-broker-relay.mts";

export const PERSONAL_BROWSER_PIPE_PORT = 8124;
export const PERSONAL_BROWSER_WORKER_FILES = [
  "native-broker-tunnel.mts",
  "native-broker-relay-protocol.mts",
  "native-local-pipe.mts",
] as const;

export function personalBrowserEnvironment(options: {
  runtime: string;
  controller: string;
  state: string;
  nonce: string;
  relayToken: string;
  cdpPath: string;
  bootstrapSha256: string;
}) {
  const { runtime, controller, state, nonce, relayToken, cdpPath, bootstrapSha256 } = options;
  assert.match(runtime, /^[A-Z]:\\NemoClawHermesProbe-[a-f0-9]{12}$/u);
  assert.match(nonce, /^[a-f0-9]{24}$/u);
  assert.equal(
    controller,
    path.win32.join(path.win32.parse(runtime).root, `NemoClawPersonalNode-${nonce.slice(0, 12)}`),
  );
  assert.match(state, /^[A-Z]:\\NemoClawState-S-1-(?:\d+-)*\d+-hermes$/u);
  assert.equal(path.win32.parse(state).root, path.win32.parse(runtime).root);
  assert.match(relayToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(cdpPath, /^\/devtools\/browser\/[A-Za-z0-9-]{1,128}$/u);
  assert.match(bootstrapSha256, /^[a-f0-9]{64}$/u);
  const endpoint = `ws://127.0.0.1:${PERSONAL_BROWSER_PIPE_PORT}${cdpPath}`;
  // This renderer fixture needs no network access or private-URL exception.
  const page = `<!doctype html><title>Hermes Personal proof</title><p id="sentinel">${nonce}</p>`;
  return {
    NEMOCLAW_PERSONAL_BROWSER_SESSION: nonce,
    NEMOCLAW_PERSONAL_BROWSER_BOOTSTRAP_SHA256: bootstrapSha256,
    NEMOCLAW_PERSONAL_BROWSER_PAGE: `data:text/html;base64,${Buffer.from(page).toString("base64")}`,
    NEMOCLAW_WORKER_ROOT: path.win32.join(controller, "workers"),
    NEMOCLAW_BROWSER_RELAY_ROOT: path.win32.join(state, `browser-relay-${nonce}`),
    NEMOCLAW_BROWSER_RELAY_TOKEN: relayToken,
    NEMOCLAW_HERMES_BROWSER_PIPE_PORT: String(PERSONAL_BROWSER_PIPE_PORT),
    NEMOCLAW_BROWSER_CDP_PATH: cdpPath,
    NEMOCLAW_AGENT_SESSION_ID: nonce.slice(0, 10),
    BROWSER_CDP_URL: endpoint,
    BU_CDP_WS: endpoint,
  };
}

export type PersonalBrowserOwner = { close(): Promise<void> };

export async function startPersonalNativeBrowser(options: {
  runtime: string;
  controller: string;
  state: string;
  scratch: string;
  nonce: string;
  python: string;
  identityLauncher: NativeEdgeIdentityLauncher;
  environment: NodeJS.ProcessEnv;
  receipt: Record<string, unknown>;
  onOwner(owner: PersonalBrowserOwner): void;
}) {
  const { receipt, environment, nonce } = options;
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "arm64");
  assert.equal(environment.GITHUB_ACTIONS, "true");
  assert.equal(environment.NEMOCLAW_RUNTIME_JOB_OWNED, "1");
  assert.match(environment.NEMOCLAW_PERSONAL_HOST_OWNER ?? "", /^[a-f0-9]{24}$/u);
  verifyNativeEdgeIdentityLauncher(options.identityLauncher);
  Object.assign(receipt, {
    schemaVersion: 1,
    classification: "personal-native-edge-browser",
    nonce,
    runtime: options.runtime,
    identityLauncher: options.identityLauncher,
    transport: "guarded-file-native-pipe",
    generalHostProxy: false,
    pageKind: "inline-html",
    closed: false,
    cleanupErrors: [],
  });
  let edgeOwner: NativeEdgeBrowserOwner | undefined;
  let relay: Awaited<ReturnType<typeof startNativeBrokerRelay>> | undefined;
  let compilerClosed = true;
  let unhealthy: unknown;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const errors: unknown[] = [];
      if (!compilerClosed) errors.push({ bootstrapCompiler: "Process closure is unconfirmed" });
      for (const [name, operation] of [
        ["relayClosed", () => relay?.close()],
        ["edgeClosed", () => edgeOwner?.close()],
        ["relayOwnerClosed", () => relay?.dispose()],
      ] as const) {
        try {
          await operation();
          receipt[name] = true;
        } catch (error) {
          receipt[name] = false;
          errors.push(errorDetail(error));
        }
      }
      receipt.cleanupErrors = errors;
      receipt.closed = errors.length === 0;
      if (errors.length)
        throw new Error("Personal browser ownership did not close; retain its roots.");
    })());
  options.onOwner({ close });
  try {
    const workers = path.join(options.controller, "workers");
    fs.mkdirSync(workers);
    const sources = PERSONAL_BROWSER_WORKER_FILES.map((name) => {
      const source = fileURLToPath(new URL(`../runtime/${name}`, import.meta.url));
      const before = fileIdentity(source);
      const destination = path.join(workers, name);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      const staged = fileIdentity(destination);
      assert.equal(staged.bytes, before.bytes);
      assert.equal(staged.sha256, before.sha256);
      return { file: name, source: before, staged };
    });
    const bootstrap = path.join(workers, "hermes-browser-bootstrap.py");
    fs.writeFileSync(bootstrap, hermesBrowserBootstrapPythonSource(), { flag: "wx" });
    const source = fileIdentity(bootstrap);
    const compiled = bootstrap + "c";
    compilerClosed = false;
    const compilation = await personalCommand(
      options.python,
      [
        "-I",
        "-B",
        "-c",
        "import py_compile,sys; assert sys.version_info[:3] == (3,11,16); py_compile.compile(sys.argv[1],cfile=sys.argv[2],doraise=True,invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)",
        bootstrap,
        compiled,
      ],
      environment,
      workers,
      15_000,
    );
    compilerClosed = compilation.childClosed;
    receipt.bootstrapCompilation = compilation;
    assert.equal(compilation.exitCode, 0);
    assert.equal(compilation.childClosed, true);
    assert.equal(compilation.timedOut, false);
    assert.equal(compilation.outputExceeded, false);
    assert.equal(compilation.error, null);
    const bytecode = fileIdentity(compiled);
    fs.unlinkSync(bootstrap);
    receipt.bootstrap = { source, bytecode, workers: sources };
    const edge = await startNativeEdgeBrowser({
      profileRoot: path.join(options.scratch, "edge-profile"),
      environment,
      identityLauncher: options.identityLauncher,
      onOwner: (owner) => {
        edgeOwner = owner;
      },
    });
    void edge.failure.catch((error) => {
      unhealthy ??= error;
    });
    Object.assign(receipt, {
      identity: edge.identity,
      process: edge.process,
      endpoint: edge.endpoint,
      inheritedKillOnCloseJob: edge.inheritedKillOnCloseJob,
    });
    const selected = personalBrowserEnvironment({
      ...options,
      relayToken: randomBytes(32).toString("base64url"),
      cdpPath: edge.endpoint.path,
      bootstrapSha256: bytecode.sha256,
    });
    // The native owner creates the relay root with its protected private DACL.
    relay = await startNativeBrokerRelay({
      relayRoot: selected.NEMOCLAW_BROWSER_RELAY_ROOT,
      relayToken: selected.NEMOCLAW_BROWSER_RELAY_TOKEN,
      brokerPort: edge.endpoint.port,
      launcher: options.identityLauncher.path,
    });
    void relay.failure.catch((error) => {
      unhealthy ??= error;
    });
    receipt.pageUrl = selected.NEMOCLAW_PERSONAL_BROWSER_PAGE;
    receipt.relayRoot = selected.NEMOCLAW_BROWSER_RELAY_ROOT;
    return {
      environment: selected,
      assertHealthy() {
        receipt.relay = relay!.diagnostics();
        if (unhealthy) throw unhealthy;
        verifyNativeEdgeIdentityLauncher(options.identityLauncher);
        assert.equal(fileIdentity(compiled).sha256, bytecode.sha256);
        for (const worker of sources)
          assert.equal(fileIdentity(worker.staged.path).sha256, worker.staged.sha256);
      },
      close,
    };
  } catch (error) {
    receipt.error = errorDetail(error);
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Personal browser startup and cleanup failed.");
    }
    throw error;
  }
}
