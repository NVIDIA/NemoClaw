// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  patchOpenClawWorkerProxy,
  patchOpenClawWorkerProxyText,
} from "../../../scripts/lib/patch-openclaw-worker-proxy.mts";

import { OPENCLAW_WORKER_PROXY_SOURCE as SOURCE } from "../../fixtures/openclaw-worker-proxy";
import {
  OPENCLAW_EXPLICIT_PROXY_GUARD,
  patchOpenClawExplicitProxyText,
} from "../../../scripts/lib/patch-openclaw-explicit-proxy.mts";

interface Runtime {
  namespace: { withStrictGuardedFetchMode(): (value: object) => { mode: string } };
  assertExplicitProxyAllowed(...args: unknown[]): Promise<void>;
  webFetch(
    value: object,
    proxy: boolean,
  ): { mode: string; policy: { allowedHostnames?: string[]; hostnameAllowlist?: string[] } };
  managed(mode: string, dispatcher?: object): boolean;
  preflight(): { mode: string; policy: { hostnameAllowlist: string[] } };
  timeout: number;
}

function runtime(
  sandbox: boolean,
  endpoint = "http://10.200.0.1:3128\n",
  metadata: Record<string, unknown> = {},
  worker = true,
): Runtime {
  const contents = Buffer.from(endpoint);
  const proxyFs = {
    constants: fs.constants,
    openSync(file: string, flags: number) {
      expect(file).toBe("/usr/local/share/nemoclaw/openclaw-proxy-url");
      expect(flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
      return 17;
    },
    fstatSync: () => ({
      isFile: () => true,
      uid: 0,
      gid: 0,
      mode: 0o100444,
      nlink: 1,
      size: contents.length,
      mtimeMs: 1,
      ctimeMs: 1,
      ...metadata,
    }),
    readSync: (_fd: number, buffer: Buffer) => contents.copy(buffer),
    closeSync: vi.fn(),
  };
  return vm.runInNewContext(
    (worker ? patchOpenClawWorkerProxyText : patchOpenClawExplicitProxyText)(SOURCE),
    {
      process: {
        env: {
          ...(sandbox ? { OPENSHELL_SANDBOX: "1" } : {}),
          HTTP_PROXY: "http://attacker:9",
          NEMOCLAW_PROXY_HOST: "attacker",
        },
        getBuiltinModule: () => proxyFs,
      },
      Buffer,
      URL,
    },
  ) as Runtime;
}

describe("OpenClaw 2026.9.5 worker proxy compatibility", () => {
  it("binds the shared guard to exactly one native validator entrypoint", () => {
    const patched = patchOpenClawExplicitProxyText(SOURCE);
    expect(patchOpenClawExplicitProxyText(patched)).toBe(patched);
    expect(() => patchOpenClawExplicitProxyText(SOURCE + SOURCE)).toThrow(/one reviewed/);
    expect(() => patchOpenClawExplicitProxyText("no validator")).toThrow(/one reviewed/);
    expect(() => patchOpenClawExplicitProxyText(OPENCLAW_EXPLICIT_PROXY_GUARD + SOURCE)).toThrow(
      /outside/,
    );
  });
  it("is idempotent and rejects missing, duplicate, and changed expressions", () => {
    const patched = patchOpenClawWorkerProxyText(SOURCE);
    expect(patchOpenClawWorkerProxyText(patched)).toBe(patched);
    expect(() => patchOpenClawWorkerProxyText(SOURCE.replace("15e3", "2e4"))).toThrow(/Unreviewed/);
    expect(() => patchOpenClawWorkerProxyText(SOURCE + SOURCE)).toThrow(/Unreviewed/);
    expect(() =>
      patchOpenClawWorkerProxyText(
        SOURCE.replace("isManagedProxyActive(),", "isManagedProxyActive()&&false,"),
      ),
    ).toThrow(/Unreviewed/);
  });

  it.each([true, false])("allows only the owned proxy with worker=%s", async (worker) => {
    await expect(
      runtime(true, undefined, {}, worker).assertExplicitProxyAllowed({
        mode: "explicit-proxy",
        proxyUrl: "http://10.200.0.1:3128",
      }),
    ).resolves.toBeUndefined();
    await expect(
      runtime(true, "http://custom.internal:3129\n", {}, worker).assertExplicitProxyAllowed({
        mode: "explicit-proxy",
        proxyUrl: "http://custom.internal:3129/",
      }),
    ).resolves.toBeUndefined();
    await expect(
      runtime(false, undefined, {}, worker).assertExplicitProxyAllowed({
        mode: "explicit-proxy",
        proxyUrl: "http://10.200.0.1:3128",
      }),
    ).rejects.toThrow("native proxy check");
  });

  describe.each([true, false])("explicit proxy rejection with worker=%s", (worker) => {
    it.each([
      undefined,
      "invalid",
      "http://10.0.0.1:3128",
      "http://169.254.169.254:3128",
      "http://127.0.0.1:3128",
      "http://public.example:3128",
      "http://attacker:9",
      "http://10.200.0.1:3129",
      "https://10.200.0.1:3128",
      "http://user:secret@10.200.0.1:3128",
      "http://10.200.0.1:3128/path",
      "http://10.200.0.1:3128/?x=1",
      "http://10.200.0.1:3128/#x",
    ])("rejects the unrelated endpoint %s", async (proxyUrl) => {
      await expect(
        runtime(true, undefined, {}, worker).assertExplicitProxyAllowed({
          mode: "explicit-proxy",
          proxyUrl,
        }),
      ).rejects.toThrow("root-owned OpenShell proxy endpoint");
    });
  });

  it.each([
    { uid: 1000 },
    { gid: 1000 },
    { mode: 0o100644 },
    { nlink: 2 },
    { size: 513 },
    { isFile: () => false },
  ])("rejects unsafe proxy authority %j", async (metadata) => {
    await expect(
      runtime(true, undefined, metadata).assertExplicitProxyAllowed({
        mode: "explicit-proxy",
        proxyUrl: "http://10.200.0.1:3128",
      }),
    ).rejects.toThrow("root-owned OpenShell proxy endpoint");
  });

  it.each([
    "",
    "http://10.200.0.1:3128\nextra",
    "http://user:secret@10.200.0.1:3128\n",
    "http://10.200.0.1:99999\n",
  ])("rejects malformed proxy authority %j", async (endpoint) => {
    await expect(
      runtime(true, endpoint).assertExplicitProxyAllowed({
        mode: "explicit-proxy",
        proxyUrl: "http://10.200.0.1:3128",
      }),
    ).rejects.toThrow("root-owned OpenShell proxy endpoint");
  });

  it.each([
    [false, false, "host.openshell.internal"],
    [false, false, "10.0.0.1"],
    [false, false, "public.example"],
    [false, true, "host.openshell.internal"],
    [false, true, "10.0.0.1"],
    [false, true, "public.example"],
    [true, false, "host.openshell.internal"],
    [true, false, "10.0.0.1"],
    [true, false, "public.example"],
    [true, true, "host.openshell.internal"],
    [true, true, "10.0.0.1"],
    [true, true, "public.example"],
  ])("limits sandbox=%s proxy=%s web_fetch exceptions for %s", (sandbox, proxy, hostname) => {
    const policy = {
      allowedHostnames: ["existing.example"],
      hostnameAllowlist: ["host.openshell.internal"],
    };
    const result = runtime(sandbox).webFetch({ url: `http://${hostname}/`, policy }, proxy);
    expect(result.mode).toBe(proxy ? "trusted_env_proxy" : "strict");
    expect([...result.policy.allowedHostnames!]).toEqual(
      sandbox && proxy && hostname === "host.openshell.internal"
        ? ["existing.example", "host.openshell.internal"]
        : ["existing.example"],
    );
    expect(result.policy.hostnameAllowlist).toEqual(policy.hostnameAllowlist);
    expect(policy.allowedHostnames).toEqual(["existing.example"]);
  });

  it.each([false, true])(
    "preserves dispatchers and strict-fetch policy with sandbox=%s",
    (sandbox) => {
      const result = runtime(sandbox);
      expect(result.managed("strict")).toBe(sandbox);
      expect(result.managed("strict", { mode: "direct" })).toBe(false);
      expect(result.managed("strict", { mode: "explicit-proxy" })).toBe(false);
      expect(result.managed("trusted_env_proxy")).toBe(false);
    },
  );

  it("keeps the cron allowlist, media proxy export, and 60 second handshake timeout", () => {
    const result = runtime(true);
    expect(result.preflight().mode).toBe("trusted_env_proxy");
    expect(result.preflight().policy.hostnameAllowlist).toEqual(["inference.local"]);
    expect(result.namespace.withStrictGuardedFetchMode()({}).mode).toBe("trusted_env_proxy");
    expect(result.timeout).toBe(60_000);
  });
});

describe("OpenClaw worker patch file ownership", () => {
  let root: string;
  let dist: string;
  let worker: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-worker-patch-"));
    dist = path.join(root, "dist");
    worker = path.join(dist, "worker", "worker.mjs");
    fs.mkdirSync(path.dirname(worker), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.5" }));
    fs.writeFileSync(worker, SOURCE, { mode: 0o600 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("patches the opened worker and remains idempotent", () => {
    expect(patchOpenClawWorkerProxy(dist)).toBe(true);
    expect(fs.readFileSync(worker, "utf8")).toBe(patchOpenClawWorkerProxyText(SOURCE));
    expect(patchOpenClawWorkerProxy(dist)).toBe(false);
  });

  it("does not write to a replacement pathname after reading the worker", () => {
    const originalRead = fs.readFileSync;
    const openedWorker = path.join(root, "opened-worker.mjs");
    vi.spyOn(fs, "readFileSync")
      .mockImplementationOnce(() => JSON.stringify({ version: "2026.9.5" }))
      .mockImplementationOnce((descriptor) => {
        const contents = originalRead(descriptor, "utf8");
        fs.renameSync(worker, openedWorker);
        fs.writeFileSync(worker, "replacement must remain unchanged");
        return contents;
      });

    expect(patchOpenClawWorkerProxy(dist)).toBe(true);
    expect(fs.readFileSync(worker, "utf8")).toBe("replacement must remain unchanged");
    expect(fs.readFileSync(openedWorker, "utf8")).toBe(patchOpenClawWorkerProxyText(SOURCE));
  });

  it.skipIf(process.platform === "win32")("refuses a symlink without changing its target", () => {
    const target = path.join(root, "target.mjs");
    fs.renameSync(worker, target);
    fs.symlinkSync(target, worker);

    expect(() => patchOpenClawWorkerProxy(dist)).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe(SOURCE);
  });

  it("rejects a missing worker without creating an artifact", () => {
    fs.unlinkSync(worker);
    expect(() => patchOpenClawWorkerProxy(dist)).toThrow(
      "Required OpenClaw 2026.9.5 worker is missing",
    );
    expect(fs.existsSync(worker)).toBe(false);
  });

  it("leaves an unreviewed worker unchanged", () => {
    fs.writeFileSync(worker, "unreviewed worker contents");
    expect(() => patchOpenClawWorkerProxy(dist)).toThrow(/Unreviewed/);
    expect(fs.readFileSync(worker, "utf8")).toBe("unreviewed worker contents");
  });
});
