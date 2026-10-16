// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

type GatewaySnapshot = {
  phase?: string;
  client?: unknown;
  hello?: {
    auth?: { role?: string; scopes?: string[] };
    features?: { methods?: string[] };
    snapshot?: { sessionDefaults?: { defaultAgentId?: string; modelConfigured?: boolean } };
  };
};
type GatewayContext = {
  gateway?: {
    snapshot?: GatewaySnapshot;
    subscribe?: (listener: (snapshot: GatewaySnapshot) => void) => () => void;
  };
  agentSelection?: { state?: { selectedId?: string } };
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Preserve only routing predicates, never device tokens, request IDs or configuration.
export function summarizeGatewayHello(value: unknown) {
  const message = record(value);
  const payload = record(message.payload);
  if (message.type !== "res" || message.ok !== true || payload.type !== "hello-ok") return null;
  const defaults = record(record(payload.snapshot).sessionDefaults);
  const methods = record(payload.features).methods;
  const scopes = record(payload.auth).scopes;
  return {
    defaultAgentIsMain: defaults.defaultAgentId === "main",
    soleAgent: defaults.ownership === "sole",
    modelConfigured:
      typeof defaults.modelConfigured === "boolean" ? defaults.modelConfigured : null,
    selectionRequired:
      typeof defaults.selectionRequired === "boolean" ? defaults.selectionRequired : null,
    setupDetectionAvailable: Array.isArray(methods) && methods.includes("openclaw.setup.detect"),
    adminScope: Array.isArray(scopes) && scopes.includes("operator.admin"),
  };
}

export function gatewayBrowserRoute(value: string) {
  try {
    const pathname = new URL(value).pathname;
    if (pathname === "/settings/model-setup") return "model-setup";
    if (pathname === "/settings/plugins") return "plugins";
    if (pathname === "/chat") return "chat-root";
    if (pathname.startsWith("/chat/")) return "chat-session";
    return "other";
  } catch {
    return "unavailable";
  }
}

export function gatewayBrowserMajorVersion(value: string) {
  const match = /^(\d+)\./u.exec(value);
  const major = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(major) && major > 0 ? major : null;
}

export function gatewayBrowserConsoleFailure(value: string) {
  if (value.startsWith("[openclaw] application start failed")) return "application-start";
  if (value.startsWith("[openclaw] initial session location failed")) return "initial-location";
  if (value.startsWith("[openclaw] route navigation failed")) return "route-navigation";
  if (value.startsWith("[gateway] snapshot handler error:")) return "gateway-snapshot";
  return "other";
}

// Playwright serializes this function. Keep it independent of module scope.
export function installGatewayBrowserRouteTrace() {
  const scope = globalThis as unknown as {
    location: { pathname: string; hash?: string; search?: string };
    history: Record<
      "pushState" | "replaceState",
      (data: unknown, unused: string, url?: string | URL | null) => unknown
    >;
    addEventListener: (type: string, listener: () => void) => void;
    customElements?: { whenDefined: (name: string) => Promise<unknown> };
    navigator?: {
      serviceWorker?: {
        addEventListener: (type: string, listener: (event: { data?: unknown }) => void) => void;
      };
    };
    document?: { querySelector: (selector: string) => { context?: GatewayContext } | null };
    __nemoclawRouteTrace?: unknown;
  };
  const trace = {
    routes: [] as string[],
    truncated: false,
    snapshots: [] as unknown[],
    snapshotsTruncated: false,
    gatewayObserved: false,
    observerFailed: false,
    fragmentEvents: [] as unknown[],
    fragmentsTruncated: false,
  };
  scope.__nemoclawRouteTrace = trace;
  const initialHash = scope.location.hash ?? "";
  let previousHash = initialHash;
  const captureFragment = (event: string) => {
    try {
      if (trace.fragmentEvents.length >= 64) {
        trace.fragmentsTruncated = true;
        return;
      }
      const hash = scope.location.hash ?? "";
      trace.fragmentEvents.push({
        event,
        present: hash !== "",
        equalsInitial: hash === initialHash,
        changed: hash !== previousHash,
        mountRecovery: /(?:^\?|&)openclaw_mount_recovery(?:=|&|$)/u.test(
          scope.location.search ?? "",
        ),
      });
      previousHash = hash;
    } catch {
      trace.observerFailed = true;
    }
  };
  const observe = () => {
    const pathname = scope.location.pathname;
    const route =
      pathname === "/settings/model-setup"
        ? "model-setup"
        : pathname === "/settings/plugins"
          ? "plugins"
          : pathname === "/chat"
            ? "chat-root"
            : pathname.startsWith("/chat/")
              ? "chat-session"
              : "other";
    if (trace.routes.at(-1) === route) return;
    if (trace.routes.length >= 64) trace.truncated = true;
    else trace.routes.push(route);
  };
  for (const method of ["pushState", "replaceState"] as const) {
    const original = scope.history[method].bind(scope.history);
    scope.history[method] = (...args) => {
      const result = original(...args);
      observe();
      captureFragment(method);
      return result;
    };
  }
  scope.addEventListener("popstate", observe);
  for (const event of [
    "popstate",
    "hashchange",
    "DOMContentLoaded",
    "load",
    "openclaw-control-ui-rendered",
  ]) {
    scope.addEventListener(event, () => captureFragment(event));
  }
  observe();
  captureFragment("initial");
  // Observe activation beside URL changes without replying to probes, starting the
  // message queue, or retaining worker versions, URLs, message ports or credentials.
  try {
    const worker = scope.navigator?.serviceWorker;
    worker?.addEventListener("controllerchange", () => captureFragment("sw-controllerchange"));
    worker?.addEventListener("message", (event) => {
      try {
        const data = event.data;
        if (!data || typeof data !== "object" || !("type" in data)) return;
        if (data.type === "sw-version-probe" || data.type === "sw-updated")
          captureFragment(data.type);
      } catch {
        trace.observerFailed = true;
      }
    });
  } catch {
    trace.observerFailed = true;
  }
  // Subscribe when the dashboard element is defined, before waiting for navigation.
  // A final connected snapshot cannot explain an earlier one-time routing decision.
  void scope.customElements
    ?.whenDefined("openclaw-app")
    .then(() => {
      const context = scope.document?.querySelector("openclaw-app")?.context;
      const gateway = context?.gateway;
      if (!gateway?.subscribe) return;
      const capture = (snapshot: GatewaySnapshot) => {
        try {
          captureFragment("gateway-snapshot");
          if (trace.snapshots.length >= 64) {
            trace.snapshotsTruncated = true;
            return;
          }
          const selected = context?.agentSelection?.state?.selectedId?.trim();
          const defaults = snapshot.hello?.snapshot?.sessionDefaults;
          const defaultAgent = defaults?.defaultAgentId?.trim();
          trace.snapshots.push({
            phase: [
              "starting",
              "connecting",
              "connected",
              "reconnecting",
              "offline",
              "reload-required",
              "stopped",
            ].includes(snapshot.phase ?? "")
              ? snapshot.phase
              : "other",
            route: trace.routes.at(-1) ?? "other",
            hasHello: Boolean(snapshot.hello),
            hasClient: Boolean(snapshot.client),
            operatorRole: snapshot.hello?.auth?.role === "operator",
            setupDetectionAvailable:
              snapshot.hello?.features?.methods?.includes("openclaw.setup.detect") === true,
            adminScope: snapshot.hello?.auth?.scopes?.includes("operator.admin") === true,
            selectedIsDefault: defaultAgent ? !selected || selected === defaultAgent : null,
            modelConfigured:
              typeof defaults?.modelConfigured === "boolean" ? defaults.modelConfigured : null,
          });
        } catch {
          trace.observerFailed = true;
        }
      };
      const unsubscribe = gateway.subscribe(capture);
      trace.gatewayObserved = true;
      if (gateway.snapshot) capture(gateway.snapshot);
      scope.addEventListener("pagehide", () => {
        try {
          unsubscribe();
        } catch {
          trace.observerFailed = true;
        }
      });
    })
    .catch(() => {
      trace.observerFailed = true;
    });
}

// Read only categorical state from the pinned dashboard's public context getter.
export function readGatewayBrowserRouteTrace() {
  const scope = globalThis as unknown as {
    document: { querySelector: (selector: string) => unknown };
    __nemoclawRouteTrace?: unknown;
  };
  const app = scope.document.querySelector("openclaw-app") as { context?: GatewayContext } | null;
  const snapshot = app?.context?.gateway?.snapshot;
  const selected = app?.context?.agentSelection?.state?.selectedId?.trim();
  const defaultAgent = snapshot?.hello?.snapshot?.sessionDefaults?.defaultAgentId?.trim();
  return {
    trace: scope.__nemoclawRouteTrace,
    connected: snapshot?.phase === "connected",
    hasClient: Boolean(snapshot?.client),
    operatorRole: snapshot?.hello?.auth?.role === "operator",
    selectedIsDefault: defaultAgent ? !selected || selected === defaultAgent : null,
  };
}

export function summarizeGatewayBrowserRouteTrace(value: unknown) {
  const state = record(value);
  const trace = record(state.trace);
  const allowed = new Set(["model-setup", "plugins", "chat-root", "chat-session", "other"]);
  const fragmentEvents = new Set([
    "initial",
    "pushState",
    "replaceState",
    "popstate",
    "hashchange",
    "DOMContentLoaded",
    "load",
    "gateway-snapshot",
    "openclaw-control-ui-rendered",
    "sw-controllerchange",
    "sw-version-probe",
    "sw-updated",
  ]);
  return {
    routes: Array.isArray(trace.routes)
      ? trace.routes
          .slice(0, 64)
          .filter((route): route is string => typeof route === "string" && allowed.has(route))
      : [],
    truncated:
      trace.truncated === true || (Array.isArray(trace.routes) && trace.routes.length > 64),
    connected: state.connected === true,
    hasClient: state.hasClient === true,
    operatorRole: state.operatorRole === true,
    selectedIsDefault:
      typeof state.selectedIsDefault === "boolean" ? state.selectedIsDefault : null,
    gatewayObserved: trace.gatewayObserved === true,
    observerFailed: trace.observerFailed === true,
    fragmentsTruncated:
      trace.fragmentsTruncated === true ||
      (Array.isArray(trace.fragmentEvents) && trace.fragmentEvents.length > 64),
    fragmentEvents: Array.isArray(trace.fragmentEvents)
      ? trace.fragmentEvents.slice(0, 64).map((value) => {
          const fragment = record(value);
          return {
            event:
              typeof fragment.event === "string" && fragmentEvents.has(fragment.event)
                ? fragment.event
                : "other",
            present: fragment.present === true,
            equalsInitial: fragment.equalsInitial === true,
            changed: fragment.changed === true,
            mountRecovery: fragment.mountRecovery === true,
          };
        })
      : [],
    snapshotsTruncated:
      trace.snapshotsTruncated === true ||
      (Array.isArray(trace.snapshots) && trace.snapshots.length > 64),
    snapshots: Array.isArray(trace.snapshots)
      ? trace.snapshots.slice(0, 64).map((value) => {
          const snapshot = record(value);
          return {
            phase:
              typeof snapshot.phase === "string" &&
              [
                "starting",
                "connecting",
                "connected",
                "reconnecting",
                "offline",
                "reload-required",
                "stopped",
              ].includes(snapshot.phase)
                ? snapshot.phase
                : "other",
            route:
              typeof snapshot.route === "string" && allowed.has(snapshot.route)
                ? snapshot.route
                : "other",
            hasHello: snapshot.hasHello === true,
            hasClient: snapshot.hasClient === true,
            operatorRole: snapshot.operatorRole === true,
            setupDetectionAvailable: snapshot.setupDetectionAvailable === true,
            adminScope: snapshot.adminScope === true,
            selectedIsDefault:
              typeof snapshot.selectedIsDefault === "boolean" ? snapshot.selectedIsDefault : null,
            modelConfigured:
              typeof snapshot.modelConfigured === "boolean" ? snapshot.modelConfigured : null,
          };
        })
      : [],
  };
}
