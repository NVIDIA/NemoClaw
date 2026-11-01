// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import {
  gatewayBrowserConsoleFailure,
  gatewayBrowserMajorVersion,
  gatewayBrowserRoute,
  installGatewayBrowserRouteTrace,
  readGatewayBrowserRouteTrace,
  summarizeGatewayBrowserRouteTrace,
  summarizeGatewayHello,
} from "../../../packaging/windows/app/gateway-control-browser-diagnostics.mts";

describe("compiled gateway browser diagnostics", () => {
  it.each([
    ["[openclaw] application start failed: secret", "application-start"],
    ["[openclaw] initial session location failed: secret", "initial-location"],
    ["[openclaw] route navigation failed: secret", "route-navigation"],
    ["[gateway] snapshot handler error: secret", "gateway-snapshot"],
    ["private error with secret", "other"],
  ])("classifies caught console errors without retaining details %#", (message, expected) => {
    expect(gatewayBrowserConsoleFailure(message)).toBe(expected);
  });
  it("retains routing predicates without copying tokens or configuration", () => {
    const secret = "fixture-secret-never-publish";
    const summary = summarizeGatewayHello({
      type: "res",
      ok: true,
      id: secret,
      payload: {
        type: "hello-ok",
        auth: { scopes: ["operator.admin"], deviceToken: secret },
        features: { methods: ["openclaw.setup.detect", secret] },
        snapshot: {
          configPath: secret,
          sessionDefaults: {
            defaultAgentId: "main",
            ownership: "sole",
            selectionRequired: false,
            modelConfigured: false,
            mainSessionKey: secret,
          },
        },
      },
    });
    expect(summary).toEqual({
      defaultAgentIsMain: true,
      soleAgent: true,
      modelConfigured: false,
      selectionRequired: false,
      setupDetectionAvailable: true,
      adminScope: true,
    });
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  it.each([null, [], "secret", { type: "res", ok: false }, { type: "req", ok: true }])(
    "ignores a non-hello message %#",
    (message) => expect(summarizeGatewayHello(message)).toBeNull(),
  );

  it("distinguishes omitted routing predicates from explicit false values", () => {
    expect(summarizeGatewayHello({ type: "res", ok: true, payload: { type: "hello-ok" } })).toEqual(
      {
        defaultAgentIsMain: false,
        soleAgent: false,
        modelConfigured: null,
        selectionRequired: null,
        setupDetectionAvailable: false,
        adminScope: false,
      },
    );
  });

  it.each([
    ["http://127.0.0.1/chat#token=secret", "chat-root"],
    ["http://127.0.0.1/chat/private-session?secret=1", "chat-session"],
    ["http://127.0.0.1/settings/model-setup?firstRun=1#token=secret", "model-setup"],
    ["http://127.0.0.1/settings/plugins", "plugins"],
    ["http://127.0.0.1/private-path", "other"],
    ["not a URL", "unavailable"],
  ])("classifies route %# without retaining the URL", (url, expected) => {
    expect(gatewayBrowserRoute(url)).toBe(expected);
  });

  it.each([
    ["151.0.7922.34", 151],
    ["0.1", null],
    ["999999999999999999999999.0", null],
    ["private browser message", null],
  ])("retains only the numeric browser major version %#", (input, expected) => {
    expect(gatewayBrowserMajorVersion(String(input))).toBe(expected);
  });
});

describe("compiled gateway navigation diagnostics", () => {
  it("records early gateway state without retaining payloads or changing the gateway", async () => {
    const secret = "early-state-secret-never-publish";
    const events = new Map<string, () => void>();
    let listener: (value: unknown) => void = () => {
      throw new Error("Observer missing");
    };
    let unsubscribed = false;
    const context = {
      gateway: {
        snapshot: { phase: "connecting", client: { secret } },
        subscribe: (callback: typeof listener) => {
          listener = callback;
          return () => {
            unsubscribed = true;
          };
        },
      },
      agentSelection: { state: { selectedId: "main" } },
    };
    const scope = {
      location: { pathname: "/chat" },
      history: { pushState: () => {}, replaceState: () => {} },
      document: { querySelector: () => ({ context }) },
      customElements: { whenDefined: () => Promise.resolve() },
      addEventListener: (name: string, callback: () => void) => events.set(name, callback),
    };
    runInNewContext(`(${installGatewayBrowserRouteTrace.toString()})()`, scope);
    await Promise.resolve();
    listener({
      phase: "connected",
      client: { secret },
      hello: {
        auth: { role: "operator", scopes: ["operator.admin"], token: secret },
        features: { methods: ["openclaw.setup.detect"] },
        snapshot: {
          sessionDefaults: { defaultAgentId: "main", modelConfigured: false, sessionKey: secret },
        },
      },
    });
    const summary = summarizeGatewayBrowserRouteTrace(
      runInNewContext(`(${readGatewayBrowserRouteTrace.toString()})()`, scope),
    );
    expect(summary.gatewayObserved).toBe(true);
    expect(summary.observerFailed).toBe(false);
    expect(summary.snapshots).toEqual([
      {
        phase: "connecting",
        route: "chat-root",
        hasHello: false,
        hasClient: true,
        operatorRole: false,
        setupDetectionAvailable: false,
        adminScope: false,
        selectedIsDefault: null,
        modelConfigured: null,
      },
      {
        phase: "connected",
        route: "chat-root",
        hasHello: true,
        hasClient: true,
        operatorRole: true,
        setupDetectionAvailable: true,
        adminScope: true,
        selectedIsDefault: true,
        modelConfigured: false,
      },
    ]);
    expect(context.gateway.snapshot.phase).toBe("connecting");
    expect(JSON.stringify(summary)).not.toContain(secret);
    events.get("pagehide")?.();
    expect(unsubscribed).toBe(true);
  });

  it("bounds early snapshots and reports malformed observer inputs without throwing", async () => {
    let listener: (value: unknown) => void = () => {
      throw new Error("Observer missing");
    };
    const scope = {
      location: { pathname: "/chat" },
      history: { pushState: () => {}, replaceState: () => {} },
      document: {
        querySelector: () => ({
          context: {
            gateway: {
              subscribe: (callback: typeof listener) => {
                listener = callback;
                return () => {};
              },
            },
          },
        }),
      },
      customElements: { whenDefined: () => Promise.resolve() },
      addEventListener: () => {},
    };
    runInNewContext(`(${installGatewayBrowserRouteTrace.toString()})()`, scope);
    await Promise.resolve();
    expect(() => listener(null)).not.toThrow();
    runInNewContext(
      'globalThis.__nemoclawRouteTrace.snapshots.push(...Array(63).fill({ phase: "other" }))',
      scope,
    );
    listener({ phase: "private-state" });
    listener({ phase: "private-state" });
    const summary = summarizeGatewayBrowserRouteTrace(
      runInNewContext(`(${readGatewayBrowserRouteTrace.toString()})()`, scope),
    );
    expect(summary.snapshots).toHaveLength(64);
    expect(summary.snapshotsTruncated).toBe(true);
    expect(summary.observerFailed).toBe(true);
    expect(summary.snapshots.every((value) => value.phase === "other")).toBe(true);
  });
  it.each(["starting", "reconnecting", "offline"])(
    "retains the gateway %s phase through serialization and sanitization",
    async (phase) => {
      const scope = {
        location: { pathname: "/chat" },
        history: { pushState: () => {}, replaceState: () => {} },
        document: {
          querySelector: () => ({
            context: {
              gateway: { snapshot: { phase }, subscribe: () => () => {} },
            },
          }),
        },
        customElements: { whenDefined: () => Promise.resolve() },
        addEventListener: () => {},
      };
      runInNewContext(`(${installGatewayBrowserRouteTrace.toString()})()`, scope);
      await Promise.resolve();
      const summary = summarizeGatewayBrowserRouteTrace(
        runInNewContext(`(${readGatewayBrowserRouteTrace.toString()})()`, scope),
      );
      expect(summary.snapshots).toHaveLength(1);
      expect(summary.snapshots[0].phase).toBe(phase);
      expect(summary.observerFailed).toBe(false);
    },
  );
  it("observes route changes without changing history results or copying URLs", () => {
    const secret = "navigation-secret-never-publish";
    const location = { pathname: "/chat" };
    const events = new Map<string, () => void>();
    const historyCall = (data: unknown, _unused: string, url: string) => {
      location.pathname = new URL(url, "http://127.0.0.1").pathname;
      return data;
    };
    const scope = {
      location,
      history: { pushState: historyCall, replaceState: historyCall },
      addEventListener: (name: string, listener: () => void) => {
        const previous = events.get(name);
        events.set(name, () => {
          previous?.();
          listener();
        });
      },
      document: { querySelector: () => null },
    };
    runInNewContext(`(${installGatewayBrowserRouteTrace.toString()})()`, scope);
    expect(scope.history.replaceState(42, secret, `/settings/model-setup#token=${secret}`)).toBe(
      42,
    );
    expect(scope.history.pushState(43, secret, `/chat/${secret}?token=${secret}`)).toBe(43);
    expect(() => scope.history.pushState(0, secret, "http://[")).toThrow(TypeError);
    location.pathname = "/private-path";
    events.get("popstate")?.();
    const summary = summarizeGatewayBrowserRouteTrace(
      runInNewContext(`(${readGatewayBrowserRouteTrace.toString()})()`, scope),
    );
    expect(summary.routes).toEqual(["chat-root", "model-setup", "chat-session", "other"]);
    expect(summary.truncated).toBe(false);
    expect(summary.selectedIsDefault).toBeNull();
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  it("distinguishes history cleanup from a restored fragment without retaining credentials", () => {
    const secret = "fragment-secret-never-publish";
    const location = { pathname: "/chat", hash: `#token=${secret}`, search: "" };
    const events = new Map<string, () => void>();
    const scope = {
      location,
      history: {
        pushState: () => {},
        replaceState: (value: number) => {
          location.hash = "";
          return value;
        },
      },
      addEventListener: (name: string, listener: () => void) => events.set(name, listener),
      document: { querySelector: () => null },
    };
    runInNewContext(`(${installGatewayBrowserRouteTrace.toString()})()`, scope);
    expect(scope.history.replaceState(42)).toBe(42);
    events.get("DOMContentLoaded")?.();
    location.hash = `#token=${secret}`;
    location.search = `?openclaw_mount_recovery=123&private=${secret}`;
    events.get("hashchange")?.();
    events.get("load")?.();
    events.get("openclaw-control-ui-rendered")?.();
    const summary = summarizeGatewayBrowserRouteTrace(
      runInNewContext(`(${readGatewayBrowserRouteTrace.toString()})()`, scope),
    );
    expect(summary.fragmentEvents).toEqual([
      {
        event: "initial",
        present: true,
        equalsInitial: true,
        changed: false,
        mountRecovery: false,
      },
      {
        event: "replaceState",
        present: false,
        equalsInitial: false,
        changed: true,
        mountRecovery: false,
      },
      {
        event: "DOMContentLoaded",
        present: false,
        equalsInitial: false,
        changed: false,
        mountRecovery: false,
      },
      {
        event: "hashchange",
        present: true,
        equalsInitial: true,
        changed: true,
        mountRecovery: true,
      },
      { event: "load", present: true, equalsInitial: true, changed: false, mountRecovery: true },
      {
        event: "openclaw-control-ui-rendered",
        present: true,
        equalsInitial: true,
        changed: false,
        mountRecovery: true,
      },
    ]);
    expect(summary.routes).toEqual(["chat-root"]);
    expect(summary.fragmentsTruncated).toBe(false);
    expect(JSON.stringify(summary)).not.toContain(secret);
    expect(location.hash).toBe(`#token=${secret}`);
    // Seed prior observations, then exercise the last admitted and first rejected event.
    runInNewContext(
      'globalThis.__nemoclawRouteTrace.fragmentEvents.push(...Array(57).fill({ event: "load" }))',
      scope,
    );
    events.get("hashchange")?.();
    location.hash = "";
    events.get("hashchange")?.();
    const bounded = summarizeGatewayBrowserRouteTrace(
      runInNewContext(`(${readGatewayBrowserRouteTrace.toString()})()`, scope),
    );
    expect(bounded.fragmentEvents).toHaveLength(64);
    expect(bounded.fragmentsTruncated).toBe(true);
    expect(bounded.fragmentEvents.at(-1)).toEqual({
      event: "hashchange",
      present: true,
      equalsInitial: true,
      changed: false,
      mountRecovery: true,
    });
  });

  it.each([
    { label: "null", ignored: null },
    { label: "string", ignored: "worker-secret-never-publish" },
    { label: "unknown type", ignored: { type: "worker-secret-never-publish" } },
    { label: "non-string type", ignored: { type: { toString: (): string => "sw-updated" } } },
  ])("observes worker activation without responding or retaining $label data", ({ ignored }) => {
    const secret = "worker-secret-never-publish";
    const events = new Map<string, (event: { data?: unknown }) => void>();
    const location = { pathname: "/chat", search: "", hash: "" };
    const scope = {
      location,
      history: { pushState: () => {}, replaceState: () => {} },
      addEventListener: () => {},
      document: { querySelector: () => null },
      navigator: {
        serviceWorker: {
          addEventListener: (name: string, listener: (event: { data?: unknown }) => void) =>
            events.set(name, listener),
        },
      },
    };
    runInNewContext(`(${installGatewayBrowserRouteTrace.toString()})()`, scope);
    events.get("controllerchange")?.({});
    const probe = {
      data: { type: "sw-version-probe", version: secret, url: secret },
      get ports() {
        throw new Error("The observer must not access message ports.");
      },
    };
    events.get("message")?.(probe);
    location.hash = `#token=${secret}`;
    events.get("message")?.({ data: { type: "sw-updated", version: secret } });
    events.get("message")?.({ data: ignored });
    const summary = summarizeGatewayBrowserRouteTrace(
      runInNewContext(`(${readGatewayBrowserRouteTrace.toString()})()`, scope),
    );
    expect(summary.fragmentEvents.map((event) => event.event)).toEqual([
      "initial",
      "sw-controllerchange",
      "sw-version-probe",
      "sw-updated",
    ]);
    expect(summary.fragmentEvents.at(-1)).toMatchObject({ present: true, changed: true });
    expect(summary.observerFailed).toBe(false);
    expect(probe.data).toEqual({ type: "sw-version-probe", version: secret, url: secret });
    expect(location.hash).toBe(`#token=${secret}`);
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  it("contains worker observer registration failures without blocking route capture", () => {
    const scope = {
      location: { pathname: "/chat" },
      history: { pushState: () => {}, replaceState: () => {} },
      addEventListener: () => {},
      document: { querySelector: () => null },
      navigator: {
        get serviceWorker() {
          throw new Error("private-worker-error");
        },
      },
    };
    runInNewContext(`(${installGatewayBrowserRouteTrace.toString()})()`, scope);
    const summary = summarizeGatewayBrowserRouteTrace(
      runInNewContext(`(${readGatewayBrowserRouteTrace.toString()})()`, scope),
    );
    expect(summary.observerFailed).toBe(true);
    expect(summary.routes).toEqual(["chat-root"]);
    expect(JSON.stringify(summary)).not.toContain("private-worker-error");
  });

  it("bounds retained navigation history", () => {
    const scope = {
      location: { pathname: "/chat" },
      history: {
        pushState: () => {},
        replaceState: () => {},
      },
      addEventListener: () => {},
      document: { querySelector: () => null },
    };
    runInNewContext(`(${installGatewayBrowserRouteTrace.toString()})()`, scope);
    // Seed prior observations, then cross the limit through actual history calls.
    runInNewContext(
      'globalThis.__nemoclawRouteTrace.routes.push(...Array(62).fill("plugins"))',
      scope,
    );
    scope.location.pathname = "/settings/model-setup";
    scope.history.pushState();
    scope.location.pathname = "/chat";
    scope.history.pushState();
    const summary = summarizeGatewayBrowserRouteTrace(
      runInNewContext(`(${readGatewayBrowserRouteTrace.toString()})()`, scope),
    );
    expect(summary.routes).toHaveLength(64);
    expect(summary.truncated).toBe(true);
  });

  it.each([
    [undefined, true],
    ["main", true],
    [" main ", true],
    ["private-agent", false],
  ])(
    "projects selected-agent equality without copying the identity: %#",
    (selectedId, expected) => {
      const secret = "snapshot-secret-never-publish";
      const scope = {
        document: {
          querySelector: () => ({
            context: {
              gateway: {
                snapshot: {
                  phase: "connected",
                  client: { token: secret },
                  hello: {
                    auth: { role: "operator", token: secret },
                    snapshot: { sessionDefaults: { defaultAgentId: "main" } },
                  },
                },
              },
              agentSelection: { state: { selectedId } },
            },
          }),
        },
      };
      const summary = summarizeGatewayBrowserRouteTrace(
        runInNewContext(`(${readGatewayBrowserRouteTrace.toString()})()`, scope),
      );
      expect(summary).toMatchObject({
        connected: true,
        hasClient: true,
        operatorRole: true,
        selectedIsDefault: expected,
      });
      expect(JSON.stringify(summary)).not.toContain(secret);
      expect(JSON.stringify(summary)).not.toContain("private-agent");
    },
  );

  it("rejects unrecognized page-supplied trace values", () => {
    const summary = summarizeGatewayBrowserRouteTrace({
      trace: {
        routes: ["chat-root", "secret", { token: "secret" }, ...Array(100).fill("plugins")],
        truncated: "secret",
        snapshots: [
          {
            phase: { token: "secret", toString: () => "connected" },
            route: "secret",
            hasHello: "secret",
            modelConfigured: "secret",
            selectedIsDefault: { token: "secret" },
          },
          ...Array(70).fill({ token: "secret" }),
        ],
        gatewayObserved: "secret",
        observerFailed: "secret",
        snapshotsTruncated: "secret",
        fragmentEvents: [
          { event: "secret", present: "secret", equalsInitial: "secret", hash: "secret" },
          ...Array(70).fill({ event: "load", present: true }),
        ],
        fragmentsTruncated: "secret",
      },
      connected: "secret",
      hasClient: {},
      operatorRole: "secret",
      selectedIsDefault: "secret",
      token: "secret",
    });
    expect(summary.routes.length).toBeLessThanOrEqual(64);
    expect(summary.routes.every((route) => route === "chat-root" || route === "plugins")).toBe(
      true,
    );
    expect(summary.truncated).toBe(true);
    expect(summary.snapshots).toHaveLength(64);
    expect(summary.snapshotsTruncated).toBe(true);
    expect(summary.gatewayObserved).toBe(false);
    expect(summary.observerFailed).toBe(false);
    expect(summary.fragmentEvents).toHaveLength(64);
    expect(summary.fragmentsTruncated).toBe(true);
    expect(summary.fragmentEvents[0]).toEqual({
      event: "other",
      present: false,
      equalsInitial: false,
      changed: false,
      mountRecovery: false,
    });
    expect(summary).toMatchObject({
      connected: false,
      hasClient: false,
      operatorRole: false,
      selectedIsDefault: null,
    });
    expect(JSON.stringify(summary)).not.toContain("secret");
  });
});
