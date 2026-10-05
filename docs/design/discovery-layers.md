<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Discovery Layers

This page classifies every target read by what it depends on.
Plan and onboarding must make consistent decisions from the same facts, so the reads that need no plan belong upstream of both.
It records the current state and does not change behavior.
Verified against revision `478f318c5`.

## Layers

| Layer | A read belongs here when | Used by |
|---|---|---|
| 1. Environment fact | Its inputs are literal query values and it reads only the environment. | Plan and onboarding |
| 2. Judgment | It is a function of layer-1 facts and a requirement from the document or carried by the query. | Plan and onboarding, through one shared function |
| 3. Graph-bound | Its inputs reference resources or outputs in the same graph, or its result feeds a resource. | Plan only |

OpenTofu orders layer-3 reads against resources, so they can exist only inside the plan graph.
Layer-1 and layer-2 reads need no resources.

## Classification

Each row names the SDK variant in [`DiscoveryObservation`](../../crates/nemoclaw-sdk/src/discovery.rs) and the provider data source that produces it.

| Observation | Data source | Layer | Plan uses it to | Onboarding uses it to |
|---|---|---|---|---|
| `Engine` | `engine_capabilities` | 1 and 2: status means the engine meets gateway prerequisites for the query's compute driver | Gate the plan, and report | Assess compatibility, suggest a runtime |
| `Hardware` | `target_hardware` | 1 | Report its status only | Nothing; it is asked and not read |
| `Fabric` | `fabric_capabilities` | 1 for the raw image data; 2 for `compatibility`, present only with requirements; 3 for `runtime_json`, `binaries_json`, and `compatibility_status` | Gate the plan, feed resources, report | Assess compatibility client-side from the raw read |
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

- `DiscoveryObservation` holds all three layers in one enum.
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
| Image compatibility | The provider's image data source and onboarding's `assess_target`, both through `assess_image` |
| Resolved or unresolved | `DiscoveryReport::unresolved` on typed values, `Plan::discovery_deferred` on raw JSON by name prefix, and onboarding's `assess_target` |
| Gateway compatibility | `GatewayObservation::from_result` and the report's resolved check |
| Gating or advisory | The `supplemental` match in `reporting.rs` and the `inference` and `service` check in `plan.rs` |

The names `endpoint_N`, `target_N`, and `sandbox_N` must agree across `populate`, `is_observation`, `category`, and `discovery_deferred`.

## Implications

These follow from the tables and are not decisions.

- Layer-3 variants can leave the shared enum for a plan-only type.
- One query-keyed container can replace the report's `targets` and `observations`.
- A raw image observation can be separate from its verdict, while the data source keeps the outputs the graph needs.
- One classifier can replace the three resolved-or-unresolved implementations.

## Not verified

- Whether the gateway read gates resources; only its report use was traced.
- The internals of `service_capacity` beyond how its inputs are derived.
- That no code reads GPU fields: a text search of the SDK, runtime, provider, and CLI sources found no reader, and find-references was not run on them.
