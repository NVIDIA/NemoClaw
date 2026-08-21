// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  maybeEmitPolicyDenialHint,
  maybeEmitScopeUpgradeHint,
  POLICY_HINT_SUPPRESS_ENV,
} from "./exec-policy-hint";

const DENIED_CURL_LINE =
  "[1783046573.602] [sandbox] [OCSF ] [ocsf] NET:OPEN [MED] DENIED /usr/bin/curl(1245) -> example.com:443 [policy:- engine:opa] [reason:endpoint example.com:443 is not allowed by any policy]";
const START_BEFORE_DENIAL = 1783046573000;
const START_AFTER_DENIAL = 1783046800000;

describe("maybeEmitPolicyDenialHint (#5978)", () => {
  // Base deps keep every case hermetic and instant: a no-op audit-enable and
  // log capture never touch the real openshell binary, a no-op sleep skips real
  // retry delays, and writeStderr records emitted lines. `enableCalls` proves
  // audit is enabled once regardless of retry count.
  const harness = () => {
    const lines: string[] = [];
    let enableCalls = 0;
    return {
      lines,
      enableCount: () => enableCalls,
      base: {
        env: {} as NodeJS.ProcessEnv,
        writeStderr: (line: string) => lines.push(line),
        sleep: async () => {},
        enableAudit: () => {
          enableCalls += 1;
        },
      },
    };
  };

  it("emits the breadcrumb on stderr for a failed command with a fresh denial", async () => {
    const h = harness();
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      56,
      false,
      START_BEFORE_DENIAL,
      {
        ...h.base,
        probeLogs: () => DENIED_CURL_LINE,
      },
    );
    expect(hint).toContain("nemoclaw oc-fresh logs --tail 50");
    expect(hint).toContain("example.com:443");
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toBe(hint);
    expect(h.enableCount()).toBe(1);
  });

  it("emits the breadcrumb naming a bracketed IPv6 endpoint end to end", async () => {
    const h = harness();
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      56,
      false,
      START_BEFORE_DENIAL,
      {
        ...h.base,
        probeLogs: () =>
          "[1783046573.602] [sandbox] NET:OPEN [MED] DENIED /usr/bin/curl(9) -> [2001:db8::1]:443 [reason:not allowed by any policy]",
      },
    );
    expect(hint).toContain("for [2001:db8::1]:443");
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toBe(hint);
  });

  it("stays silent on a successful command", async () => {
    const h = harness();
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      0,
      false,
      START_BEFORE_DENIAL,
      {
        ...h.base,
        probeLogs: () => DENIED_CURL_LINE,
      },
    );
    expect(hint).toBeNull();
    expect(h.lines).toHaveLength(0);
  });

  it("stays silent on an unrelated failure with no recent denial", async () => {
    const h = harness();
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      2,
      false,
      START_AFTER_DENIAL,
      {
        ...h.base,
        probeLogs: () => DENIED_CURL_LINE,
      },
    );
    expect(hint).toBeNull();
    expect(h.lines).toHaveLength(0);
  });

  it("stays silent when the user sets the opt-out env", async () => {
    const h = harness();
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      56,
      false,
      START_BEFORE_DENIAL,
      {
        ...h.base,
        env: { [POLICY_HINT_SUPPRESS_ENV]: "1" },
        probeLogs: () => DENIED_CURL_LINE,
      },
    );
    expect(hint).toBeNull();
    expect(h.lines).toHaveLength(0);
  });

  it("degrades silently (no throw) when the log probe fails", async () => {
    const h = harness();
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      56,
      false,
      START_BEFORE_DENIAL,
      {
        ...h.base,
        probeLogs: () => {
          throw new Error("openshell logs unavailable");
        },
      },
    );
    expect(hint).toBeNull();
    expect(h.lines).toHaveLength(0);
  });

  it("uses retained logs when optional audit enablement fails", async () => {
    const h = harness();
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      56,
      false,
      START_BEFORE_DENIAL,
      {
        ...h.base,
        enableAudit: () => {
          throw new Error("audit setting unavailable");
        },
        probeLogs: () => DENIED_CURL_LINE,
      },
    );
    expect(hint).toContain("example.com:443");
    expect(h.lines).toEqual([hint]);
  });

  it("degrades silently (no throw) when the stderr sink fails", async () => {
    const h = harness();
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      56,
      false,
      START_BEFORE_DENIAL,
      {
        ...h.base,
        probeLogs: () => DENIED_CURL_LINE,
        writeStderr: () => {
          throw new Error("stderr unavailable");
        },
      },
    );
    expect(hint).toBeNull();
  });

  it("retries the probe until a settling denial event becomes visible", async () => {
    const h = harness();
    let calls = 0;
    const probeLogs = () => {
      calls += 1;
      return calls >= 2 ? DENIED_CURL_LINE : "";
    };
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      56,
      false,
      START_BEFORE_DENIAL,
      {
        ...h.base,
        probeLogs,
      },
    );
    expect(calls).toBe(2);
    expect(hint).toContain("example.com:443");
    expect(h.lines).toHaveLength(1);
    // Audit is enabled once up front, not re-enabled per retry.
    expect(h.enableCount()).toBe(1);
  });

  it("stops after the bounded number of attempts when no denial appears", async () => {
    const h = harness();
    let calls = 0;
    const probeLogs = () => {
      calls += 1;
      return "";
    };
    const hint = await maybeEmitPolicyDenialHint(
      "nemoclaw",
      "oc-fresh",
      56,
      false,
      START_BEFORE_DENIAL,
      {
        ...h.base,
        probeLogs,
        attempts: 3,
      },
    );
    expect(hint).toBeNull();
    expect(calls).toBe(3);
    expect(h.enableCount()).toBe(1);
    expect(h.lines).toHaveLength(0);
  });
});

