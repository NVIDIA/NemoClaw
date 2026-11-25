// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditOpenClawMcpReliability,
  patchOpenClawMcpReliability,
  patchBundleMcpRuntimeText,
  patchMcpStartupBackoffText,
} from "../../../scripts/patch-openclaw-mcp-reliability.mts";

import { patchOpenClawWorkerArchiveModule } from "../../../scripts/lib/patch-openclaw-worker-proxy.mts";
import {
  OPENCLAW_WORKER_ARCHIVE_SOURCE,
  WORKER_MCP_EMBEDDED_SOURCE,
} from "../../fixtures/openclaw-worker-proxy";

import {
  createHarness,
  runtimeSource,
  backoffSource,
  resetError,
} from "../../support/openclaw-mcp-startup-10.5";

describe.each(["readable", "embedded", "split"] as const)(
  "OpenClaw 10.5 %s MCP startup recovery",
  (layout) => {
    const harness = (options: Parameters<typeof createHarness>[1] = {}) =>
      createHarness(layout, options);
    it("recovers the first catalog using a fresh client within native startup admission", async () => {
      const h = harness({ errors: [resetError()] });
      const runtime = h.create();
      const release = runtime.acquireLease();
      const catalog = await runtime.getCatalog();
      expect(catalog.tools).toHaveLength(1);
      expect(h.connections).toHaveLength(2);
      expect(h.connections[0].client).not.toBe(h.connections[1].client);
      expect(h.connections[0].transport).not.toBe(h.connections[1].transport);
      expect(h.connections.map((entry) => entry.timeoutMs)).toEqual([20000, 10000]);
      expect(h.disposals).toHaveLength(1);
      expect(h.delays).toHaveLength(1);
      expect(h.delays[0]).toBeGreaterThanOrEqual(120);
      expect(h.delays[0]).toBeLessThanOrEqual(300);
      expect(h.resolutions).toEqual(
        Array(2).fill({
          cfg: undefined,
          agentDir: "/agent",
          prepareDataDir: "/owned",
          requesterScope: "requester",
        }),
      );
      release();
      const release2 = runtime.acquireLease();
      expect(await runtime.getCatalog()).toBe(catalog);
      expect(h.connections).toHaveLength(2);
      release2();
      await runtime.dispose();
      await runtime.joinCleanup();
    });

    it("retries an exhausted catalog at the next lease without resetting other owners", async () => {
      const h = harness({ errors: [resetError(), resetError()] });
      const owner = h.create();
      const other = h.create();
      let release = owner.acquireLease();
      const first = await owner.getCatalog();
      expect(first.diagnostics[0].message).toContain("temporary MCP transport failure");
      expect(h.connections).toHaveLength(2);
      const releaseOther = other.acquireLease();
      expect((await other.getCatalog()).diagnostics).toHaveLength(1);
      releaseOther();
      const releaseOther2 = other.acquireLease();
      expect((await other.getCatalog()).diagnostics).toHaveLength(1);
      expect(h.connections).toHaveLength(2);
      releaseOther2();
      release();
      release = owner.acquireLease();
      expect((await owner.getCatalog()).tools).toHaveLength(1);
      expect(h.connections).toHaveLength(3);
      release();
      await Promise.all([owner.dispose(), other.dispose()]);
    });

    it.each([
      new Error("HTTP 401 unauthorized"),
      Object.assign(new Error("certificate rejected"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }),
      new Error("blocked by policy"),
      Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
    ])("does not retry a denied startup: %s", async (error) => {
      const h = harness({ errors: [error] });
      const runtime = h.create();
      const catalog = await runtime.getCatalog();
      expect(h.connections).toHaveLength(1);
      expect(catalog.diagnostics[0].message).toContain(error.message);
      expect(catalog.diagnostics[0].message).not.toContain("temporary MCP transport failure");
      await runtime.dispose();
    });

    it("retains the denial when a transient failure is followed by 401", async () => {
      const h = harness({ errors: [resetError(), new Error("HTTP 401 unauthorized")] });
      const runtime = h.create();
      const catalog = await runtime.getCatalog();
      expect(h.connections).toHaveLength(2);
      expect(catalog.diagnostics[0].message).toContain("401 unauthorized");
      expect(catalog.diagnostics[0].message).not.toContain("temporary MCP transport failure");
      await runtime.dispose();
    });

    it("does not reconnect after uncertain cleanup", async () => {
      const h = harness({ errors: [resetError()], cleanup: "uncertain" });
      const runtime = h.create();
      expect((await runtime.getCatalog()).diagnostics).toHaveLength(1);
      expect(h.connections).toHaveLength(1);
      expect(h.resolutions).toHaveLength(1);
      await runtime.dispose();
      await expect(runtime.joinCleanup()).rejects.toThrow("could not confirm closure");
    });

    it("cancels the delay without constructing another transport", async () => {
      let runtime: ReturnType<ReturnType<typeof harness>["create"]>;
      const h = harness({
        errors: [resetError()],
        onDelay: () => {
          void runtime.dispose();
        },
      });
      runtime = h.create();
      await expect(runtime.getCatalog()).rejects.toThrow("disposed");
      expect(h.connections).toHaveLength(1);
      expect(h.resolutions).toHaveLength(1);
      await runtime.dispose();
      await runtime.joinCleanup();
    });

    it("does not retry stdio or established-session list failures", async () => {
      const stdio = harness({ errors: [resetError()], transportType: "stdio" });
      const runtime = stdio.create();
      expect((await runtime.getCatalog()).diagnostics).toHaveLength(1);
      expect(stdio.connections).toHaveLength(1);
      await runtime.dispose();
      const http = harness();
      const live = http.create();
      await live.getCatalog();
      http.failList(resetError());
      http.invalidate();
      expect((await live.getCatalog()).diagnostics).toHaveLength(1);
      expect(http.connections).toHaveLength(1);
      await live.dispose();
    });

    it("refuses to reset a pending owner and preserves shared admission", async () => {
      const h = harness();
      const controller = new AbortController();
      let finish!: () => void;
      const first = h.context.connectWithMcpStartupBackoff(
        "key",
        controller.signal,
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        1000,
      );
      h.context.resetMcpStartupBackoff("key", controller.signal);
      let entered = false;
      const second = h.context.connectWithMcpStartupBackoff(
        "key",
        new AbortController().signal,
        async () => {
          entered = true;
        },
        1000,
      );
      await Promise.resolve();
      expect(entered).toBe(false);
      finish();
      await Promise.all([first, second]);
      expect(entered).toBe(true);
    });

    it("audits complete payloads and rejects drift in either compiled module", () => {
      const runtime = patchBundleMcpRuntimeText(runtimeSource, "runtime.js");
      expect(patchBundleMcpRuntimeText(runtime.text, "runtime.js").status).toBe("already-patched");
      expect(() =>
        patchBundleMcpRuntimeText(
          runtime.text.replace("|| cleanupFailed", "|| false"),
          "runtime.js",
        ),
      ).toThrow(/partial|ambiguous/);
      expect(() =>
        patchBundleMcpRuntimeText(
          runtime.text.replace('if (outcome === "uncertain")', "if (false)"),
          "runtime.js",
        ),
      ).toThrow(/partial|ambiguous/);
      const manager = patchMcpStartupBackoffText(backoffSource, "manager.mjs");
      expect(patchMcpStartupBackoffText(manager.text, "manager.mjs").status).toBe(
        "already-patched",
      );
      expect(() =>
        patchMcpStartupBackoffText(manager.text.replace("!state.pending", "true"), "manager.mjs"),
      ).toThrow(/unreviewed|partial/);
    });
    it("validates both modules before writing and audits the manager alongside the runtime", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-startup-105-"));
      const dist = path.join(dir, "dist");
      const runtime = path.join(dist, "agents", "agent-bundle-mcp-runtime.js");
      const manager = path.join(dist, "agent-bundle-mcp-manager-api-fixture.mjs");
      try {
        fs.mkdirSync(path.dirname(runtime), { recursive: true });
        fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "2026.10.5" }));
        fs.writeFileSync(runtime, runtimeSource);
        fs.writeFileSync(manager, backoffSource.replace("state.delayMs * 2", "state.delayMs * 3"));
        expect(() => patchOpenClawMcpReliability(dist)).toThrow(/unreviewed/);
        expect(fs.readFileSync(runtime, "utf8")).toBe(runtimeSource);
        fs.writeFileSync(manager, backoffSource);
        expect(patchOpenClawMcpReliability(dist).status).toBe("patched");
        expect(patchOpenClawMcpReliability(dist).status).toBe("already-patched");
        expect(auditOpenClawMcpReliability(dist).version).toBe("2026.10.5");
        const flat = path.join(dir, "flat");
        fs.mkdirSync(flat);
        fs.copyFileSync(
          new URL("../../../scripts/patch-openclaw-mcp-reliability.mts", import.meta.url),
          path.join(flat, "patch.mts"),
        );
        fs.copyFileSync(
          new URL("../../../scripts/lib/openclaw-mcp-retry-payloads.mts", import.meta.url),
          path.join(flat, "openclaw-mcp-retry-payloads.mts"),
        );
        const audit = spawnSync(process.execPath, [path.join(flat, "patch.mts"), "--audit", dist], {
          encoding: "utf8",
        });
        expect(audit.status, audit.stderr).toBe(0);
        expect(audit.stdout).toContain("MCP startup recovery audit ok");

        fs.writeFileSync(manager, backoffSource);
        expect(() => auditOpenClawMcpReliability(dist)).toThrow(/not applied/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);

describe("Archived MCP patch integrity", () => {
  it.each(["sqlite-store.worker.mjs", "worker-chunk-tcAUzPTe.mjs", "worker-chunk-CbW6oavy.mjs"])(
    "restores %s exactly and rejects changed recovery guards",
    (name) => {
      const source = fs.readFileSync(
        new URL(`./fixtures/mcp-worker-${name}.txt`, import.meta.url),
        "utf8",
      );
      const complete =
        name === "sqlite-store.worker.mjs"
          ? OPENCLAW_WORKER_ARCHIVE_SOURCE.replace(WORKER_MCP_EMBEDDED_SOURCE, source)
          : source;
      const first = patchOpenClawWorkerArchiveModule(complete, name);
      expect(patchOpenClawWorkerArchiveModule(first.text, name)).toEqual(first);
      const altered = first.text.replace(
        name === "worker-chunk-CbW6oavy.mjs" ? "!state.pending" : "nemoClawMcpCleanupFailed()",
        "false",
      );
      expect(altered).not.toBe(first.text);
      expect(() => patchOpenClawWorkerArchiveModule(altered, name)).toThrow(
        /Unreviewed worker expression/,
      );
    },
  );
});
