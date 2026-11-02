// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  patchOpenClawWorkerArchiveModule,
  patchOpenClawWorkerProxy,
  patchOpenClawWorkerProxyText,
} from "../../../scripts/lib/patch-openclaw-worker-proxy.mts";

import {
  OPENCLAW_WORKER_ARCHIVE_SOURCE,
  OPENCLAW_WORKER_PROXY_SOURCE as SOURCE,
} from "../../fixtures/openclaw-worker-proxy";
import {
  OPENCLAW_EXPLICIT_PROXY_GUARD,
  patchOpenClawExplicitProxyText,
} from "../../../scripts/lib/patch-openclaw-explicit-proxy.mts";

import { WORKER_TOOL_CATALOG_SPLIT_SOURCE } from "../../fixtures/openclaw-worker-tool-catalog";

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
  worker: boolean | "archive" = true,
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
    worker === "archive"
      ? patchOpenClawWorkerArchiveModule(OPENCLAW_WORKER_ARCHIVE_SOURCE, "sqlite-store.worker.mjs")
          .text
      : (worker ? patchOpenClawWorkerProxyText : patchOpenClawExplicitProxyText)(SOURCE),
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

describe("OpenClaw 2026.10.5 embedded worker proxy", () => {
  it("preserves direct overrides and native behavior outside OpenShell", async () => {
    const outside = runtime(false, undefined, {}, "archive");
    expect(outside.managed("strict")).toBe(false);
    await expect(
      outside.assertExplicitProxyAllowed({
        mode: "explicit-proxy",
        proxyUrl: "http://10.200.0.1:3128",
      }),
    ).rejects.toThrow("native proxy check");
    const inside = runtime(true, undefined, {}, "archive");
    expect(inside.managed("strict")).toBe(true);
    expect(inside.managed("strict", { mode: "direct" })).toBe(false);
    expect(inside.managed("strict", { mode: "explicit-proxy" })).toBe(false);
    expect(inside.timeout).toBe(60000);
    expect(inside.preflight()).toMatchObject({
      mode: "trusted_env_proxy",
      policy: { hostnameAllowlist: ["inference.local"] },
    });
    expect(inside.namespace.withStrictGuardedFetchMode()({}).mode).toBe("trusted_env_proxy");
  });
  it.each([
    "http://attacker:9",
    "https://10.200.0.1:3128",
    "http://10.200.0.1:3128/other",
    "http://user@10.200.0.1:3128",
  ])("rejects unowned endpoint %s", async (proxyUrl) => {
    await expect(
      runtime(true, undefined, {}, "archive").assertExplicitProxyAllowed({
        mode: "explicit-proxy",
        proxyUrl,
      }),
    ).rejects.toThrow("root-owned OpenShell proxy endpoint");
  });
  it("accepts only the authoritative endpoint", async () => {
    await expect(
      runtime(true, undefined, {}, "archive").assertExplicitProxyAllowed({
        mode: "explicit-proxy",
        proxyUrl: "http://10.200.0.1:3128",
      }),
    ).resolves.toBeUndefined();
    await expect(
      runtime(true, undefined, { uid: 1000 }, "archive").assertExplicitProxyAllowed({
        mode: "explicit-proxy",
        proxyUrl: "http://10.200.0.1:3128",
      }),
    ).rejects.toThrow("root-owned OpenShell proxy endpoint");
  });
  it.each([true, false])("limits the host exception to a trusted proxy request (%s)", (proxy) => {
    const worker = runtime(true, undefined, {}, "archive");
    const policy = {
      hostnameAllowlist: ["host.openshell.internal"],
      allowedHostnames: ["existing"],
    };
    const result = worker.webFetch({ url: "http://host.openshell.internal:8000/", policy }, proxy);
    expect(result.policy.allowedHostnames).toEqual(
      proxy ? ["existing", "host.openshell.internal"] : ["existing"],
    );
    expect(
      worker.webFetch({ url: "http://127.0.0.1/", policy }, true).policy.allowedHostnames,
    ).toEqual(["existing"]);
  });
  it("round-trips restored identity and refuses missing expressions", () => {
    const first = patchOpenClawWorkerArchiveModule(
      OPENCLAW_WORKER_ARCHIVE_SOURCE,
      "sqlite-store.worker.mjs",
    );
    expect(patchOpenClawWorkerArchiveModule(first.text, "sqlite-store.worker.mjs")).toEqual(first);
    expect(() =>
      patchOpenClawWorkerArchiveModule(
        OPENCLAW_WORKER_ARCHIVE_SOURCE.replace(
          "DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS=15e3",
          "DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS=2e4",
        ),
        "sqlite-store.worker.mjs",
      ),
    ).toThrow("Unreviewed worker expression");
    expect(() =>
      patchOpenClawWorkerArchiveModule(OPENCLAW_WORKER_ARCHIVE_SOURCE, "unknown.mjs"),
    ).toThrow("Unreviewed OpenClaw worker archive module");
  });
});

