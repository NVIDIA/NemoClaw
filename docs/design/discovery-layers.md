<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Discovery Layers

This page classifies every target read by what it depends on.
Plan and onboarding must make consistent decisions from the same facts, so the reads that need no plan belong upstream of both.
It records the current state and does not change behavior.
Verified against revision `127604989`.

## Layers

| Layer | A read belongs here when | Used by |
|---|---|---|
| 1. Environment fact | Its inputs are literal query values and it reads only the environment. | Plan and onboarding |
| 2. Judgment | It is a function of layer-1 facts and a requirement the query carries. | Plan and onboarding, through the same query |
| 3. Plan-bound | Its inputs reference a resource in the same graph, or a resource consumes its result. | Plan only |

A resource exists only in a plan, so OpenTofu can order a layer-3 read only inside the plan graph.
A read may still reference another read: the image read takes its platform from the engine read.
That reference keeps it in layer 2, because a discovery session can make both reads in one round.

## Classification

Each row names the variant and the provider data source that produces it.
Layer-1 and layer-2 variants are in [`DiscoveryObservation`](../../crates/nemoclaw-sdk/src/discovery.rs), which plan and onboarding share.
Layer-3 variants are in [`PlanObservation`](../../crates/nemoclaw-sdk/src/deployment/reporting.rs), which only a plan report holds.

| Observation | Data source | Layer | Plan uses it to | Onboarding uses it to |
|---|---|---|---|---|
| `Engine` | `engine_capabilities` | 1 and 2: status means the engine meets gateway prerequisites for the query's compute driver | Gate the plan, and report | Assess compatibility, suggest a runtime |
| `Hardware` | `target_hardware` | 1 | Report its status only | Nothing; it is asked and not read |
| `Fabric` | `fabric_capabilities` | 1 for the raw image data; 2 for `compatibility`, judged against the query's requirements on its platform engine; 3 for `runtime_json`, `binaries_json`, and `compatibility_status` | Gate the plan, feed resources, report | Relay the same `compatibility` |
| `Inference` | `inference_capabilities` | 1, read from the control host | Report; never a gate | Suggest models, gate delegation |
| `Gateway` | `gateway_capabilities` | 1 and 2: status and `compatible` are verdicts against the required drivers | Report, resolved only when compatible | Nothing; it is asked and not read |
| `Credential` | none; read from the control host environment | 1; the value is never recorded | List and defer | Gate delegation |
| `RuntimeImage` | `runtime_image` | 3: the acquired read takes `image_id` from a resource in the same apply and gates every other mutation | Gate and report | Not used |
| `Service { ready }` | `service_readiness` | 3: readiness after install | Report, advisory | Not used |
| `Unresolved { category }` | none | 3: marks a read whose inputs are unknown until apply | Report | Not used |

Two data sources are not in the enum.
`sandbox_readiness` is layer 3.
`service_capacity` derives from the declared managed processes plus host capacity, so it is layer 2 with its own type, `ServiceCapacity`, separate from `HardwareObservation`.

## Where layers are fused

- `DiscoveryObservation` holds layers 1 and 2 without separating them.
- `FabricObservation` carries raw image data and an optional verdict.
- The image data source returns one observation and also graph inputs that resources consume (`compile.rs` wires `runtime_json` and `binaries_json`).
- `EngineObservation` and `GatewayObservation` fold a verdict into `status`.
- Hardware has two representations, `HardwareObservation` and `ServiceCapacity`.
- `DiscoveryReport` keeps `targets` and `observations` as parallel maps keyed by graph name.
  `targets[name]` holds the read's inputs, so the pair is a query-to-observation map written as two maps.
- Onboarding keeps the same pairing in `DiscoveryObservations`, keyed by `DiscoveryQuery`.

## Judgments computed in more than one place

| Judgment | Where |
|---|---|
| Resolved or unresolved | `DiscoveryReport::unresolved` for plan, and onboarding's `assess_target` |
| Gateway compatibility | `GatewayObservation::from_result` and the report's resolved check |

Plan classifies deferrals only from its typed report; `Plan::discovery_deferred` adds the one case the report cannot hold, a discovery output OpenTofu cannot compute yet.
Image compatibility has one implementation: the provider computes it from the image query's inputs, which `DiscoveryQuery::data` writes identically for a plan and a discovery session.
The names `endpoint_N`, `target_N`, and `sandbox_N` must agree across `populate`, `is_observation`, and `category`.

## Implications

These follow from the tables and are not decisions.

- A raw image observation can be separate from its verdict, while the data source keeps the outputs the graph needs.
- The CLI prints the report's `targets` and `observations`, so a query-keyed report would change that output.

## Not verified

- Whether the gateway read gates resources; only its report use was traced.
- The internals of `service_capacity` beyond how its inputs are derived.
- That no code reads GPU fields: a text search of the SDK, runtime, provider, and CLI sources found no reader, and find-references was not run on them.
