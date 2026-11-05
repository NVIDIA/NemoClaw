// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const routerDir = path.resolve("nemoclaw-blueprint/router");
const lightning = "nvidia/nemotron-3.5-lightning-30b-a3b";
const superVL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
const text = [{ role: "user", content: "hello" }];
const image = [
  {
    role: "user",
    content: [{ type: "image_url", image_url: { url: "data:image/png;base64,red" } }],
  },
  ...text,
];

function python(script: string, input: unknown = {}) {
  const result = spawnSync("python3", ["-c", script], {
    cwd: routerDir,
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

const select = String.raw`
import json, sys
from rules import select_model
try:
    print(json.dumps(select_model(json.load(sys.stdin))))
except ValueError as error:
    print(json.dumps({"error": str(error)}))
`;

describe("Model Router rules (#14066)", () => {
  it.each([
    [{ messages: text }, [lightning, "text"]],
    [{ messages: image }, [superVL, "image"]],
    [{ messages: text, metadata: { pin_model: superVL } }, [superVL, "explicit"]],
    [{ messages: text, metadata: { pin_model: lightning } }, [lightning, "explicit"]],
    [{ messages: image, model: superVL }, [superVL, "explicit"]],
    [
      {
        messages: [
          ...text,
          { role: "assistant", content: null, tool_calls: [{}] },
          { role: "tool", content: "7" },
        ],
      },
      [lightning, "text"],
    ],
  ])("selects the compatible model and rule for request %j", (request, selected) => {
    expect(python(select, request)).toEqual(selected);
  });

  it.each([
    { messages: [] },
    { messages: text, metadata: [] },
    { messages: text, user_config: { model_list: [] } },
    { messages: text, api_key: "synthetic" },
    { messages: text, mock_response: "fake success" },
    { messages: text, metadata: { pin_model: "retired-model" } },
    { messages: image, metadata: { pin_model: lightning } },
    { messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }] },
    { messages: text, metadata: { models: [superVL] } },
    { messages: text, model: "unknown" },
    { messages: text, metadata: { pin_model: [] } },
  ])("rejects request %j without a deployment fallback", (request) => {
    expect(python(select, request)).toHaveProperty("error");
  });

  it("keeps concurrent stream and tool evidence scoped to the unchanged request", () => {
    expect(
      python(
        String.raw`
import asyncio, json, sys
from rules import RulesMiddleware, RulesStrategy, LIGHTNING, SUPER_VL
class Router:
    model_list = [{"model_name": LIGHTNING}, {"model_name": SUPER_VL}]
strategy = RulesStrategy(Router())
async def app(scope, receive, send):
    event = await receive()
    data = json.loads(event["body"])
    await asyncio.sleep(0.01 if data.get("stream") else 0)
    deployment = await strategy.async_get_available_deployment("nvidia-routed", data["messages"], request_kwargs=data)
    scope["selected_deployment"] = deployment["model_name"]
    await send({"type": "http.response.start", "status": 200, "headers": []})
    await send({"type": "http.response.body", "body": event["body"], "more_body": False})
async def request(data):
    original = json.dumps(data).encode()
    events = []
    async def receive(): return {"type": "http.request", "body": original}
    async def send(event): events.append(event)
    scope = {"type": "http", "path": "/v1/chat/completions"}
    await RulesMiddleware(app)(scope, receive, send)
    return {"deployment": scope["selected_deployment"], "status": events[0]["status"], "headers": {k.decode(): v.decode() for k,v in events[0]["headers"]}, "unchanged": events[1]["body"] == original}
async def main():
    print(json.dumps(await asyncio.gather(*[request(data) for data in json.load(sys.stdin)])))
asyncio.run(main())
`,
        [
          {
            messages: text,
            stream: true,
            tools: [{ type: "function", function: { name: "probe" } }],
          },
          { messages: image },
          { messages: text, metadata: { pin_model: superVL } },
        ],
      ),
    ).toEqual([
      {
        deployment: lightning,
        status: 200,
        unchanged: true,
        headers: {
          "x-nemoclaw-router-policy": "rules-v1",
          "x-model-router-selected": lightning,
          "x-model-router-rule": "text",
        },
      },
      {
        deployment: superVL,
        status: 200,
        unchanged: true,
        headers: {
          "x-nemoclaw-router-policy": "rules-v1",
          "x-model-router-selected": superVL,
          "x-model-router-rule": "image",
        },
      },
      {
        deployment: superVL,
        status: 200,
        unchanged: true,
        headers: {
          "x-nemoclaw-router-policy": "rules-v1",
          "x-model-router-selected": superVL,
          "x-model-router-rule": "explicit",
        },
      },
    ]);
  });

  it("refuses a selected model missing from LiteLLM's deployments", () => {
    expect(
      python(String.raw`
import json
from rules import RulesStrategy
class Router: model_list = []
try:
    RulesStrategy(Router()).get_available_deployment("nvidia-routed", [{"role":"user", "content":"hi"}])
except ValueError as error:
    print(json.dumps({"error": str(error)}))
`),
    ).toHaveProperty("error", "Selected Model Router deployment is unavailable.");
  });
});

it.each([
  ["single", 413, 1, 0, 0, false],
  ["chunked", 413, 2, 0, 0, false],
  ["boundary", 204, 1, 1, 1, true],
])(
  "bounds actual request bytes before parsing or dispatch for %s bodies (#14066)",
  (mode, status, reads, parses, dispatches, unchanged) => {
    expect(
      python(
        String.raw`
import asyncio, json, sys
import rules
mode = json.load(sys.stdin)["mode"]
limit = rules.MAX_REQUEST_BODY_BYTES
valid = b'{"messages":[{"role":"user","content":"hello"}]}'
boundary = valid + b" " * (limit - len(valid))
chunks = {
    "single": lambda: [b"x" * (limit + 1), b"unread"],
    "chunked": lambda: [b"x" * limit, b"x", b"unread"],
    "boundary": lambda: [boundary],
}[mode]()
reads = parses = dispatches = 0
unchanged = False
events = []
original_parse = rules.json.loads
def counted_parse(body):
    global parses
    parses += 1
    return original_parse(body)
rules.json.loads = counted_parse
async def receive():
    global reads
    reads += 1
    body = chunks.pop(0)
    return {"type": "http.request", "body": body, "more_body": bool(chunks)}
async def send(event): events.append(event)
async def app(scope, receive, send):
    global dispatches, unchanged
    dispatches += 1
    event = await receive()
    unchanged = event["body"] == boundary
    await send({"type": "http.response.start", "status": 204, "headers": []})
    await send({"type": "http.response.body", "body": b""})
asyncio.run(rules.RulesMiddleware(app)({"type": "http", "path": "/v1/chat/completions", "headers": [(b"content-length", b"1")]}, receive, send))
print(json.dumps({"limit": limit, "status": events[0]["status"], "reads": reads, "parses": parses, "dispatches": dispatches, "unchanged": unchanged}))
`,
        { mode },
      ),
    ).toEqual({ limit: 64 * 1024 * 1024, status, reads, parses, dispatches, unchanged });
  },
);

it("registers rules after LiteLLM initializes its router and rejects startup without it (#14066)", () => {
  expect(
    python(String.raw`
import asyncio, json, sys, types
from contextlib import asynccontextmanager
from rules import start_proxy, LIGHTNING, SUPER_VL, RulesStrategy
class Router:
    def set_custom_routing_strategy(self, strategy):
        assert isinstance(strategy, RulesStrategy)
        self.registered = True
class App:
    def __init__(self):
        self.router = types.SimpleNamespace(lifespan_context=self.lifespan)
    @asynccontextmanager
    async def lifespan(self, app):
        proxy.llm_router = Router()
        yield {"ready": True}
    def add_middleware(self, middleware): pass
app = App()
proxy = types.ModuleType("litellm.proxy.proxy_server")
proxy.app = app
proxy.llm_router = None
for name in ["litellm", "litellm.proxy", "model_router_toolkit"]:
    sys.modules[name] = types.ModuleType(name)
sys.modules["litellm.proxy.proxy_server"] = proxy
config = types.ModuleType("model_router_toolkit.config")
config.load_config = lambda path: types.SimpleNamespace(routing=types.SimpleNamespace(method="rules"), model_names=[LIGHTNING,SUPER_VL], models=[{},{}])
sys.modules["model_router_toolkit.config"] = config
server = types.ModuleType("uvicorn")
async def run_lifespan(app):
    async with app.router.lifespan_context(app) as state:
        assert state == {"ready": True}
        assert proxy.llm_router.registered
server.run = lambda app, **kwargs: asyncio.run(run_lifespan(app))
sys.modules["uvicorn"] = server
start_proxy("/unused-config", "/unused-pool", "127.0.0.1", 4000)
@asynccontextmanager
async def missing(app):
    proxy.llm_router = None
    yield {}
app.router.lifespan_context = missing
rejected = False
try:
    start_proxy("/unused-config", "/unused-pool", "127.0.0.1", 4000)
except RuntimeError:
    rejected = True
assert rejected
assert not any("prefill" in key or "transformers" in key or key == "torch" for key in sys.modules)
print(json.dumps({"registered": True, "noEncoder": True}))
`),
  ).toEqual({ registered: true, noEncoder: true });
});

// The pool schema keeps legacy scoring requirements while accepting the rules policy.
describe("Model Router pool schema (#14066)", () => {
  const model = {
    name: "fixture",
    display_name: "Fixture",
    litellm_model: "openai/fixture",
    api_base: "https://api.example.com/v1",
  };
  it("accepts a rules pool without scoring fields", async () => {
    const { compileConfigSchema } = await import("../../scripts/validate-configs.mts");
    expect(
      compileConfigSchema("schemas/router-pool-config.schema.json")({
        routing: { method: "rules" },
        models: [model],
      }),
    ).toBe(true);
  });
  const scoringRouting = {
    method: "prefill",
    checkpoint: "fixture-checkpoint",
    tolerance: 0.1,
    encoder: "fixture-encoder",
    encoder_backend: "fixture-backend",
  };
  const scoringModel = { ...model, cost_per_m_input_tokens: 1, cost_per_m_output_tokens: 2 };
  it("accepts a complete prefill pool", async () => {
    const { compileConfigSchema } = await import("../../scripts/validate-configs.mts");
    expect(
      compileConfigSchema("schemas/router-pool-config.schema.json")({
        routing: scoringRouting,
        models: [scoringModel],
      }),
    ).toBe(true);
  });
  it.each(["checkpoint", "tolerance", "encoder", "encoder_backend"])(
    "requires prefill routing field %s independently of model costs",
    async (field) => {
      const { compileConfigSchema } = await import("../../scripts/validate-configs.mts");
      const routing: Partial<typeof scoringRouting> = { ...scoringRouting };
      delete routing[field as keyof typeof routing];
      expect(
        compileConfigSchema("schemas/router-pool-config.schema.json")({
          routing,
          models: [scoringModel],
        }),
      ).toBe(false);
    },
  );
  it.each(["cost_per_m_input_tokens", "cost_per_m_output_tokens"])(
    "requires prefill model field %s independently of routing fields",
    async (field) => {
      const { compileConfigSchema } = await import("../../scripts/validate-configs.mts");
      const incomplete: Partial<typeof scoringModel> = { ...scoringModel };
      delete incomplete[field as keyof typeof incomplete];
      expect(
        compileConfigSchema("schemas/router-pool-config.schema.json")({
          routing: scoringRouting,
          models: [incomplete],
        }),
      ).toBe(false);
    },
  );
});