describe("OpenClaw 2026.10.5 archived tool catalog", () => {
  it.each(["embedded", "split"])("preserves llama.cpp dispatch in the %s module", (layout) => {
    const source =
      layout === "embedded" ? OPENCLAW_WORKER_ARCHIVE_SOURCE : WORKER_TOOL_CATALOG_SPLIT_SOURCE;
    const module = layout === "embedded" ? "sqlite-store.worker.mjs" : "worker-chunk-DnMB5DVi.mjs";
    const patched = patchOpenClawWorkerArchiveModule(source, module);
    expect(patchOpenClawWorkerArchiveModule(patched.text, module)).toEqual(patched);
    const env: Record<string, string> = {};
    const record = (value: unknown) =>
      value !== null && typeof value === "object" && !Array.isArray(value);
    const StringType = (options = {}) => ({ type: "string", ...options });
    const RecordType = () => ({ type: "object" });
    const Optional = (schema: unknown) => schema;
    class InputError extends Error {}
    const runtime = vm.runInNewContext(
      patched.text +
        ";({visible:isDirectVisibleCatalogTool,read:readToolSearchCallArgs,schema:toolCallArgsSchema})",
      {
        process: { env },
        classifyTool: (tool: { source: string; sourceName: string }) => tool,
        isCoreCodingSurfaceToolName: (name: string) => name === "read",
        Pt: (name: string) => name === "read",
        asNonArrayRecord: (value: unknown) => (record(value) ? value : {}),
        m: (value: unknown) => (record(value) ? value : {}),
        isRecord$3: record,
        p: record,
        ToolInputError: InputError,
        E: InputError,
        readToolSearchId: (params: { id: string }) => params.id,
        TOOL_SEARCH_SELECTOR_KEYS: ["id"],
        $: ["id"],
        String$2: StringType,
        b: StringType,
        Record: RecordType,
        me: RecordType,
        Unknown: () => ({}),
        he: () => ({}),
        Optional$2: Optional,
        x: Optional,
      },
    );
    const core = { name: "read", source: "openclaw", sourceName: "core" };
    expect(runtime.visible(core, new Set())).toBe(true);
    expect(runtime.schema()).toEqual({ type: "object" });
    expect(runtime.read({ id: "exec", args: '{"command":"pwd"}' }).input).toBe('{"command":"pwd"}');
    env.NEMOCLAW_UPSTREAM_PROVIDER = "llama-cpp-local";
    expect(runtime.visible(core, new Set())).toBe(false);
    expect(runtime.visible(core, new Set(["read"]))).toBe(true);
    expect(runtime.visible({ ...core, source: "mcp" }, new Set(["read"]))).toBe(false);
    expect(runtime.schema()).toEqual({
      type: "string",
      description: "JSON-encoded tool input object.",
    });
    expect(runtime.read({ id: "exec", args: '{"command":"pwd"}', "args.cwd": "/work" })).toEqual({
      id: "exec",
      input: { command: "pwd", cwd: "/work" },
    });
    expect(runtime.read({ id: "exec", args: "{}", command: "pwd" })).toEqual({
      id: "exec",
      input: { command: "pwd" },
    });
    expect(() => runtime.read({ id: "exec", args: "[]" })).toThrow(InputError);
    expect(() => runtime.read({ id: "exec", args: "invalid" })).toThrow(InputError);
  });
});
