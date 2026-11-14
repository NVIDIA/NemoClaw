// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { classifySearchTurn } from "../../../nemoclaw/src/runtime-context.ts";
import {
  nativePluginResultMatches,
  nativePluginInvocationPrompt,
  type NativePluginExpectation,
} from "../fixtures/openclaw-agent-output.ts";

const weather: NativePluginExpectation = {
  plugin: "weather",
  tool: "get_weather",
  args: { location: "Santa Clara" },
  details: { fixtureVersion: "v2", location: "Santa Clara" },
};
const call = (id: string, name = weather.tool, args: unknown = weather.args) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: args }],
});
const result = (id: string, details: unknown = weather.details) => ({
  role: "toolResult",
  toolName: weather.tool,
  toolCallId: id,
  details,
});
const wrapperCall = (target = "get_weather") =>
  call("wrapper", "tool_call", { id: target, args: weather.args });
const wrapperResult = () => ({
  role: "toolResult",
  toolCallId: "wrapper",
  details: {
    tool: { id: "openclaw:weather:get_weather", name: "get_weather" },
    result: { details: weather.details },
  },
  toolName: "tool_call",
});

describe("native plugin execution evidence", () => {
  it.each([
    weather,
    {
      plugin: "e2e-survival-plugin",
      tool: "survival_probe",
      args: {},
      details: { survived: true },
    },
  ])(
    "supplies a local fixture request that remains admissible with search disabled",
    (expected) => {
      const scope = classifySearchTurn(nativePluginInvocationPrompt(expected));
      expect(scope.scope).not.toBe("external");
      expect(scope.scope).not.toBe("missing");
    },
  );

  it("accepts a paired direct native result", () => {
    expect(nativePluginResultMatches([call("native"), result("native")], weather)).toBe(true);
  });

  it.each(["get_weather", "openclaw:weather:get_weather"])(
    "accepts a native wrapper result for %s",
    (target) => {
      expect(nativePluginResultMatches([wrapperCall(target), wrapperResult()], weather)).toBe(true);
    },
  );

  it("rejects an assistant claim without a native tool result", () => {
    expect(
      nativePluginResultMatches(
        [
          {
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify(weather.details) }],
          },
        ],
        weather,
      ),
    ).toBe(false);
  });

  it.each([
    [
      "stale version",
      [call("native"), result("native", { ...weather.details, fixtureVersion: "v1" })],
    ],
    [
      "wrong location",
      [call("native"), result("native", { ...weather.details, location: "other" })],
    ],
    ["wrong arguments", [call("native", weather.tool, { location: "other" }), result("native")]],
    ["unpaired result", [call("native"), result("other")]],
    ["tool error", [call("native"), { ...result("native"), isError: true }]],
    ["result before call", [result("native"), call("native")]],
    [
      "truncated details",
      [call("native"), result("native", { ...weather.details, persistedDetailsTruncated: true })],
    ],
    ["wrong wrapper target", [wrapperCall("other"), wrapperResult()]],
    ["wrapper error", [wrapperCall(), { ...wrapperResult(), isError: true }]],
  ])("rejects %s", (_label, messages) => {
    expect(nativePluginResultMatches(messages, weather)).toBe(false);
  });

  it("rejects a wrapper result from a different plugin", () => {
    const response = wrapperResult();
    response.details.tool.id = "openclaw:other:get_weather";
    expect(nativePluginResultMatches([wrapperCall(), response], weather)).toBe(false);
  });

  it("reads a paired JSON content result when native details are absent", () => {
    expect(
      nativePluginResultMatches(
        [
          call("native"),
          {
            ...result("native"),
            details: undefined,
            content: [{ type: "text", text: JSON.stringify(weather.details) }],
          },
        ],
        weather,
      ),
    ).toBe(true);
  });

  it("verifies the real survival result after restart", () => {
    const survival = {
      plugin: "e2e-survival-plugin",
      tool: "survival_probe",
      args: {},
      details: { survived: true },
    };
    expect(
      nativePluginResultMatches(
        [
          call("native", "survival_probe", {}),
          { ...result("native", { survived: true }), toolName: "survival_probe" },
        ],
        survival,
      ),
    ).toBe(true);
  });
});
