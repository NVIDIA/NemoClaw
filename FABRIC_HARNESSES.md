# Fabric harness image recipes

The builder covers every adapter descriptor under `adapters/` in Fabric revision
`51a28c1aefec56abd877070b6973d0a32a1e3003`: nine upstream adapters, plus our local
OpenClaw adapter. No upstream Fabric changes are required.

| `--harness` / YAML `harness` | Packaged harness | Inference protocol | Adapter selection |
| --- | --- | --- | --- |
| `deepagents` | Deep Agents 0.7.13 | OpenAI Chat Completions | `nvidia.fabric.langchain.deepagents` |
| `hermes` | Hermes 0.21.0, pinned source | OpenAI Chat Completions | `nvidia.fabric.hermes` |
| `openclaw` | OpenClaw 2026.9.4 | OpenAI Chat Completions | Local `nemoclaw.local.openclaw` |
| `claude` | Claude Agent SDK 0.2.120 and its bundled CLI | Anthropic Messages | `nvidia.fabric.claude` |
| `codex` | Codex SDK/CLI 0.144.4 | OpenAI Responses | `nvidia.fabric.codex` |
| `mini-swe-agent` | mini-SWE-agent 2.4.6 | OpenAI Chat Completions | `nvidia.fabric.mini-swe-agent` |
| `nooa` | NOOA / NOOA CLI 0.0.10 | OpenAI Chat Completions | `nvidia.fabric.nooa`, workflow `nvidia.nooa.coding-agent` |
| `nooa-bench` | NOOA bench 0.0.10 | OpenAI Chat Completions | `nvidia.fabric.nooa.bench-agent` |
| `remote-agent` | HTTP adapter 0.4.0 | OpenAI Chat Completions in this recipe | `nvidia.fabric.remote-agent` |
| `pi` | Pi 0.84.2 | OpenAI Responses with the selected catalog profile | `nvidia.fabric.pi` (TypeScript process adapter) |

Build a native Linux ARM64 image with Python 3.13:

```sh
python3 image/fabric/build.py --harness codex
go run ./tools/bundle
```

Use the matching `examples/fabric-HARNESS.yaml` and the immutable digest printed
by the builder. The seven new examples describe the test fixture topology; replace
the endpoint and `fixture-model` with your service and model before ordinary use.
Each Python dependency lock contains native wheel hashes. Pi builds the TypeScript
contract, shared lifecycle host, adapter, and harness using the npm lockfiles from
the same checksum-verified Fabric archive. Fabric-owned wheels are built locally.

Claude requires `inferenceProviders[].provider: anthropic`; the other recipes use
`openai`. NemoClaw creates the corresponding OpenShell provider credentials and
base-URL fields, and probes the harness's protocol from inside the sandbox. The
provider type is immutable. Older OpenAI provider state defaults to its existing
behavior without replacement. Endpoints must also pass OpenShell's own provider
validation. A successful Chat Completions call alone does not qualify Responses.

Pi's pinned adapter only accepts models from its catalog. The recipe uses the
`openai/gpt-4o` profile to select its wire format; OpenShell rewrites the outbound
model to the primary route's YAML model. The test verifies that rewrite. Pi's
catalog context limits and pricing describe that profile, not an arbitrary backend.
mini-SWE-agent uses `MSWEA_COST_TRACKING=ignore_errors` because the `primary` alias
has no public price. Its image and OpenShell launch environment both set this.

`remote-agent` forwards requests to an existing agent service through the declared
route. It does not install or operate that service. NOOA selects its packaged
CodingAgent target; the separate ARC solver target is not selected by this recipe.
Adapter coverage does not imply all workflow targets, settings, providers, MCP,
telemetry, messaging, or model-specific capabilities have been qualified.

NemoClaw still has four commands: plan, apply, export, and destroy. The private
socket only checks readiness; native interfaces or the existing Fabric SDK handle
runtime access. Changing a deployed harness still requires explicit teardown.

## Repeat the tests

The offline test uses real Fabric and harness processes in a disposable Docker
container with `--network none`. A local TLS server supplies protocol responses.
It checks startup, readiness without inference, rejection of mismatched readiness
configuration, two ordered invocations in one runtime, and stop. mini-SWE-agent
and both NOOA modes execute real file-writing tools and verify the file separately.
No external messages or paid model requests are sent.

```sh
python3 tools/fabric-adapter-experiment.py --harness codex
python3 -m unittest discover -s image/fabric -p test_build.py -v
```

The inventory test compares the recipes with both the Python and TypeScript
adapter trees in the verified source populated by the default image build.
Evidence and diagnostics are retained under the printed `.local/fabric-*` path.

For the real OpenShell boundary, start the external gateway as described in
`LOCAL_TEST.md`. Run a fixture server on that test network's bridge address, then
point the corresponding YAML at `http://BRIDGE_ADDRESS:11446/v1`:

```sh
mkdir -p .local/fabric-model-fixture
FABRIC_FIXTURE_EVIDENCE="$PWD/.local/fabric-model-fixture" \
FABRIC_FIXTURE_MARKER=FOUR \
  python3 test/fabric_adapters.py codex --serve-fixture BRIDGE_ADDRESS 11446
```

In another terminal, after rebuilding the native bundle:

```sh
NEMOCLAW_LIVE_FABRIC_CONFIG="$PWD/deployment.yaml" \
  go test -tags=live ./internal/engine -run '^TestLiveFabric$' -count=1 -timeout=12m -v
```

Use the same harness in the server and YAML. This exercises real OpenShell
provisioning, inference routing, unchanged apply, export/reapply, stable hosted
runtime and resource identities, an independent SDK invocation, and teardown.
The SDK invocation starts its own runtime; it does not attach to the hosted one.
Stop the fixture and test gateway and remove the empty test network afterward.
This is native runtime evidence with fixture inference, not live-model quality
or authentication qualification. See `VALIDATION.md` for retained results.
