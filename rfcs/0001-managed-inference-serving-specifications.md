<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# RFC 0001 Managed Inference Serving Specifications

- Status: Draft.
- Authors: NemoClaw maintainers.
- Created: 2026-07-26.
- Discussion: [#7636](https://github.com/NVIDIA/NemoClaw/discussions/7636).
- Related work: [PR #7030](https://github.com/NVIDIA/NemoClaw/pull/7030).
- Implementation: Not started.

## Summary

NemoClaw should define managed local inference defaults in repository-owned YAML specifications.
Code should collect trusted host facts, enforce qualification requirements, validate specifications, resolve one preset, and materialize a serving plan.

The fact model must describe clusters as well as single hosts.
It must represent node count, accelerator count, accelerator placement, memory, operating system, container runtime, and qualified fabric properties.
The model must support new dimensions without adding backend-specific selection branches.

The first catalog should cover the existing managed vLLM and Ollama behavior.
It should preserve current behavior before any default changes.

## Motivation

Managed local inference defaults currently use separate mechanisms.

- [`src/lib/inference/vllm.ts`](../src/lib/inference/vllm.ts) defines vLLM profiles for DGX Spark, DGX Station, and generic Linux NVIDIA GPU hosts.
- [`src/lib/inference/vllm-models.ts`](../src/lib/inference/vllm-models.ts) defines model-specific vLLM arguments and runtime overrides.
- [`src/lib/inference/ollama-model-registry.ts`](../src/lib/inference/ollama-model-registry.ts) selects Ollama models from available memory and a compute constraint.
- [`src/lib/inference/nim.ts`](../src/lib/inference/nim.ts) classifies NVIDIA platforms.
- [`scripts/install.sh`](../scripts/install.sh) contains separate DGX Station Express defaults and operating-system qualification branches.
- [`scripts/prepare-dgx-station-host.sh`](../scripts/prepare-dgx-station-host.sh) owns DGX Station host preparation and qualification.

This structure already contains the concepts of a host profile, model recipe, and runtime override.
The concepts do not share one schema or one resolver.
The installer can therefore select a different default from direct onboarding on the same host.

Distributed configurations make the current split harder to extend.
A two-node DGX Station recipe and a possible eight-node DGX Spark recipe need more than a platform name.
They need node placement, accelerator counts, topology requirements, and distributed serving parameters.

## Goals

This RFC has these goals:

- Define one declarative catalog for managed vLLM and Ollama defaults.
- Represent single-host and multi-host configurations.
- Represent exact values and inclusive ranges for numeric facts.
- Separate observed facts, qualifications, recipes, presets, and resolved plans.
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
- Define a general expression language.
- Permit YAML to execute shell commands or code.
- Define general-purpose cluster provisioning outside managed local inference.

## Terms

### Host fact

A host fact is an observed value.
Examples include operating-system version, node count, accelerator model, and available memory.
A fact does not state whether NemoClaw supports the observed configuration.

### Qualification

A qualification is a named result from code that evaluates a bounded contract.
Examples include a qualified DGX Station operating-system image or a validated private two-node fabric.
Complex security and topology checks should produce qualifications instead of exposing every probe as a preset condition.
A qualification has a versioned output schema, a subject identity, and an output digest.
It may also provide typed values to an allowlisted materializer.

### Serving recipe

A serving recipe is an atomic backend and model execution contract.
It includes immutable artifacts, model identity, arguments, environment, container resources, and readiness expectations.

### Serving preset

A serving preset maps host facts and qualifications to one serving recipe.
It also declares whether selection is automatic, explicit only, or disabled.

### Resolved serving plan

A resolved serving plan is the complete validated result for one install attempt.
Install, resume, status, and diagnostics consume this plan.
For a distributed recipe, the plan contains one role-specific plan per node and names the code-owned lifecycle adapter that may apply it.

### Catalog

The catalog is the compiled set of facts schemas, recipes, and presets shipped with one NemoClaw revision.

## Design principles

### Facts do not contain policy

Fact collectors must report observed values.
They must not choose a model or backend.

### Qualifications remain code-owned

Code must own probes that enforce security or hardware boundaries.
YAML may require a qualification by identifier.
YAML must not reproduce a complex qualification algorithm.

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
    facts.schema.json
    preset.schema.json
    recipe.schema.json
```

The implementation should use this layout:

```text
src/lib/inference/serving/
  catalog.ts
  facts.ts
  lifecycles.ts
  materialize.ts
  materializers.ts
  qualifications.ts
  resolve.ts
  types.ts
  validate.ts
```

The build should write the compiled catalog to the packaged runtime artifacts.
The exact generated path is an implementation decision.

## Host fact model

The host fact document must have a schema version.
Collectors should normalize equivalent observations into stable values.

The model must distinguish node count from accelerator count.
A total accelerator count cannot describe accelerator placement or heterogeneous nodes.

```yaml
apiVersion: nemoclaw.nvidia.com/managed-inference-facts/v1
kind: ManagedInferenceFacts

host:
  os:
    family: linux
    distribution: ubuntu
    version: "24.04"
    imageProfile: nvidia-ai-developer-tools
  architecture: arm64
  containerRuntime: docker

cluster:
  nodeCount: 2
  homogeneous: true

  nodeGroups:
    - id: station-pair
      count: 2
      productFamily: dgx-station
      productGeneration: gb300
      os:
        family: linux
        distribution: ubuntu
        version: "24.04"
        imageProfile: nvidia-ai-developer-tools
      architecture: arm64
      containerRuntime: docker
      accelerators:
        model: NVIDIA-GB300
        countPerNode: 1
        memoryModel: unified

  accelerators:
    totalCount: 2

  fabric:
    kind: cx8-private-rails
    railsPerNode: 2
    minimumBandwidthGbps: 400
    mtu: 9000

qualifications:
  - id: dgx-station.gb300.dual-cx8
    schemaVersion: 1
    status: qualified
    subject: station-pair
    subjectDigest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    outputDigest: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
```

The initial fact vocabulary should use these namespaces:

- `host.os`
- `host.architecture`
- `host.containerRuntime`
- `cluster.nodeCount`
- `cluster.homogeneous`
- `cluster.nodeGroups`
- `cluster.nodeGroups.os`
- `cluster.nodeGroups.architecture`
- `cluster.nodeGroups.containerRuntime`
- `cluster.accelerators`
- `cluster.fabric`
- `agent`
- `workload`
- `qualifications`

New fields require a schema change and a collector or trusted input source.
They do not require a new matching algorithm.

The fact validator must enforce cross-field inventory invariants.
At minimum:

- Node-group `count` values must sum to `cluster.nodeCount`.
- `cluster.accelerators.totalCount` must equal the sum of each node-group count multiplied by its `accelerators.countPerNode`.
- A fact path projected across node groups must be present in every matched group.
- `cluster.homogeneous: true` means that every node group has equal hardware, operating-system, architecture, and container-runtime facts.
- A qualification subject must resolve to a node, node group, cluster, or other subject declared by the fact schema.

The controller-level `host` facts describe the machine running NemoClaw.
Distributed presets must constrain projected node-group software facts when the recipe requires the same operating system, architecture, or container runtime on every node.

## Qualification results

Qualification code may return typed output that a materializer needs but a generic matcher should not interpret.
The dual-Station qualification, for example, must preserve the pretrusted SSH binding, physical node and GPU identities, reciprocal rail endpoints, device names, master address, and RoCE GID index.

Each qualification identifier maps to one code-owned output schema.
The preset matcher sees only the identifier, schema version, subject, and pass or fail result.
Only an allowlisted materializer may consume typed output.

Qualification outputs must follow these rules:

- The producer validates the complete output before returning a passing result.
- The result records a digest over the canonical non-secret output and physical subject identity.
- Secret values are represented by opaque handles and are not included in the digest, catalog, diagnostics, or resolved-plan serialization.
- A preset cannot invent a qualification result or supply its output from YAML.
- A materializer declares the exact qualification identifier, schema version, and output path it accepts.
- Resume revalidates the physical subject and qualification output instead of trusting a saved boolean.

## Fact paths

The fact schema defines each matchable path, value type, and cardinality.
Presets must use a path from that registry.

Dot-separated paths do not provide general object traversal.
A collection path such as `cluster.nodeGroups.productFamily` is a declared projection over the node-group array.
The compiler rejects a collection path with a scalar operator.

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
Operating-system release ranges should use a code-owned qualification or an enumerated value set.

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
      - fact: cluster.nodeCount
        operator: between
        value: [2, 2]

      - fact: cluster.homogeneous
        operator: equals
        value: true

      - fact: cluster.nodeGroups.productFamily
        operator: allEqual
        value: dgx-station

      - fact: cluster.nodeGroups.productGeneration
        operator: allEqual
        value: gb300

      - qualification:
          id: dgx-station.gb300.dual-cx8
          schemaVersion: 1

  plan:
    backend: vllm
    recipeRef: vllm.nemotron-ultra.station-distributed.v0251

    bindings:
      stationTopology:
        valueFromQualification:
          id: dgx-station.gb300.dual-cx8
          schemaVersion: 1
          output: topology
```

Allowed selection values are:

- `automatic`
- `explicit-only`
- `disabled`

An `explicit-only` preset must satisfy every requirement.
Explicit selection does not bypass a qualification.

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
      - fact: cluster.nodeCount
        operator: between
        value: [8, 8]

      - fact: cluster.homogeneous
        operator: equals
        value: true

      - fact: cluster.nodeGroups.productFamily
        operator: allEqual
        value: dgx-spark

      - fact: cluster.nodeGroups.productGeneration
        operator: allEqual
        value: gb10

      - fact: cluster.accelerators.totalCount
        operator: between
        value: [8, 8]

      - qualification:
          id: dgx-spark.gb10.eight-node-fabric
          schemaVersion: 1

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
      type: qualificationOutput
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
- `valueFromQualification` references to allowlisted, versioned qualification outputs.
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

`valueFromQualification` must not copy a secret into the compiled catalog or serializable plan.
A secret-bearing output must resolve to an opaque handle that only the declared lifecycle adapter can consume.

## Materializers and lifecycle adapters

A materializer is a pure, code-owned function.
It accepts one validated recipe, its declared bindings, trusted facts, and typed qualification outputs.
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
- A normalized host fact document.
- An optional explicit backend.
- An optional explicit preset.
- Existing model and backend overrides during migration.

The resolver applies these rules:

1. Validate the fact document and catalog version.
2. If an explicit preset is present, resolve it by identifier.
3. Reject an unknown or disabled explicit preset.
4. Reject an explicit preset that conflicts with an explicit backend or does not meet every requirement.
5. Select the valid explicit preset directly and do not evaluate an automatic fallback.
6. Otherwise, retain automatic candidates that match the explicit backend, when present.
7. Evaluate every retained candidate and discard candidates whose requirements fail.
8. Select the matching candidate with the highest priority.
9. Reject two matching automatic candidates at the highest priority.
10. Resolve recipe references, bindings, materializer, and lifecycle adapter.
11. Apply permitted operator overrides.
12. Validate the complete plan before any pull, download, host mutation, or launch.

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
- Reject unknown fields.
- Resolve every recipe reference.
- Verify unique identifiers.
- Verify immutable image references where an image is required.
- Verify immutable model revisions where the model contract requires one.
- Verify binding names and types.
- Verify qualification-output identifiers, schema versions, and binding paths.
- Verify materializer and lifecycle adapter identifiers and input compatibility.
- Reject unsupported fact paths and operators.
- Reject duplicate or conflicting structured arguments.
- Reject invalid selection and priority values.
- Produce deterministic output.
- Include source-file provenance and a definition digest.

CI must reject a generated catalog that differs from the YAML source.
Tests must exercise the compiler or resolver behavior instead of asserting only YAML text.

## Semantic validation

JSON Schema cannot enforce every catalog invariant.
The compiler must also perform semantic validation.

Semantic validation must include:

- Backend and recipe compatibility.
- Model and architecture compatibility.
- Required qualification identifiers.
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

- Fact schema version.
- Catalog version and digest.
- Candidate preset identifiers.
- Pass or fail for each requirement.
- Selected preset and recipe identifiers.
- Materializer and lifecycle adapter identifiers.
- Qualification identifiers, subjects, schema versions, and output digests.
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
- Required qualification identifiers, schema versions, subject identities, and output digests.
- Materializer and lifecycle adapter identifiers.
- Resolved-plan schema and digest.

The installer revision continues to bind the implementation.
The catalog digest proves the exact data used by that implementation.

Resume must fail when the saved preset cannot be resolved under the saved revision.
It must not silently choose a new automatic default.
Resume must also fail when physical pair identity or a required qualification output no longer matches.
It must reacquire secret-bearing qualification outputs through their trusted producer.

## Installer boundary

The shell installer must not parse YAML.
It should forward explicit preset intent to the Node-based resolver.

Automatic selection should occur after the required fact collectors are available.
The installer may show a generic managed-inference disclosure before resolution.
It should show the resolved backend, model, image source, and download estimate before side effects.

The design should remove model and recipe constants from shell branches.
Shell code may retain host-preparation orchestration that must run before Node onboarding.

## Host preparation boundary

A serving preset may require a qualification.
It must not install drivers, configure Docker, establish SSH trust, or configure network rails.

Host preparation remains a separate phase.
That phase produces facts and qualifications.
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

### How the dual-Station work slots in

[PR #7030](https://github.com/NVIDIA/NemoClaw/pull/7030) is the first concrete migration fixture for the distributed design.
This RFC does not decide that pull request's merge or product-support status.
It assigns the work's existing responsibilities to explicit catalog and code-owned boundaries.

| Current responsibility | Proposed owner |
| --- | --- |
| Pair discovery, reciprocal `/30` CX-8 rail checks, SSH trust, GPU identity, routes, neighbors, jumbo frames, and RoCE GID validation | Code-owned `dgx-station.gb300.dual-cx8` qualification producer and versioned output |
| Immutable vLLM image, model revision, served name, Ray and vLLM versions, TP=1, PP=2, arguments, and readiness expectations | `vllm.nemotron-ultra.station-distributed.v0251` YAML recipe |
| Conversion of qualified nodes, GPUs, rails, addresses, devices, and secret handles into distinct head and worker plans | Code-owned `vllm.dual-dgx-station/v1` materializer |
| Worker-first startup, Ray join, role-specific hardening, ownership inspection, exact-pair reuse, rollback, cleanup, and legacy migration | Code-owned `vllm.dual-dgx-station/v1` lifecycle adapter |
| Explicit peer intent, pair identity, qualification digest, plan digest, and resume compatibility | Resolver input and protected provenance state |

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

### Catalog foundation

Add schemas, compiler types, and synthetic validation fixtures.
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
- Node-group and accelerator-inventory invariant tests.
- Compiler determinism tests.
- Reference and binding validation tests.
- Qualification-output schema, digest, subject, and secret-handle tests.
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

This RFC uses bounded operators and allowlisted fact references.

## Open questions

Maintainers must resolve these questions before implementation becomes approval-ready:

- Should qualified DGX Station direct onboarding and Express use one automatic default?
- Which component owns the canonical host fact document?
- Which qualification identifiers are stable public contracts?
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
- Host facts use a versioned cluster model.
- Node and accelerator counts are independent dimensions with range constraints.
- Complex topology checks produce code-owned qualifications with versioned typed outputs.
- Presets use explicit priorities and reject unresolved ambiguity.
- Recipes are complete contracts with declared bindings.
- Distributed recipes select allowlisted, versioned materializer and lifecycle adapters.
- Host preparation remains separate from serving-plan resolution.
- Arbitrary external catalogs remain out of scope.
