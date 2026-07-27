<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# RFC 0001 Managed Inference Serving Specifications

- Status: Draft.
- Authors: NemoClaw maintainers.
- Created: 2026-07-26.
- Discussion: [#7636](https://github.com/NVIDIA/NemoClaw/discussions/7636).
- Related work: [system-readiness epic #7407](https://github.com/NVIDIA/NemoClaw/issues/7407), [readiness contract PR #7544](https://github.com/NVIDIA/NemoClaw/pull/7544), and [dual-Station PR #7030](https://github.com/NVIDIA/NemoClaw/pull/7030).
- Implementation: Not started.

## Summary

NemoClaw should define managed local inference defaults in repository-owned YAML specifications.
Code should consume trusted system-readiness reports, aggregate cluster facts, enforce readiness and topology requirements, validate specifications, resolve one preset, and materialize a serving plan.

The system-readiness report defined by [issue #7407](https://github.com/NVIDIA/NemoClaw/issues/7407) is the canonical source for per-node observations, capabilities, and platform qualifications.
The serving layer must not create a second OS, runtime, or accelerator probe contract.

The serving selection model must aggregate those per-node reports into clusters.
It must represent node count, accelerator count, accelerator placement, memory, operating system, container runtime, and qualified fabric properties.
The model must support new dimensions without adding backend-specific selection branches.

The first catalog should cover the existing managed vLLM and Ollama behavior.
It should preserve current behavior before any default changes.

## Motivation

Managed local inference defaults currently use separate mechanisms.

- [`schemas/system-readiness.schema.json`](../schemas/system-readiness.schema.json) defines the supported, consumer-neutral readiness report introduced by [PR #7544](https://github.com/NVIDIA/NemoClaw/pull/7544).
- [`src/lib/readiness`](../src/lib/readiness) defines its TypeScript contract, compatibility checks, and reference validation.
- [`src/lib/inference/vllm.ts`](../src/lib/inference/vllm.ts) defines vLLM profiles for DGX Spark, DGX Station, and generic Linux NVIDIA GPU hosts.
- [`src/lib/inference/vllm-models.ts`](../src/lib/inference/vllm-models.ts) defines model-specific vLLM arguments and runtime overrides.
- [`src/lib/inference/ollama-model-registry.ts`](../src/lib/inference/ollama-model-registry.ts) selects Ollama models from available memory and a compute constraint.
- [`src/lib/inference/nim.ts`](../src/lib/inference/nim.ts) classifies NVIDIA platforms.
- [`scripts/install.sh`](../scripts/install.sh) contains separate DGX Station Express defaults and operating-system qualification branches.
- [`scripts/prepare-dgx-station-host.sh`](../scripts/prepare-dgx-station-host.sh) owns DGX Station host preparation and qualification.

This structure already contains the concepts of a readiness report, host profile, model recipe, and runtime override.
Managed inference does not yet consume the readiness contract through one resolver.
The installer can therefore select a different default from direct onboarding on the same host.

The readiness epic deliberately separates ownership.
NemoClaw owns observation and readiness semantics.
Consumers own application requirements and desired topology.
This RFC follows that boundary by treating the serving catalog as a readiness consumer and keeping cluster aggregation and serving policy in the inference layer.

Distributed configurations make the current split harder to extend.
A two-node DGX Station recipe and a possible eight-node DGX Spark recipe need more than a platform name.
They need node placement, accelerator counts, topology requirements, and distributed serving parameters.

## Goals

This RFC has these goals:

- Define one declarative catalog for managed vLLM and Ollama defaults.
- Reuse the supported system-readiness report as the canonical per-node input.
- Preserve readiness schema compatibility, three-state results, provenance, and freshness.
- Represent single-host and multi-host configurations.
- Represent exact values and inclusive ranges for numeric facts.
- Separate readiness entities, cluster facts, topology artifacts, recipes, presets, and resolved plans.
- Keep product defaults outside backend implementation code.
- Keep host preparation separate from model serving.
- Preserve immutable image and model references.
- Reject incompatible or ambiguous automatic selections before side effects.
- Preserve explicit operator intent across install and resume.
- Explain selection results through human-readable and structured diagnostics.
- Add new fact dimensions without changing the generic matching algorithm.

## Non-goals

This RFC does not:

- Make arbitrary user-authored or remote YAML trusted.
- Define a public extension marketplace for serving specifications.
- Change the current platform support matrix.
- Promote a research configuration to a product default.
- Qualify two DGX Stations or eight DGX Sparks.
- Replace host preparation, readiness, or platform qualification probes.
- Define another public single-host readiness or fact-report contract.
- Match recipes against diagnostic prose or raw readiness evidence.
- Define a general expression language.
- Permit YAML to execute shell commands or code.
- Define general-purpose cluster provisioning outside managed local inference.

## Terms

### System-readiness report

A system-readiness report is the supported, versioned, read-only contract produced by NemoClaw readiness checks.
It separates observations, capabilities, readiness qualifications, findings, bounded evidence, and provenance.
Each participating node supplies one compatible report.

### Selection fact

A selection fact is a typed value in the internal serving selection snapshot.
Per-node selection facts are projected from stable readiness entities.
Cluster facts are derived from the complete report set and trusted topology input.
Operator intent and workload requirements use separate namespaces.

### Readiness qualification

A readiness qualification is a safe, serializable result in a system-readiness report.
It has a stable identifier, a `qualified`, `unqualified`, or `unknown` status, and references to readiness capabilities.
Platform qualifications such as DGX Station readiness belong to this layer.

### Topology qualification artifact

A topology qualification artifact is a private, typed result from code that validates a bounded multi-node or security-sensitive contract.
It has a versioned output schema, physical subject identity, and output digest.
It may provide typed values or opaque secret handles to an allowlisted materializer.
A validated private two-node fabric belongs to this layer.

### Serving recipe

A serving recipe is an atomic backend and model execution contract.
It includes immutable artifacts, model identity, arguments, environment, container resources, and readiness expectations.

### Serving preset

A serving preset maps readiness entities, selection facts, and topology qualifications to one serving recipe.
It also declares whether selection is automatic, explicit only, or disabled.

### Resolved serving plan

A resolved serving plan is the complete validated result for one install attempt.
Install, resume, status, and diagnostics consume this plan.
For a distributed recipe, the plan contains one role-specific plan per node and names the code-owned lifecycle adapter that may apply it.

### Catalog

The catalog is the compiled set of selection schemas, recipes, and presets shipped with one NemoClaw revision.

## Design principles

### Readiness is the per-node source of truth

Managed inference must consume the supported system-readiness producer used by onboarding.
It must not reimplement OS, runtime, GPU, CDI, or platform detection.

### Selection projections do not contain policy

The readiness adapter and cluster aggregator report typed values and states.
They must not choose a model or backend.

### Qualifications remain code-owned

Code must own probes that enforce security or hardware boundaries.
YAML may require a readiness qualification or topology qualification by identifier.
YAML must not reproduce a complex qualification algorithm.

### Unknown remains unknown

The resolver must preserve the readiness contract's `present`, `absent`, and `unknown` states.
It must not convert a failed observation into `absent` or a passing qualification.

### Recipes are complete

A recipe must describe one complete serving contract.
Changing an image, model revision, distributed strategy, or material serving argument creates a new recipe identifier.
Changing the material behavior of a referenced materializer or lifecycle adapter requires a new adapter version and recipe identifier.

### Presets select recipes

A preset may bind declared recipe parameters.
It must not apply an unrestricted patch to a recipe.

### Runtime input is compiled

The YAML files are the canonical source.
Production code consumes a compiled canonical JSON catalog.
Runtime code does not parse YAML from an untrusted location.

### YAML selects bounded code

YAML may name an allowlisted materializer or lifecycle adapter.
Those adapters have versioned input and output schemas.
YAML must not contain executable lifecycle steps, shell fragments, or an unrestricted command template.

### Selection is deterministic

The resolver uses explicit priorities.
It does not infer priority from file order or an undocumented specificity score.

## Repository layout

The catalog should use this layout:

```text
managed-inference/
  recipes/
    ollama/
    vllm/
  presets/
    ollama/
    vllm/
  schemas/
    catalog.schema.json
    preset.schema.json
    recipe.schema.json
    selection-snapshot.schema.json
```

The catalog must reference the repository-level [`schemas/system-readiness.schema.json`](../schemas/system-readiness.schema.json) instead of copying it.

The implementation should use this layout:

```text
src/lib/inference/serving/
  catalog.ts
  cluster.ts
  lifecycles.ts
  materialize.ts
  materializers.ts
  readiness.ts
  resolve.ts
  topology-qualifications.ts
  types.ts
  validate.ts
```

The build should write the compiled catalog to the packaged runtime artifacts.
The exact generated path is an implementation decision.

## System readiness boundary

The supported system-readiness report is the only public per-node readiness contract.
This RFC builds on the ownership model and implementation stack in [issue #7407](https://github.com/NVIDIA/NemoClaw/issues/7407).

Managed inference should call the same in-process readiness producer that onboarding uses.
It should not shell out to the public readiness CLI or maintain parallel probes.
The CLI and managed inference are separate presentations of the same checks and report.

Before using a report, the readiness adapter must:

- Validate the supported schema major and semantic references.
- Require `mutated: false`.
- Compute a canonical report digest.
- Preserve the NemoClaw version, source revision, and observation time.
- Enforce freshness for every consumed entity.
- Preserve `present`, `absent`, and `unknown`.
- Reject duplicate stable identifiers and dangling references.

The readiness registry should declare which stable observation, capability, and qualification identifiers may be projected into serving selection.
The catalog compiler may validate identifiers against that registry.
It must not depend on internal `HostAssessment` fields.

Readiness evidence and human-readable finding summaries are diagnostic.
A preset must not match their content.
A referenced capability or qualification may affect selection because its stable identifier and state are contract fields.

The report's top-level status is not a substitute for recipe requirements.
Managed inference must apply the following fail-closed admission rules before it evaluates a recipe:

| Readiness result | Admission |
| --- | --- |
| Report status `supported` with no `fatal` or `blocking` finding | Continue to recipe-specific requirements |
| Report status `incompatible` or `inconclusive` | Reject before effects |
| Any `fatal` or `blocking` finding | Reject before effects, even when the report status is `supported` |
| Only `warning` or `info` findings | Continue to recipe-specific requirements and retain the findings in diagnostics |

`supported` is necessary but not sufficient.
Every recipe-specific readiness and topology requirement must also pass.
Explicit selection and operator overrides do not bypass these rules.
An `unknown` required entity never satisfies a preset.

## Selection snapshot

The serving resolver builds an internal, versioned selection snapshot.
It is not a second public host-report format and is not accepted from an arbitrary file.
It contains the exact validated readiness reports, their provenance, serving-owned cluster aggregation, explicit operator intent, workload facts, and topology qualification artifacts.

The snapshot must distinguish node count from accelerator count.
A total accelerator count cannot describe accelerator placement or heterogeneous nodes.

This abbreviated example shows its provenance and cluster shape:

```yaml
apiVersion: nemoclaw.nvidia.com/managed-inference-selection/v1
kind: ManagedInferenceSelectionSnapshot

sources:
  readinessReports:
    - nodeId: station-a
      schemaVersion: "1.0.0"
      reportDigest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      observedAt: "2026-07-27T12:00:00Z"
      sourceRevision: 75871ccef2963abaa2ddb8d883f60adee7446f44

    - nodeId: station-b
      schemaVersion: "1.0.0"
      reportDigest: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
      observedAt: "2026-07-27T12:00:03Z"
      sourceRevision: 75871ccef2963abaa2ddb8d883f60adee7446f44

controllerNodeId: station-a

cluster:
  nodeCount: 2
  homogeneous: true

  nodeGroups:
    - id: station-pair
      members: [station-a, station-b]
      count: 2
      software:
        osFamily:
          state: present
          value: linux
        architecture:
          state: present
          value: arm64
        containerRuntime:
          state: present
          value: docker
      accelerators:
        model:
          state: present
          value: NVIDIA-GB300
        countPerNode:
          state: present
          value: 1
        memoryModel:
          state: present
          value: unified

  accelerators:
    totalCount:
      state: present
      value: 2

topologyQualifications:
  - id: dgx-station.gb300.dual-cx8
    schemaVersion: 1
    status: qualified
    subject: station-pair
    subjectDigest: sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
    outputDigest: sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
```

The complete runtime snapshot holds each validated `SystemReadinessReport`.
The `sources` entries above are its serializable provenance, not replacements for those reports.

The initial selection vocabulary should use these namespaces:

- `readiness.observations`
- `readiness.capabilities`
- `readiness.qualifications`
- `cluster.nodeCount`
- `cluster.homogeneous`
- `cluster.nodeGroups`
- `cluster.accelerators`
- `cluster.fabric`
- `agent`
- `workload`
- `topologyQualifications`

New readiness entities require a stable identifier from the readiness contract.
New serving-owned fields require a selection-snapshot schema change and a trusted derivation source.
Neither requires backend-specific matching code.

The selection validator must enforce cross-field invariants.
At minimum:

- Every participating node must have exactly one compatible readiness report.
- Every consumed readiness entity must satisfy its declared freshness policy.
- Node-group members must be unique and their counts must sum to `cluster.nodeCount`.
- `cluster.accelerators.totalCount` must equal the sum of derived node-group inventories.
- A projection is `present` only when every required source observation is present and type-valid.
- An absent source remains absent, and an indeterminate or failed source remains unknown.
- `cluster.homogeneous: true` means that every node has equal values for the declared hardware and software projections.
- A topology qualification subject must resolve to nodes, a node group, or the cluster.

Distributed presets must constrain per-node readiness entities or derived group projections when the recipe requires the same operating system, architecture, or container runtime on every node.

## Readiness entity matching

A readiness requirement declares:

- Node scope such as controller, every node, or a named node group.
- Entity kind such as observation, capability, or qualification.
- Stable entity identifier.
- Required state or qualification status.
- A value operator only when the entity contract defines a typed value.

An observation value may be compared only when its state is `present`.
An `absent` requirement matches only a checked and absent entity.
An `unknown` entity fails both automatic and explicit selection and appears in diagnostics.

Fatal and blocking readiness findings stop the common pre-effect admission phase.
Warning and informational findings remain visible but do not independently stop admission.
Their summary text is never a selector.
Evidence details are never selectors.

## Topology qualification artifacts

Topology qualification code may return typed output that a materializer needs but a generic matcher should not interpret.
The dual-Station qualification, for example, must preserve the pretrusted SSH binding, physical node and GPU identities, reciprocal rail endpoints, device names, master address, and RoCE GID index.

This artifact is distinct from the safe, serializable readiness qualifications in each node report.
A readiness qualification can establish that each node is an approved DGX Station profile.
The topology artifact establishes that these exact nodes form an approved pair.

Each topology qualification identifier maps to one code-owned output schema.
The preset matcher sees only the identifier, schema version, subject, and status.
Only an allowlisted materializer may consume typed output.

Topology qualification outputs must follow these rules:

- The producer validates the complete output before returning a passing result.
- The result records a digest over the canonical non-secret output and physical subject identity.
- Secret values are represented by opaque handles and are not included in the digest, catalog, diagnostics, or resolved-plan serialization.
- A preset cannot invent an artifact or supply its output from YAML.
- A materializer declares the exact topology qualification identifier, schema version, and output path it accepts.
- Resume revalidates the physical subject and artifact instead of trusting a saved status.

## Selection paths

The selection schema defines each matchable serving-owned path, value type, cardinality, and derivation.
The readiness registry defines each matchable readiness entity.
Presets must use an entry from one of those registries.
Every selection-fact requirement must declare `present` or `absent`.
Observation and capability requirements must declare `present` or `absent`, while readiness qualifications declare `qualified` or `unqualified`.
The compiler rejects a preset that asks for `unknown`.

Dot-separated paths do not provide general object traversal.
A collection path such as `cluster.nodeGroups.accelerators.model` is a declared projection over the node-group array.
The compiler rejects a collection path with a scalar operator.
It also rejects an unregistered readiness identifier or an operator that the entity's value contract does not support.

The first schema version should support these scalar operators:

- `equals`
- `oneOf`
- `atLeast`
- `atMost`
- `between`

The first schema version should support these collection operators:

- `allEqual`
- `contains`
- `containsAll`

The first schema version should not support regular expressions.
Operating-system release ranges should use a code-owned readiness qualification or an enumerated value set.
A value operator is valid only with a `present` requirement.

## Range constraints

Preset requirements must support these numeric operators:

- `equals`
- `atLeast`
- `atMost`
- `between`

`between` uses an inclusive lower and upper bound.
Both values are required.

A recipe that has only been validated on eight nodes must use `[8, 8]`.
It must not use `[4, 8]` until the complete range has evidence.

Node and accelerator constraints must remain separate.
A preset may constrain:

- Total nodes.
- Total accelerators.
- Accelerators per node.
- Nodes in a node group.
- Memory per accelerator.
- Aggregate memory.

## Serving preset schema

A preset declares match requirements, selection policy, and one recipe reference.
The readiness entity identifiers in this and the following Spark example are provisional and illustrative until [issue #7408](https://github.com/NVIDIA/NemoClaw/issues/7408) and [issue #7410](https://github.com/NVIDIA/NemoClaw/issues/7410) define the supported registry.

```yaml
apiVersion: nemoclaw.nvidia.com/managed-inference/v1
kind: ServingPreset

metadata:
  id: vllm.dgx-station-gb300.dual.nemotron-ultra
  displayName: Nemotron Ultra on two DGX Stations

spec:
  selection: explicit-only
  priority: 400

  requirements:
    all:
      - readiness:
          scope: everyNode
          kind: capability
          id: sandbox.container-runtime
          state: present

      - readiness:
          scope: everyNode
          kind: capability
          id: inference.nvidia-gpu
          state: present

      - readiness:
          scope: everyNode
          kind: qualification
          id: platform.dgx-station.gb300
          status: qualified

      - fact: cluster.nodeCount
        state: present
        operator: between
        value: [2, 2]

      - fact: cluster.homogeneous
        state: present
        operator: equals
        value: true

      - fact: cluster.nodeGroups.accelerators.model
        state: present
        operator: allEqual
        value: NVIDIA-GB300

      - topologyQualification:
          id: dgx-station.gb300.dual-cx8
          schemaVersion: 1
          status: qualified

  plan:
    backend: vllm
    recipeRef: vllm.nemotron-ultra.station-distributed.v0251

    bindings:
      stationTopology:
        valueFromTopologyQualification:
          id: dgx-station.gb300.dual-cx8
          schemaVersion: 1
          output: topology
```

Allowed selection values are:

- `automatic`
- `explicit-only`
- `disabled`

An `explicit-only` preset must satisfy every requirement.
Explicit selection does not bypass readiness or topology requirements.

## Eight-node DGX Spark example

An eight-node DGX Spark preset can use the same schema.

```yaml
apiVersion: nemoclaw.nvidia.com/managed-inference/v1
kind: ServingPreset

metadata:
  id: vllm.dgx-spark-gb10.eight-node.qwen
  displayName: Qwen on eight DGX Sparks

spec:
  selection: explicit-only
  priority: 400

  requirements:
    all:
      - readiness:
          scope: everyNode
          kind: capability
          id: sandbox.container-runtime
          state: present

      - readiness:
          scope: everyNode
          kind: capability
          id: inference.nvidia-gpu
          state: present

      - readiness:
          scope: everyNode
          kind: qualification
          id: platform.dgx-spark.gb10
          status: qualified

      - fact: cluster.nodeCount
        state: present
        operator: between
        value: [8, 8]

      - fact: cluster.homogeneous
        state: present
        operator: equals
        value: true

      - fact: cluster.accelerators.totalCount
        state: present
        operator: between
        value: [8, 8]

      - topologyQualification:
          id: dgx-spark.gb10.eight-node-fabric
          schemaVersion: 1
          status: qualified

  plan:
    backend: vllm
    recipeRef: vllm.qwen.spark-distributed.v1
```

This example defines data shape.
It does not assert that NemoClaw supports this configuration.
The future recipe must pin or validate its own distributed strategy.
Node count does not imply a safe tensor-parallel or pipeline-parallel value.

## Serving recipe schema

A recipe should use structured arguments.
The compiler converts them to an argument vector.

```yaml
apiVersion: nemoclaw.nvidia.com/managed-inference/v1
kind: ServingRecipe

metadata:
  id: vllm.nemotron-ultra.station-distributed.v0251

spec:
  backend: vllm

  bindings:
    stationTopology:
      type: topologyQualificationOutput
      qualificationId: dgx-station.gb300.dual-cx8
      schemaVersion: 1
      outputSchema: nemoclaw.nvidia.com/dual-station-topology/v1

  model:
    id: nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4
    revision: 183968f87ae4cedce3039313cac1fd43d112c578
    servedName: nemotron-ultra

  runtime:
    image: vllm/vllm-openai@sha256:2cc49b81319f7a66a33dd8bd63a7bfddae079122b33ce51989b6828a1f038c37
    architecture: arm64
    components:
      vllm: 0.25.1
      ray: 2.56.0

  execution:
    materializerRef: vllm.dual-dgx-station/v1
    lifecycleRef: vllm.dual-dgx-station/v1
    topologyBinding: stationTopology
    nodeCount: 2
    tensorParallelSize: 1
    pipelineParallelSize: 2

  serve:
    arguments:
      - name: --data-parallel-size
        value: 1

      - name: --port
        value: 8000

      - name: --trust-remote-code

      - name: --distributed-executor-backend
        value: ray

      - name: --kv-cache-dtype
        value: fp8

      - name: --max-model-len
        value: 262144

      - name: --distributed-timeout-seconds
        value: 7200

      - name: --enable-prefix-caching

      - name: --max-num-seqs
        value: 256

      - name: --gpu-memory-utilization
        value: 0.9

      - name: --reasoning-parser
        value: nemotron_v3

      - name: --enable-auto-tool-choice

      - name: --tool-call-parser
        value: qwen3_coder

  readiness:
    timeoutSeconds: 3600
    expectedModel: nemotron-ultra
```

This example uses the immutable model revision and image digest from the in-flight dual-Station work.
It illustrates how that work slots into the catalog.
It does not make the recipe supported or runnable by itself.

## Bindings

A recipe declares the bindings that it accepts.
A preset supplies values or approved fact references for those bindings.

The first version should support:

- Literal strings, integers, numbers, and booleans.
- `valueFromFact` references to allowlisted fact paths.
- `valueFromTopologyQualification` references to allowlisted, versioned topology artifacts.
- `valueFromBinding` references from structured recipe fields.

The first version must not support:

- Shell expansion.
- JavaScript.
- Template languages.
- File reads.
- Environment-variable interpolation.
- Network access.
- Arithmetic expressions.

If a recipe needs derived arithmetic, code should expose a named materializer operation with bounded inputs.
The RFC that adds that operation must define its validation.

`valueFromTopologyQualification` must not copy a secret into the compiled catalog or serializable plan.
A secret-bearing output must resolve to an opaque handle that only the declared lifecycle adapter can consume.

## Materializers and lifecycle adapters

A materializer is a pure, code-owned function.
It accepts one validated recipe, its declared bindings, the selection snapshot, and typed topology qualification outputs.
It returns a versioned resolved plan without causing side effects.

A lifecycle adapter is code-owned logic that applies one resolved plan.
It may inspect, create, reuse, stop, or roll back managed runtime resources within its declared contract.

Both use an allowlisted registry.
Each registry entry must define:

- A stable identifier and version.
- Accepted backend and recipe shape.
- Input schemas.
- Output plan schema.
- Secret-handle permissions.
- Semantic validation.
- Compatibility and resume rules.

The first distributed entries should be `vllm.dual-dgx-station/v1`.
The materializer converts the qualified pair topology and static recipe constants into separate head and worker plans.
The lifecycle adapter owns worker-first startup, the Ray join sequence, role-specific devices and mounts, head-only API authentication, managed ownership labels, exact-pair reuse, transactional rollback, and legacy single-Station migration.

Those behaviors must stay in reviewed TypeScript.
The YAML recipe selects the adapter and supplies bounded data.
An eight-node DGX Spark implementation should use a separately reviewed adapter unless an accepted RFC establishes a shared distributed contract.

## Selection

The resolver receives:

- A compiled catalog.
- One compatible system-readiness report per participating node.
- Trusted node membership and topology input.
- Topology qualification artifacts.
- Explicit operator intent and workload facts.
- An optional explicit backend.
- An optional explicit preset.
- Existing model and backend overrides during migration.

The resolver applies these rules:

1. Validate the catalog version.
2. Validate every readiness report's schema major, semantic references, `mutated: false`, and provenance.
3. Re-run or reject stale entities according to their readiness freshness policy.
4. Reject an `incompatible` or `inconclusive` report or any `fatal` or `blocking` finding before any side effect; retain `warning` and `info` findings in diagnostics.
5. Build and validate the selection snapshot without changing entity states.
6. Validate every required topology qualification artifact against the current physical subjects.
7. If an explicit preset is present, resolve it by identifier.
8. Reject an unknown or disabled explicit preset.
9. Reject an explicit preset that conflicts with an explicit backend or has an absent, unknown, unqualified, stale, or otherwise failed requirement.
10. Select the valid explicit preset directly and do not evaluate an automatic fallback.
11. Otherwise, retain automatic candidates that match the explicit backend, when present.
12. Evaluate every retained candidate and discard candidates whose requirements fail.
13. Reject the selection when no automatic candidate matches.
14. Select the matching candidate with the highest priority.
15. Reject two matching automatic candidates at the highest priority.
16. Resolve recipe references, bindings, materializer, and lifecycle adapter.
17. Apply permitted operator overrides.
18. Validate the complete plan before any pull, download, host mutation, or launch.

File order must not affect the result.
Display names must not affect the result.

## Overrides

Existing operator overrides require a compatibility period.

The implementation should introduce `NEMOCLAW_SERVING_PRESET` as the explicit preset selector.
The exact CLI flag is an implementation decision.

During migration:

- `NEMOCLAW_PROVIDER` constrains the backend.
- `NEMOCLAW_VLLM_MODEL` maps to a compatible vLLM recipe.
- `NEMOCLAW_MODEL` preserves its documented provider-specific meaning.
- `NEMOCLAW_VLLM_EXTRA_ARGS_JSON` remains an advanced operator override.
- `--station-deepseek` maps to the matching explicit preset.

The materializer must reject known singleton argument conflicts.
It must report the preset field and operator override that conflict.

An incompatible explicit override must fail.
The resolver must not replace explicit intent with an automatic fallback.

## Compilation

The build should compile the YAML catalog to canonical JSON.
The compiled envelope should contain the catalog schema version, compiler version, source revision, sorted definitions, source-file provenance, and catalog digest.
In this RFC, "catalog version" means the compiled schema version plus digest.
It is not a separately edited marketing or release number.

Compilation must:

- Validate every source file against its JSON Schema.
- Reject unknown catalog fields.
- Resolve every recipe reference.
- Verify unique identifiers.
- Verify immutable image references where an image is required.
- Verify immutable model revisions where the model contract requires one.
- Verify binding names and types.
- Verify referenced readiness entity identifiers, kinds, states, value types, and supported operators.
- Verify topology qualification identifiers, schema versions, and binding paths.
- Verify materializer and lifecycle adapter identifiers and input compatibility.
- Reject unsupported selection paths and operators.
- Reject duplicate or conflicting structured arguments.
- Reject invalid selection and priority values.
- Produce deterministic output.
- Include source-file provenance and a definition digest.

Strict catalog fields do not change readiness compatibility.
The readiness adapter must follow the system-readiness contract and ignore unrecognized optional fields within a supported major version.

CI must reject a generated catalog that differs from the YAML source.
Tests must exercise the compiler or resolver behavior instead of asserting only YAML text.

## Semantic validation

JSON Schema cannot enforce every catalog invariant.
The compiler must also perform semantic validation.

Semantic validation must include:

- Backend and recipe compatibility.
- Model and architecture compatibility.
- Readiness entity and scope compatibility.
- Topology qualification identifiers and subjects.
- Selection-projection source and state compatibility.
- Port and endpoint ownership.
- Container network-mode restrictions.
- GPU selection restrictions.
- Per-role device, mount, network, and secret restrictions.
- Secret-field restrictions.
- Readiness-model identity.
- Unsupported binding sources.
- Duplicate automatic matches in maintained host fixtures.

Pairwise proof that arbitrary predicates never overlap can become expensive.
The first implementation should combine explicit priority with maintained boundary fixtures.
Each automatic preset must include fixtures for its accepted boundary and nearest rejected boundaries.

## Diagnostics

The resolver should expose a structured selection report.

The report should include:

- Selection-snapshot schema version.
- Catalog version and digest.
- Each readiness report's node identity, schema version, digest, source revision, and observation time.
- The state and freshness of every readiness entity evaluated.
- Candidate preset identifiers.
- Pass or fail for each requirement.
- Selected preset and recipe identifiers.
- Materializer and lifecycle adapter identifiers.
- Readiness qualification identifiers and statuses.
- Topology qualification identifiers, subjects, schema versions, and output digests.
- Applied bindings.
- Applied operator overrides.
- Rejected conflicts.

Normal output should name the selected preset and recipe.
Debug or JSON output should include the complete report.
Diagnostics must not include secrets.

## Resume and provenance

Resume state must record:

- Preset identifier.
- Recipe identifier.
- Catalog digest.
- NemoClaw source revision.
- Explicit or automatic selection source.
- Non-secret operator overrides.
- Required readiness entity identifiers and the report digests used to evaluate them.
- Required topology qualification identifiers, schema versions, subject identities, and output digests.
- Materializer and lifecycle adapter identifiers.
- Resolved-plan schema and digest.

The installer revision continues to bind the implementation.
The catalog digest proves the exact data used by that implementation.

Resume must fail when the saved preset cannot be resolved under the saved revision.
It must not silently choose a new automatic default.
Resume must re-run every non-resume-safe readiness entity instead of treating a saved report as current.
It must also fail when physical pair identity or a required topology artifact no longer matches.
It must reacquire secret-bearing topology outputs through their trusted producer.

## Installer boundary

The shell installer must not parse YAML.
It should forward explicit preset intent to the Node-based resolver.

Automatic selection should occur after the required readiness reports and topology inputs are available.
The installer may show a generic managed-inference disclosure before resolution.
It should show the resolved backend, model, image source, and download estimate before side effects.

The design should remove model and recipe constants from shell branches.
Shell code may retain host-preparation orchestration that must run before Node onboarding.

## Host preparation boundary

A serving preset may require a readiness qualification or topology qualification.
It must not install drivers, configure Docker, establish SSH trust, or configure network rails.

Host preparation remains a separate phase.
Read-only readiness produces observations, capabilities, qualifications, findings, and evidence.
Separate topology code produces cluster facts and topology qualification artifacts.
The resolver consumes those outputs.

This boundary keeps a serving recipe from gaining host mutation authority.

## Security and trust

The first implementation trusts only specifications shipped in the NemoClaw repository and release artifact.

The runtime must not:

- Load a catalog from a URL.
- Load a catalog from the current directory.
- Search user-writable paths for additional recipes.
- Execute commands from a specification.
- Expand environment variables in a specification.
- Accept mutable image tags for managed recipes.
- Match a preset against readiness evidence details, finding summaries, or other human-oriented text.
- Treat an unknown readiness entity as absent or passing.
- Reuse stale readiness state unless its check explicitly declares reuse safe.
- Include secret values in compiled output, serialized plans, provenance, or diagnostics.
- Let an adapter consume a secret handle that its registry contract does not declare.

User-authored or remote catalogs require a separate design.
That design must define signing, provenance, policy, update, revocation, and execution boundaries.

## Product status

Catalog availability and product support are separate.

The catalog uses `automatic`, `explicit-only`, and `disabled` to control selection.
The platform matrix remains the source of truth for support claims.
An automatic preset does not change a platform status.
An accepted RFC does not qualify hardware.

Each PR that adds an automatic preset must identify:

- The accepted product decision.
- The owner.
- The supported lifecycle.
- Compatibility and upgrade expectations.
- Security review.
- Validation evidence.
- Required platform-matrix and user-documentation changes.

## Existing DGX Station behavior

The first migration should represent current single-node behavior without changing it.

Current behavior includes:

- A DGX Station vLLM host profile.
- A direct managed-vLLM default of DeepSeek V4 Flash.
- A Station Express default of Nemotron 3 Ultra.
- A `--station-deepseek` alternative.
- Exact operating-system qualification and host preparation.
- Model-specific image, environment, arguments, and container overrides.

The initial catalog may encode the direct and Express selections as separate presets.
Maintainers should then decide whether one preset becomes the canonical automatic Station default.

The prior single-user experimental Station configuration changed several serving dimensions together.
If maintainers approve it, it should become a separate explicit-only recipe and preset.
It should not patch the released Nemotron Ultra recipe.

### How the system-readiness work slots in

[Issue #7407](https://github.com/NVIDIA/NemoClaw/issues/7407) is the canonical source-of-facts dependency for this RFC.
Its merged contract and remaining implementation stack divide responsibilities as follows:

| Readiness responsibility | Serving use |
| --- | --- |
| Versioned report contract from [PR #7544](https://github.com/NVIDIA/NemoClaw/pull/7544) | Validate compatibility, provenance, three-state results, stable IDs, bounded evidence, and no-mutation semantics |
| Host observations from [issue #7408](https://github.com/NVIDIA/NemoClaw/issues/7408) | Supply OS, architecture, runtime, resource, GPU, toolkit, and CDI inputs without duplicate inference probes |
| Read-only CLI from [issue #7412](https://github.com/NVIDIA/NemoClaw/issues/7412) | Provide an operator-visible presentation of the same report; managed inference uses the in-process producer |
| Platform qualification from [issue #7410](https://github.com/NVIDIA/NemoClaw/issues/7410) | Supply stable platform capabilities and qualifications for preset requirements |
| Onboarding convergence from [issue #7411](https://github.com/NVIDIA/NemoClaw/issues/7411) | Ensure probing and managed onboarding use the same checks and cannot disagree before effects |

The readiness stack remains consumer-neutral and single-node.
The serving layer owns recipe requirements, report-set aggregation, desired topology, and materialization.
This preserves the ownership boundary stated in issue #7407.

### How the dual-Station work slots in

[PR #7030](https://github.com/NVIDIA/NemoClaw/pull/7030) is the first concrete migration fixture for the distributed design.
This RFC does not decide that pull request's merge or product-support status.
It assigns the work's existing responsibilities to explicit catalog and code-owned boundaries.

| Current responsibility | Proposed owner |
| --- | --- |
| Per-node OS, runtime, GPU, toolkit, CDI, and platform readiness | System-readiness reports and stable entities from issue #7407 |
| Pair discovery, reciprocal `/30` CX-8 rail checks, SSH trust, physical pair identity, routes, neighbors, jumbo frames, and RoCE GID validation | Code-owned `dgx-station.gb300.dual-cx8` topology qualification producer and versioned output |
| Immutable vLLM image, model revision, served name, Ray and vLLM versions, TP=1, PP=2, arguments, and readiness expectations | `vllm.nemotron-ultra.station-distributed.v0251` YAML recipe |
| Conversion of qualified nodes, GPUs, rails, addresses, devices, and secret handles into distinct head and worker plans | Code-owned `vllm.dual-dgx-station/v1` materializer |
| Worker-first startup, Ray join, role-specific hardening, ownership inspection, exact-pair reuse, rollback, cleanup, and legacy migration | Code-owned `vllm.dual-dgx-station/v1` lifecycle adapter |
| Explicit peer intent, pair identity, topology qualification artifact digest, plan digest, and resume compatibility | Resolver input and protected provenance state |

The topology-specific preset selects this recipe only when the exact two-node qualification passes.
The recipe pins PP=2 and TP=1.
It does not derive either value from a general GPU or node count.

## Ollama behavior

The first Ollama migration should preserve the current memory-aware selection.

Ollama presets may constrain:

- Operating-system family.
- WSL placement.
- Native or Windows-host daemon placement.
- Accelerator type.
- Available memory ranges.
- Compute constraints.
- Agent context requirements.

Ollama model metadata belongs in recipes.
Host placement and automatic selection belong in presets.
Daemon installation commands remain code-owned.

## Migration

### Readiness alignment

Treat issue #7407 and its stable entity registry as the per-node source-of-facts dependency.
Add a serving adapter that consumes `SystemReadinessReport` directly.
Do not freeze OS, runtime, accelerator, or platform selection identifiers until issues #7408 and #7410 define their supported IDs.
Converge managed inference on the common readiness producer as part of issue #7411.

### Catalog foundation

Add catalog schemas, compiler types, readiness adapters, cluster aggregation, and synthetic validation fixtures.
Do not change provider selection.

### vLLM parity

Represent current vLLM models, images, and platform defaults in YAML.
Compare resolved plans with current behavior in table-driven tests.

### Installer integration

Make Station Express and Spark Express select preset identifiers.
Preserve existing resume behavior and legacy environment variables.

### Ollama parity

Represent the current Ollama registry and memory-aware defaults.
Keep existing validation and daemon lifecycle behavior.

### Provenance and diagnostics

Persist catalog identity.
Show selection reasons in status and diagnostic output.

### Default convergence

Decide whether direct and Express Station installs should use one automatic default.
Treat that decision as a separate user-visible behavior change.

### Distributed presets

Add distributed presets only after their topology and lifecycle contracts are accepted and validated.

## Testing

The implementation must include:

- Schema tests with synthetic valid and invalid documents.
- System-readiness schema-major and semantic-reference compatibility tests.
- Readiness stable-ID registry and projection tests.
- Present, absent, unknown, and stale entity tests.
- Tests proving managed inference and onboarding use the same readiness producer.
- Tests proving evidence details and finding summaries cannot become selectors.
- Node-group and accelerator-inventory invariant tests.
- Compiler determinism tests.
- Reference and binding validation tests.
- Topology-artifact schema, digest, subject, and secret-handle tests.
- Materializer and lifecycle registry contract tests.
- Role-specific resolved-plan validation tests.
- Resolver precedence tests.
- Range-boundary tests.
- Ambiguous automatic-selection tests.
- Wrong-platform and wrong-topology tests.
- Explicit override conflict tests.
- Resume provenance tests.
- Secret-redaction tests.
- vLLM parity tests for current DGX Spark, DGX Station, and generic Linux behavior.
- Ollama parity tests for current memory tiers and operating-system placement.
- Installer integration tests for Express selection and resume.

Distributed recipes also require physical evidence under the applicable repository policy.
Passing catalog tests do not replace hardware validation.

## Alternatives

### TypeScript-only catalog

A TypeScript catalog provides compile-time types and can call arbitrary helper functions.
It keeps product data coupled to implementation code.
It also makes external review and generation harder as the combination count grows.

This RFC prefers YAML plus a strict compiler.

### Direct YAML interpretation

Runtime YAML interpretation removes a build step.
It expands the runtime parser and trust boundary.
It also makes release artifacts depend on source-file discovery.

This RFC prefers canonical YAML compiled to packaged JSON.

### Separate inference host probes

Inference-specific OS, runtime, GPU, CDI, or platform probes could expose exactly the values the resolver wants.
They would duplicate the supported readiness contract and could disagree with onboarding.

This RFC consumes the readiness producer from issue #7407 and limits inference-owned probing to serving topology and materialization needs.

### GPU count only

A total GPU count requires one scalar comparison.
It cannot describe node placement, heterogeneous nodes, unified memory, or required fabric properties.

This RFC models nodes, node groups, and accelerators separately.

### Deep inheritance

Recipe inheritance can reduce repeated YAML.
It can also hide the final image, arguments, and security-sensitive settings.

This RFC requires complete recipes and declared bindings.

### General expression language

A general expression language can represent derived settings.
It increases validation and code-execution risk.

This RFC uses bounded operators and allowlisted selection and readiness references.

## Open questions

Maintainers must resolve these questions before implementation becomes approval-ready:

- Should qualified DGX Station direct onboarding and Express use one automatic default?
- Which stable readiness identifiers from issues #7408 and #7410 belong in the first preset registry?
- Which readiness entities may be reused during resume, and what freshness policy applies to each one?
- Which topology qualification identifiers are stable internal contracts?
- Which recipe fields may use bindings in the first schema version?
- Which materializer and lifecycle adapter identifiers belong in the first registry?
- Should agent identity affect server selection or only agent-side context configuration?
- Which workload dimensions have current validated consumers?
- How should a catalog schema change interact with NemoClaw release versioning?
- When should an explicit-only preset become automatic?
- Does the first implementation need a read-only command that prints the resolved plan?

## Decision requested

Maintainers are asked to accept these design directions:

- Repository-owned YAML is the canonical source for managed inference recipes and presets.
- The runtime consumes a compiled canonical catalog.
- The system-readiness report from issue #7407 is the canonical per-node source of observations, capabilities, and platform qualifications.
- Managed inference derives a versioned cluster selection snapshot without creating another public readiness contract.
- Readiness `present`, `absent`, and `unknown` states and freshness semantics are preserved.
- Node and accelerator counts are independent dimensions with range constraints.
- Complex topology checks produce private, code-owned artifacts with versioned typed outputs.
- Presets use explicit priorities and reject unresolved ambiguity.
- Recipes are complete contracts with declared bindings.
- Distributed recipes select allowlisted, versioned materializer and lifecycle adapters.
- Host preparation remains separate from serving-plan resolution.
- Arbitrary external catalogs remain out of scope.