describe("maybeEmitScopeUpgradeHint (#9744)", () => {
  const OPENCLAW_CRON_ADD = ["openclaw", "cron", "add"];
  const PENDING_REQUEST_ID = "4899d110-911f-4bc7-ac1a-85d76c7b366f";
  const PENDING_JSON = JSON.stringify({ pending: [{ requestId: PENDING_REQUEST_ID }] });
  // An upgrade the failed command did not ask for: a different device asking for
  // operator.admin. NemoClaw cannot correlate it, so it must never be named.
  const UNRELATED_ADMIN_PENDING_JSON = JSON.stringify({
    pending: [
      {
        requestId: "c0ffee00-dead-4beef-b0bb-000000000001",
        device: "unrelated-device-fingerprint",
        scopes: ["operator.admin"],
      },
    ],
  });

  const harness = (devicesJson: string = PENDING_JSON) => {
    const lines: string[] = [];
    let probeCalls = 0;
    return {
      lines,
      probeCount: () => probeCalls,
      base: {
        env: {} as NodeJS.ProcessEnv,
        writeStderr: (line: string) => lines.push(line),
        probePendingDevices: () => {
          probeCalls += 1;
          return devicesJson;
        },
      },
    };
  };

  it("names the devices-list review command after a failed openclaw command", async () => {
    const h = harness();
    const hint = await maybeEmitScopeUpgradeHint(
      "nemoclaw",
      "my-assistant",
      1,
      false,
      OPENCLAW_CRON_ADD,
      h.base,
    );
    expect(hint).toContain("nemoclaw my-assistant exec -- openclaw devices list");
    expect(h.lines).toEqual([hint]);
  });

  it.each([
    ["a sole uncorrelated pending request", PENDING_JSON, PENDING_REQUEST_ID],
    [
      "an unrelated admin-scope pending request",
      UNRELATED_ADMIN_PENDING_JSON,
      "c0ffee00-dead-4beef-b0bb-000000000001",
    ],
  ])(
    "keeps the approve placeholder and never names the request id for %s",
    async (_label, devicesJson, leakedId) => {
      const h = harness(devicesJson);
      const hint = await maybeEmitScopeUpgradeHint(
        "nemoclaw",
        "my-assistant",
        1,
        false,
        OPENCLAW_CRON_ADD,
        h.base,
      );
      expect(hint).toContain(
        "nemoclaw my-assistant exec -- openclaw devices approve <requestId>",
      );
      expect(hint).not.toContain(leakedId);
      expect(hint).not.toContain("operator.admin");
      expect(hint).not.toContain("unrelated-device-fingerprint");
    },
  );

  it.each([
    ["a successful command", 0, false, OPENCLAW_CRON_ADD, {}],
    ["a non-openclaw command", 1, false, ["curl", "example.com"], {}],
    ["a transport invocation error", 1, true, OPENCLAW_CRON_ADD, {}],
    ["a suppressed hint", 1, false, OPENCLAW_CRON_ADD, { [POLICY_HINT_SUPPRESS_ENV]: "1" }],
  ])(
    "stays silent and skips the probe for %s",
    async (_label, code, invocationError, command, env) => {
      const h = harness();
      const hint = await maybeEmitScopeUpgradeHint(
        "nemoclaw",
        "my-assistant",
        code,
        invocationError,
        command,
        { ...h.base, env: env as NodeJS.ProcessEnv },
      );
      expect(hint).toBeNull();
      expect(h.lines).toEqual([]);
      expect(h.probeCount()).toBe(0);
    },
  );

  it.each([
    ["nothing is pending", () => JSON.stringify({ pending: [] })],
    ["only paired devices are reported", () => JSON.stringify({ paired: [{ scopes: ["a"] }] })],
    [
      "the probe fails",
      () => {
        throw new Error("exec failed");
      },
    ],
  ])("stays silent when %s", async (_label, probePendingDevices) => {
    const h = harness();
    const hint = await maybeEmitScopeUpgradeHint(
      "nemoclaw",
      "my-assistant",
      1,
      false,
      OPENCLAW_CRON_ADD,
      { ...h.base, probePendingDevices },
    );
    expect(hint).toBeNull();
    expect(h.lines).toEqual([]);
  });
});
