<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Travel Team

A travel planning team of six agents, each in its own OpenShell sandbox, written as plain OpenTofu HCL against NemoClaw's providers.
For a single agent, see [the travel example](../travel/).

| Role | Harness | Model | Reaches |
|---|---|---|---|
| `flights`, `stays`, `transport`, `attractions` researchers | Hermes | Local Ollama model | Web search and its own HTTPS sources, `GET` only |
| `scheduler` | Hermes, delegating one feasibility review | Hosted frontier model | Its model only |
| `buyer` | Hermes, at temperature 0 | Hosted frontier model | The booking service's listed MCP tools only |

Each sandbox's policy grants exactly what its role needs, from the executables of its harness; OpenShell denies everything else.
The researchers use a fast local model, and the scheduler and buyer use a hosted model for the parts that need the most reasoning.

## Files

[WALKTHROUGH.md](WALKTHROUGH.md) walks through the HCL file by file.

| File | Contents |
|---|---|
| `versions.tf` | OpenTofu and provider requirements |
| `variables.tf` | Gateway, images, models, web search, sources, and the booking service |
| `models.tf` | The local Ollama server, checked by its readiness read, and the hosted model |
| `registrations.tf` | The workspace, both inference registrations, web search, and the booking service's key |
| `policies.tf` | Each role's network grants |
| `agents.tf` | Each role's sandbox and agent, from one table of roles |
| `outputs.tf` | What invoking each agent needs |
| `instructions/` | Each role's instructions, which embed the JSON Schemas of its input and reply |
| `schemas/` | JSON Schemas of the trip request, research results, itinerary, and booking |

## Run It

1. Install the NemoClaw bundle's providers as a filesystem mirror, and pin their version in `versions.tf`.
2. Set the variables in `terraform.tfvars`: at least `docker_host`, `gateway_endpoint`, `images`, `image_engine`, `ollama_image`, and `local_model`.
3. Export the keys the registrations name, which OpenShell reads during apply: by default `NVIDIA_API_KEY` for the hosted model, `BRAVE_API_KEY` for web search, and `BOOKINGS_API_KEY` for the booking service.
   Sandboxes see a placeholder in place of each key, and OpenShell puts the key into requests that carry the placeholder, so agents never see the keys.
   Hermes doesn't send the booking key's placeholder to MCP servers yet, so the booking service receives no key ([#13313](https://github.com/NVIDIA/NemoClaw/issues/13313)).
4. Run `tofu init` and `tofu apply`.

Hosted providers retire model names over time. If the scheduler or buyer fails with HTTP 404 or 410 from the hosted model, list the models your endpoint and key can use (`GET /v1/models`, then try one) and set `frontier.model`.

An agent's configuration is fixed when its sandbox starts: Fabric runs one agent per sandbox.
Changing any of an agent's settings, such as its instructions or model, therefore replaces its sandbox, and the plan shows `openshell_sandbox.agent["<role>"] must be replaced`.
Replacing a sandbox deletes its files; to keep files across replacements, mount a volume with `driver_config`, as `skills_volume` does for researchers.

To tear everything down, run `tofu destroy -var destroy=true`.

## Use It

The `agents` output lists, for each role, what invoking its agent needs.
OpenShell runs Fabric's `fabric-agent-ctl` in the agent's sandbox, which prints Fabric's result envelope:

```sh
invoke() {
  agent=$(tofu output -json agents | jq -c --arg role "$1" '.[$role]')
  openshell --workspace "$(jq -r .workspace <<<"$agent")" sandbox exec \
    -n "$(jq -r .sandbox <<<"$agent")" --no-tty -- \
    /opt/fabric/bin/fabric-agent-ctl invoke \
    --agent "$(jq -r .agent <<<"$agent")" \
    --runtime-id "$(jq -r .runtime_id <<<"$agent")" --input -
}
```

The envelope's `status` says whether Fabric completed the call, not whether the agent succeeded.
Check `result.status` for that, and read the agent's reply from `result.output`: a run can fail inside a completed call, for example when the hosted model rejects a request.

A trip then takes four steps:

1. Give each researcher the trip request, which matches `schemas/trip-request.json`, and keep each reply's `result.output`.
2. Give the scheduler one message with the request and all four results.
   It replies with an itinerary, and lists in `problems` any constraint it can't meet and any option it left out.
3. Review the itinerary yourself; nothing is booked without your approval.
4. Give the buyer the approved itinerary.
   It quotes every distinct option first, and books them only if every quote matches the itinerary; otherwise it books nothing and reports what changed.

## Not Yet Covered

The team needs a few things NemoClaw and its components don't provide yet:

- Agents don't call one another directly: a person or script passes results between them ([#13311](https://github.com/NVIDIA/NemoClaw/issues/13311), [#13312](https://github.com/NVIDIA/NemoClaw/issues/13312)).
- The approval step happens outside the agents ([#13314](https://github.com/NVIDIA/NemoClaw/issues/13314)).
- The booking service receives no key yet ([#13313](https://github.com/NVIDIA/NemoClaw/issues/13313)).
- The scheduler runs Hermes rather than Deep Agents, whose adapter can't turn a model's reasoning off ([NVIDIA/NeMo-Fabric#433](https://github.com/NVIDIA/NeMo-Fabric/issues/433)).
- Each invocation must finish within `fabric-agent-ctl`'s 320-second deadline, which bounds how much one agent can do per call.

## Tried Live

On an NVIDIA DGX Spark, with Nemotron 3 Nano on Ollama for the researchers, Nemotron 3 Super on NVIDIA's API for the scheduler and buyer, Brave web search, and a test booking service, one trip took about four minutes: researchers about 1¾ minutes two at a time, the scheduler 46 seconds, and the buyer 63 seconds to quote and book all 18 options.
Researchers cited real search results, but the small local model still filled in many prices, and search snippets give "from" fares rather than offers for the trip's dates; review prices before approving.

## Tested

`crates/nemoclaw-e2e/tests/travel_team_example.rs` applies this directory unchanged against the bundle's providers, with fakes for the engines, gateway, and model server.
It checks each sandbox's providers, grants, and agent configuration, and that a plan after applying shows no changes.
It also checks that changing the hosted model replaces only the scheduler's and buyer's sandboxes, and that destroying removes everything.
It reports how long each OpenTofu command takes, as a benchmark of a realistic team.
