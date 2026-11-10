// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  gatewayDecisionLogpoints,
  observeGatewayDecisions,
  summarizeGatewayDecisions,
  type DecisionPage,
} from "../../../packaging/windows/app/gateway-control-route-decisions.mts";

const source =
  "// fixture\nasync function Qm(e){let t=0,r=()=>lt(e.history.location(),t),s=e=>{if(a)return;};}\nfunction $m(){}";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

describe("compiled gateway first-run decision diagnostics", () => {
  it("pins the source bytes before locating logpoints", () => {
    expect(gatewayDecisionLogpoints(source)).toBeNull();
    const points = gatewayDecisionLogpoints(source, digest(source));
    expect(points).toHaveLength(3);
    expect(points?.map(({ lineNumber }) => lineNumber)).toEqual([1, 1, 1]);
    expect(source.split("\n")[1]?.slice(points?.[0]?.columnNumber)).toMatch(/^let t=/u);
    expect(source.split("\n")[1]?.slice(points?.[1]?.columnNumber)).toMatch(/^if\(a\)/u);
    expect(source.split("\n")[1]?.slice(points?.[2]?.columnNumber)).toMatch(/^lt\(e\.history/u);
    expect(gatewayDecisionLogpoints(source + " ", digest(source))).toBeNull();
  });

  it.each([
    "",
    "async function Qm(e){}function $m(){}",
    "s=e=>{if(a)return;}async function Qm(e){}function $m(){}",
    "async function Qm(e){let t=0,s=e=>{if(a)return;};}function $m(){}",
  ])("rejects a missing decision owner or callback: %s", (value) =>
    expect(gatewayDecisionLogpoints(value, digest(value))).toBeNull(),
  );

  it("records decision predicates without pausing, redirecting, or copying credentials", () => {
    const points = gatewayDecisionLogpoints(source, digest(source));
    const events: unknown[] = [];
    const sameLanding = vi.fn(() => true);
    const eligible = vi.fn(() => true);
    const context = {
      __nemoclawRouteDecisions: events,
      e: { enabled: true, phase: "connected", token: "never-copy-this" },
      a: false,
      r: sameLanding,
      Yt: eligible,
      n: { agentSelection: { state: { selectedId: "main" } } },
      or: () => ({ defaultAgentId: "main", modelConfigured: false }),
    };
    expect(vm.runInNewContext(points?.[0]?.condition ?? "true", context)).toBe(false);
    expect(vm.runInNewContext(points?.[1]?.condition ?? "true", context)).toBe(false);
    expect(events).toEqual([
      { kind: "entry", enabled: true },
      {
        kind: "snapshot",
        phase: "connected",
        alreadyDecided: false,
        eligible: true,
        sameLanding: true,
        selectedIsDefault: true,
        configured: false,
      },
    ]);
    expect(eligible).toHaveBeenCalledWith(context.e, "openclaw.setup.detect", "operator.admin");
    expect(sameLanding).toHaveBeenCalledOnce();
    expect(JSON.stringify(events)).not.toContain("never-copy-this");
  });

  it("bounds logpoint observations and contains diagnostic exceptions", () => {
    const points = gatewayDecisionLogpoints(source, digest(source));
    const events = Array.from({ length: 64 }, () => ({ kind: "entry", enabled: false }));
    expect(
      vm.runInNewContext(points?.[0]?.condition ?? "true", {
        __nemoclawRouteDecisions: events,
        e: { enabled: true },
      }),
    ).toBe(false);
    expect(events).toHaveLength(64);
    expect(
      vm.runInNewContext(points?.[1]?.condition ?? "true", { __nemoclawRouteDecisions: [] }),
    ).toBe(false);
  });

  it.each([
    { field: "pathname", expected: { pathnameEqual: false, searchEqual: true, hashEqual: true } },
    { field: "search", expected: { pathnameEqual: true, searchEqual: false, hashEqual: true } },
    { field: "hash", expected: { pathnameEqual: true, searchEqual: true, hashEqual: false } },
  ])("identifies a changed $field without retaining its value", ({ field, expected }) => {
    const points = gatewayDecisionLogpoints(source, digest(source));
    const original = { pathname: "/chat", search: "", hash: "" };
    const events: unknown[] = [];
    expect(
      vm.runInNewContext(points?.[2]?.condition ?? "true", {
        __nemoclawRouteDecisions: events,
        t: original,
        location: { ...original, [field]: "never-copy-this" },
      }),
    ).toBe(false);
    expect(events).toEqual([{ kind: "location", ...expected }]);
    expect(summarizeGatewayDecisions(events)).toEqual(events);
    expect(JSON.stringify(events)).not.toContain("never-copy-this");
  });

  it("serializes only bounded boolean and categorical evidence", () => {
    expect(summarizeGatewayDecisions(null)).toEqual([]);
    expect(
      summarizeGatewayDecisions([
        null,
        { kind: "unrecognized", token: "never-copy-this" },
        { kind: "entry", enabled: "secret", token: "never-copy-this" },
        {
          kind: "location",
          pathnameEqual: true,
          searchEqual: "never-copy-this",
          hash: "never-copy-this",
        },
        {
          kind: "snapshot",
          phase: "never-copy-this",
          configured: "never-copy-this",
          sameLanding: true,
        },
      ]),
    ).toEqual([
      { kind: "entry", enabled: false },
      { kind: "location", pathnameEqual: true, searchEqual: false, hashEqual: false },
      {
        kind: "snapshot",
        phase: "other",
        alreadyDecided: false,
        eligible: false,
        sameLanding: true,
        selectedIsDefault: false,
        configured: null,
      },
    ]);
    expect(
      summarizeGatewayDecisions(
        Array.from({ length: 65 }, () => ({ kind: "entry", enabled: true })),
      ),
    ).toHaveLength(64);
  });

  it("reports an unsupported UI without attaching a debugger", async () => {
    const connect = vi.fn();
    const page = {
      addInitScript: vi.fn(),
      evaluate: vi.fn(async () => []),
      context: () => ({ newCDPSession: connect }),
    } as unknown as DecisionPage;
    const observer = await observeGatewayDecisions(page, null);
    expect(await observer.finish()).toEqual({
      supported: false,
      installed: 0,
      unexpectedPauses: 0,
      failed: false,
      events: [],
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    {
      mode: "success",
      configure: () => ({
        send: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
        evaluate: vi
          .fn()
          .mockResolvedValue([{ kind: "entry", enabled: true, token: "never-copy-this" }]),
      }),
      installed: 3,
      failed: false,
    },
    {
      mode: "install-failure",
      configure: () => ({
        send: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(Error("private diagnostic detail")),
        detach: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue([]),
      }),
      installed: 0,
      failed: true,
    },
    {
      mode: "read-failure",
      configure: () => ({
        send: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockRejectedValue(Error("private diagnostic detail")),
      }),
      installed: 3,
      failed: true,
    },
    {
      mode: "detach-failure",
      configure: () => ({
        send: vi.fn().mockResolvedValue(undefined),
        detach: vi.fn().mockRejectedValue(Error("private diagnostic detail")),
        evaluate: vi
          .fn()
          .mockResolvedValue([{ kind: "entry", enabled: true, token: "never-copy-this" }]),
      }),
      installed: 3,
      failed: true,
    },
  ])(
    "detaches the owned diagnostic session after $mode",
    async ({ configure, installed, failed }) => {
      const { send, detach, evaluate } = configure();
      const page = {
        addInitScript: vi.fn(async () => {}),
        evaluate,
        context: () => ({ newCDPSession: async () => ({ send, detach, on: vi.fn() }) }),
      } as unknown as DecisionPage;
      const observer = await observeGatewayDecisions(
        page,
        gatewayDecisionLogpoints(source, digest(source)),
      );
      const result = await observer.finish();
      expect(result.supported).toBe(true);
      expect(result.installed).toBe(installed);
      expect(result.failed).toBe(failed);
      expect(result.unexpectedPauses).toBe(0);
      expect(detach).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith("Debugger.enable");
      expect(JSON.stringify(result)).not.toMatch(/private diagnostic detail|never-copy-this/u);
    },
  );
});
