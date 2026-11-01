// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

export const gatewayDecisionAsset = "control-ui-core-Rwzhj6nO.js";
const decisionAssetSha256 = "dd93631fe62c97a4b27181385bf3c02358458ed1a8488ba2bb6e661f5e3c8267";

// These logpoints observe the pinned first-run decision without rewriting served assets.
// They belong only to the disposable, credential-free compiled gateway control.
export function gatewayDecisionLogpoints(source: string, expectedSha256 = decisionAssetSha256) {
  if (createHash("sha256").update(source).digest("hex") !== expectedSha256) return null;
  const start = source.indexOf("async function Qm(e){");
  const end = source.indexOf("function $m()", start);
  const callback = source.indexOf("s=e=>{if(a)return;", start);
  const location = source.indexOf("r=()=>lt(e.history.location(),t)", start);
  if (
    start < 0 ||
    end <= start ||
    callback <= start ||
    callback >= end ||
    location <= start ||
    location >= callback
  )
    return null;
  const points = [
    {
      offset: start + "async function Qm(e){".length,
      value: '{kind:"entry",enabled:e.enabled===true}',
    },
    {
      offset: callback + "s=e=>{".length,
      value:
        '{kind:"snapshot",phase:e.phase,alreadyDecided:a,eligible:Yt(e,`openclaw.setup.detect`,`operator.admin`),sameLanding:r(),selectedIsDefault:!n.agentSelection.state.selectedId?.trim()||n.agentSelection.state.selectedId?.trim()===or(e)?.defaultAgentId?.trim(),configured:or(e)?.modelConfigured??null}',
    },
    {
      offset: location + "r=()=>".length,
      value:
        '{kind:"location",pathnameEqual:location.pathname===t.pathname,searchEqual:location.search===t.search,hashEqual:location.hash===t.hash}',
    },
  ];
  return points.map(({ offset, value }) => {
    const prefix = source.slice(0, offset);
    return {
      lineNumber: prefix.split("\n").length - 1,
      columnNumber: offset - prefix.lastIndexOf("\n") - 1,
      urlRegex: "/control-ui-core-Rwzhj6nO\\.js(?:\\?.*)?$",
      condition: `(()=>{try{const events=globalThis.__nemoclawRouteDecisions;if(Array.isArray(events)&&events.length<64)events.push(${value})}catch{}return false})()`,
    };
  });
}

type DecisionSession = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: "Debugger.paused", listener: () => void): void;
  detach(): Promise<void>;
};
export type DecisionPage = {
  addInitScript(script: () => void): Promise<void>;
  evaluate<T>(script: () => T): Promise<T>;
  context(): { newCDPSession(page: DecisionPage): Promise<DecisionSession> };
};

function readDecisionEvents() {
  const events = (globalThis as unknown as { __nemoclawRouteDecisions?: unknown })
    .__nemoclawRouteDecisions;
  return Array.isArray(events) ? events.slice(0, 64) : [];
}

type DecisionEvent =
  | { kind: "entry"; enabled: boolean }
  | { kind: "location"; pathnameEqual: boolean; searchEqual: boolean; hashEqual: boolean }
  | {
      kind: "snapshot";
      phase: string;
      alreadyDecided: boolean;
      eligible: boolean;
      sameLanding: boolean;
      selectedIsDefault: boolean;
      configured: boolean | null;
    };

export function summarizeGatewayDecisions(value: unknown): DecisionEvent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap<DecisionEvent>((item) => {
    if (!item || typeof item !== "object") return [];
    const event = item as Record<string, unknown>;
    if (event.kind === "entry") return [{ kind: "entry", enabled: event.enabled === true }];
    if (event.kind === "location")
      return [
        {
          kind: "location",
          pathnameEqual: event.pathnameEqual === true,
          searchEqual: event.searchEqual === true,
          hashEqual: event.hashEqual === true,
        },
      ];
    if (event.kind !== "snapshot") return [];
    return [
      {
        kind: "snapshot",
        phase:
          typeof event.phase === "string" &&
          [
            "starting",
            "connecting",
            "connected",
            "reconnecting",
            "offline",
            "reload-required",
            "stopped",
          ].includes(event.phase)
            ? event.phase
            : "other",
        alreadyDecided: event.alreadyDecided === true,
        eligible: event.eligible === true,
        sameLanding: event.sameLanding === true,
        selectedIsDefault: event.selectedIsDefault === true,
        configured: typeof event.configured === "boolean" ? event.configured : null,
      },
    ];
  });
}

export async function observeGatewayDecisions(
  page: DecisionPage,
  points: ReturnType<typeof gatewayDecisionLogpoints>,
) {
  const status = { supported: points !== null, installed: 0, unexpectedPauses: 0, failed: false };
  let session: DecisionSession | undefined;
  try {
    if (points) {
      await page.addInitScript(() => {
        (
          globalThis as unknown as { __nemoclawRouteDecisions: unknown[] }
        ).__nemoclawRouteDecisions = [];
      });
      session = await page.context().newCDPSession(page);
      await session.send("Debugger.enable");
      const client = session;
      client.on("Debugger.paused", () => {
        status.unexpectedPauses = Math.min(64, status.unexpectedPauses + 1);
        status.failed = true;
        void client.send("Debugger.resume").catch(() => {
          status.failed = true;
        });
      });
      for (const point of points) {
        await client.send("Debugger.setBreakpointByUrl", point);
        status.installed++;
      }
    }
  } catch {
    // Diagnostic failure must not replace the product assertion or expose browser errors.
    status.failed = true;
  }
  return {
    async finish() {
      let events: ReturnType<typeof summarizeGatewayDecisions> = [];
      try {
        events = summarizeGatewayDecisions(await page.evaluate(readDecisionEvents));
      } catch {
        status.failed = true;
      } finally {
        try {
          await session?.detach();
        } catch {
          status.failed = true;
        }
      }
      return { ...status, events };
    },
  };
}
