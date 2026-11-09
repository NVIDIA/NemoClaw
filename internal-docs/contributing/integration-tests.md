<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Run Integration Tests

This page covers the [contract and integration layers](testing.md#test-layers): tests that run pinned OpenTofu from a bundle against local fixtures and temporary state.
They create no Docker, OpenShell, Kubernetes, or inference resources; tests that use a real Docker engine are [live tests](live-tests.md#docker-live-suite).
Complete the [build prerequisites](../../docs/build-deploy/build.md) first.

## OpenTofu and Bundle Lifecycle

The contract and integration tests take one input: `NEMOCLAW_TEST_BUNDLE`, the absolute path of a bundle such as the `dist/PLATFORM` directory that `cargo ci bundle` writes.
The bundle supplies the OpenTofu version pinned in `versions.json`, the CLI, and the providers.
Each provider's contract tests run instead the provider Cargo built with them, so they test the checkout without a new bundle; the other providers they need come from the bundle.
Integration tests run the bundle's CLI and providers, so rebuild the bundle after changing either.

To run each whole layer as CI does, four tests at a time, run from the repository root:

```sh
cargo ci bundle
cargo ci contract
cargo ci integration
```

To run one binary or module with Cargo, build the fixture executables first; tests find them beside the test executables:

```sh
cargo build -p nemoclaw-test-fixtures -p nemoclaw-fixture-provider
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-provider --test contract provider_protocol:: -- --ignored
```

Nextest builds every workspace target, including the fixture executables; after `cargo ci tools`, put `.tools/nextest-0.9.151` on `PATH` and narrow the `contract` or `integration` profile with a filter:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo nextest run --workspace --all-targets --profile contract --run-ignored only \
  -E 'binary_id(=openshell-provider::contract)'
```

`nemoclaw-test-fixtures` holds what these tests share: `Bundle` reads `NEMOCLAW_TEST_BUNDLE`, `TofuWorkspace` creates an owned OpenTofu workspace with chosen providers and runs native test files, `openshell` serves a fake OpenShell gateway, and `ssh` holds the fake `ssh` relay and the SSH simulator.
The fake HTTP, engine, and Kubernetes servers in `crates/test-support` are shared with the unit tests.
On failure, read the OpenTofu diagnostic in the test output and check that the bundle matches the checkout before rerunning.

## Contract Tests

Each production provider's `contract` binary, under `tests/contract`, applies its types through OpenTofu against fakes.
Its coverage test is not ignored and runs with the unit tests; the remaining tests are ignored and run in the `contract` step.

Each `tests/contract` directory separates the two kinds of test:

- `hcl/`: scenarios that pass, as authored modules with `.tf` files and [`tofu test`](https://opentofu.org/docs/v1.12/cli/commands/test/) files in their `tests` directory.
- `failures/`: Rust tests of commands that must fail, which `tofu test` cannot expect.

`main.rs` starts each module's fakes and runs it; the other Rust files hold shared fakes and checks of plans and state that `tofu test` cannot show.
A Rust test starts the module's fixtures and runs its test files with `TofuWorkspace`; `openshell::test_against_gateways` runs them side by side, each against its own fake OpenShell gateway.
To run one module, name its Rust test, for example `cargo test -p openshell-provider --test contract standalone_resources -- --ignored`.
A module that observes the fake gateway reads `data.fixture_state` from `nemoclaw-fixture-control`; the integration tests read the same observations, from `openshell::State::observations`.
The data source depends on the module's resources, so OpenTofu reads it after they change and each run checks its own result.
A run that only targets the data source can change the gateway outside OpenTofu, such as `{ change = { forget_registrations = true } }`, before the run that should meet the change.
`tofu test` keeps the state in memory and fails a run on any provider error, so Rust tests keep the checks that need a failed command, a saved plan or its planned actions, or the state file.
A run's outputs are available to later runs only as planned values, so a test compares identities within one run instead.

### vLLM, Ollama, and Host Provider Contract

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-provider --test contract -- --ignored
```

Its modules run the `nemoclaw` types against fake Docker engines, SSH hosts, and model servers:

| Module | Checks |
|---|---|
| `hcl/runtime` | The vLLM, Ollama, and Ollama proxy runtime contracts, and the vLLM launch and requirements, computed from typed settings without any service |
| `hcl/host` | Host checks against a fake engine, health endpoint, and model server: engine facts, image compatibility, container health by engine state, HTTP, or status file, and endpoint readiness; failed checks stop the plan |
| `hcl/storage` | Retained credential storage keeps its authored or generated identity on its volume |
| `provider_protocol` | The fixture provider from `nemoclaw-fixture-provider`, and on Unix the provider against a fake Docker API: network and image planning, including prerequisite changes before saved-plan application |
| `failures/service_capacity` | `vllm_capacity` through an isolated SSH simulator (shared-host overcommit, deferred reads, state kept after failed observations, and cleanup without capacity checks), and Ollama readiness and capacity rejecting a vLLM contract |
| `failures/service_readiness` | Standalone service readiness; see [below](#standalone-service-readiness) |
| `failures/service_storage` | Checks an invalid owner, an unchanged plan of intact storage, missing, foreign, or substituted storage, and a lost creation reply |
| `failures/discovery` | Fabric requirements and compiled discovery that read image metadata |
| `replacement_cleanup` | On Unix, the plans and state the SDK reads after a container replacement whose cleanup is unfinished |

`every_type_has_a_contract_test` requires a contract test for every type the provider serves, or an `ELSEWHERE` entry naming where it is tested instead.

#### Standalone Service Readiness

On Unix, run `cargo test -p nemoclaw-provider --test contract service_readiness:: -- --ignored` with the bundle set as above.
The fixture uses an isolated SSH and Docker simulator and a built-in OpenTofu consumer, without SDK orchestration or an OpenShell gateway.
It checks offline validation, apply-time reads, saved-plan failure, unchanged-service rechecks, bounded timeout, recovery, and teardown without readiness.
The proxy case also uses an HTTP model-metadata fixture and checks delayed initial credentials, container identity, credential permissions, and upstream model drift.

### OpenShell Provider Contract

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p openshell-provider --test contract -- --ignored
```

Its authored modules each have a Rust test:

| Module | Rust test | Checks |
|---|---|---|
| `standalone` | `standalone_resources` | An inference registration and its sandbox: planning without a gateway, recreating a missing registration, profile, or sandbox without replacing what else exists, image and endpoint changes, authentication and secret rotation, and removal without destroy mode |
| `credentials` | `tool_credentials` | Web search and API credentials: profiles, registrations, and keys a sandbox sees, rotation, recovery, a custom header, and removal |
| `sandbox` | `sandbox_settings` | Driver configuration, service exposures and their URLs, and sandboxes without providers |
| `gateway` | `gateway_installation::gateway_settings_plan_without_contacting_a_host` | The Docker gateway launch, engine prerequisites, the Docker gateway's storage, and the managed Kubernetes resources, planned from typed settings; the engine fixture refuses any request but a read |
| `chart` | `chart::*` | The pinned gateway chart rendered by the bundled Helm provider with the SDK's values, which `chart.rs` writes to `inputs/`: the release owns the gateway StatefulSet and no namespace or object NemoClaw prepares; the gateway keeps the chart's UID, or takes the OpenShift namespace's user and group; pull Secret names reach the pod templates and the sandbox driver; and the gateway refuses unauthenticated users and trusts only the deployment's own issuer and audience. Rendering pulls the chart by digest and needs no cluster. |

The generated fixtures in `crates/openshell-provider/tests/contract/fixtures` are the OpenShell resources the SDK compiles for each example with an external gateway, excluding examples whose credentials are read from a managed service's container.
Fixtures that differ only in values, such as the harness a sandbox launches, have the same shape.
The first fixture of each shape is applied against its own fake gateway; it must plan no managed changes after apply, and teardown must remove every sandbox, provider registration, and profile while the gateway keeps the workspace.
`nemoclaw-e2e`'s `openshell_contract_fixtures` test fails when they differ from what the SDK compiles; regenerate them with `NEMOCLAW_REGENERATE_FIXTURES=1 cargo test -p nemoclaw-e2e --test integration openshell_contract_fixtures`.

The `capabilities` tests check gateway preconditions, saved-plan rechecks, and capability reads deferred until bootstrap inputs are known.
The `failures/standalone` tests apply `hcl/standalone/main.tf` through lost create and delete replies, foreign objects, a missing workspace, failed observations, and deferred bootstrap endpoints.
The `failures/api` tests check that invalid API bindings and foreign or substituted credentials stop planning, and that a failed readback recovers; the `sandbox` test checks that settings changed outside OpenTofu replace the sandbox.
The fake gateway refuses to delete a referenced profile or an attached provider, as the pinned API does.
On Unix, the `gateway_storage` test checks Docker gateway storage against a fake engine.
The `gateway_readiness` test checks managed-gateway exit diagnostics, bootstrap state kept after failure, corrected retry, unchanged-apply rechecks, and teardown without the readiness data source.
The `kubernetes_lifecycle` tests apply, refresh, and tear down the managed Kubernetes resources against the in-memory API in `crates/test-support/kube_api.rs`; they write and delete the objects Helm would, and the live Kind suite runs the chart itself.
`every_type_has_a_contract_test` requires a module or test for every OpenShell type, and `every_compiled_type_has_a_fixture` a generated fixture for every type the SDK compiles.

### Fabric Provider Contract

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p fabric-provider --test contract -- --ignored
```

`pi_agent_lifecycle` runs the `hcl/agent` module, a `fabric_agent` that starts a Pi agent in a sandbox: planning does not start it, an unchanged apply does not restart it, a changed configuration replaces the sandbox, removing the agent stops it and keeps its sandbox, and a sandbox that is already gone takes its agent with it. A model changed inside the sandbox is not drift, and a stopped runtime starts again in the same sandbox.
The tests in `failures/agent.rs` check failures: an invalid configuration fails validation at its field without repeating the value, a lost start reply is not retried and recovers in a replaced sandbox, an incomplete runtime check changes nothing, a changed agent without a new sandbox is refused, and a failed start keeps Fabric's message in a private file.
On Unix, the `capabilities` test runs the `capabilities` module, which reads `fabric_harnesses` from a fake Docker engine's image metadata: a compatible image reports its runtime binaries; another platform, or a read policy without the runtime's paths, is unsupported; a missing image is unknown.
`every_fabric_type_has_a_contract_test` requires a contract test for every Fabric type.

## Integration Tests

The integration tests are the ignored tests in `nemoclaw-e2e`'s `integration` binary, `crates/nemoclaw-e2e/tests/integration`, which the `integration` profile selects whole.
They use the local gRPC OpenShell fixture and simulated SSH and Docker hosts.

Choose the directory by what the behavior needs:

- `hcl/`: a [`tofu test` scenario](#tofu-test-cases) for a graph outcome: registrations, bindings, policy, agent configuration, isolation between agents or deployments, unchanged reconciliation, recovery of what the gateway lost, replacement, and cleanup.
- `rust/`: a Rust test for what OpenTofu's test framework cannot observe: the SDK's stage order, saved state and intent, the CLI's output and exit status, export, interrupted and cancelled operations, saved plans, and provider errors, which `expect_failures` cannot expect.

The binary's other modules are offline checks of the fixtures and clients these tests use, and run with the unit tests.

To run the Rust integration tests:

```sh
cargo build -p nemoclaw-test-fixtures -p nemoclaw-fixture-provider
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test integration -- container_service:: deployment:: export_observations:: fabric_deployment:: multi_agent:: --ignored
```

Append a test name to run one scenario, or `--test-threads=4` to match CI's concurrency.
The fixtures return protocol responses; they do not establish agent inference, native file drift detection, or tool enforcement, which Fabric tests.

| Module | Checks |
|---|---|
| `deployment` | SDK and CLI lifecycles: the CLI's text and JSON results on a real bundle, a gateway change between plan and apply, interrupted creation, a sandbox startup failure reported through the CLI and recovered, admission and observation failures, credential redaction, and destroy after a failed first apply. The CLI's formatter tests and the SDK's reporting tests own the wording of each result and authored provider labels. One test applies a document with integrations, an authored inference API, native harness settings, grants, service exposures, and a tool limit; the CLI exports it, an unchanged reapply changes nothing, and each kind of observed drift stops plan and export without changes |
| `export_observations` | Export through provider refresh without the gateway's readiness checks or runtime probes, and export, preview, and teardown of a credentialed deployment without its secret. The SDK's unit tests own how observations become an exported document, including search scopes and observed drift. |
| `fabric_deployment` | A runtime declaration missing from saved state, and a rejected first start whose message stays in the deployment's diagnostics, followed by a corrected document that replaces the sandbox |
| `multi_agent` | Three OpenClaw agents: one agent's rejected start is reported alone and its retry replaces only it, and another owner's label on one sandbox stops every operation before it changes anything |
| `fabric_bridge` | The provider's `fabric-agent-ctl` client: the image's own command and environment, input on stdin, and uncertain invocations never replayed. These tests are not ignored and run with the unit tests |
| `remote_service` | Services on simulated SSH hosts; see [SSH service fixtures](#ssh-service-fixtures) |
| `container_service` | On Unix, `kind: container` services behind a managed Docker gateway, with the bundle's Docker provider against a fake engine that keeps what it creates: apply waits for HTTP, runtime-status, and Docker HEALTHCHECK readiness and leaves nothing observing the engine; an unchanged apply changes nothing; unhealthy, unknown, timed-out, and interrupted setups fail with the provider's reason, and a retry creates no second container; a changed application replaces only its container and keeps its volume; apply refuses to remove a service; destroy deletes the application containers and volumes, keeps the gateway's storage and another owner's objects, and the deployment applies again |
| `helm_recovery` | On Unix, destroy and its recovery against an in-memory Kubernetes API, after failures and cancellation; see [below](#helm-release-recovery) |
| `hcl_integration` | Each scenario in `crates/nemoclaw-e2e/tests/integration/hcl/tests` under `tofu test`; see [`tofu test` cases](#tofu-test-cases) |

In `deployment`, `cli_terminal_outputs_preserve_lifecycle_and_json_contract` checks text plans, JSON apply, unchanged text apply, JSON plan completeness, text destroy, and repeated JSON destroy against one fixture state.
`gateway_change_between_plan_and_apply_preserves_resources_and_allows_teardown` changes the gateway driver after planning to check OpenTofu's apply-time check, recovery, and teardown.
`rejected_policy_fails_promptly_with_context_and_allows_recovery_or_destroy` checks a simulated gateway admission rejection with sandbox context in text and JSON output, retained bindings, recovery, and destroy.

In `multi_agent`:

- `one_failed_agent_is_reported_alone_and_its_retry_replaces_only_it` replaces two sandboxes in an update, and Fabric rejects one agent's start.
  The CLI's JSON report names only the failed sandbox, says that changes may already have been made, and leaves out Fabric's message, which `diagnostics/fabric-SANDBOX.json` keeps.
  The other replacement finishes, the unchanged agent is neither replaced, stopped, nor restarted, and the retry replaces only the failed agent's sandbox.
- `a_foreign_owner_on_one_agent_stops_planning_without_touching_the_others` gives one sandbox a different owner label on the gateway.
  Plan, `plan_destroy`, export, apply, and destroy each fail on the ownership change without changing `terraform.tfstate`, `intent.json`, the gateway, or any sandbox.
  After the label is restored, destroy finishes.

### `tofu test` Cases

`hcl_integration` runs each scenario in `crates/nemoclaw-e2e/tests/integration/hcl/tests` against the fixtures, with one shared runner:

```sh
cargo build -p nemoclaw-test-fixtures -p nemoclaw-fixture-provider
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test integration -- --ignored --test-threads=1 hcl_integration::
```

A scenario is an integration test file, `tests/integration/hcl/tests/<scenario>.tftest.hcl`, whose runs name the modules they apply.
The runner prepares each module a test file names, in the same path of a work copy of the integration root:

| Module source | Input | What the runner writes |
|---|---|---|
| `./cases/<name>` | `cases/<name>.yaml`, shared with the live E2E scenarios that `hcl_live::case` runs from `tests/e2e/hcl/tests` | The document compiled by the SDK as `nemoclaw.tf.json`, beside a copy of `tests/integration/hcl/harness/main.tf` |
| `./examples/<path>` | A NemoClaw document, `examples/<path>.yaml` | The same, so an example is tested unchanged |
| `./examples/<path>` | An authored HCL directory, `examples/<path>` | A copy, with the bundle's version pinned on each NVIDIA provider, which a development bundle's pre-release providers need |

Before compiling a document, the runner points its gateway, any engine it names, and its inference endpoints at the fixtures.
An external gateway loses its credential and TLS, because the fixture gateway serves plaintext gRPC.
A sandbox described by image metadata runs the fixture image, which the runner's metadata bundle describes.
The runner supplies a fixture value for each credential a document names and for each `credential_env = "NAME"` line in the test file.

The harness declares the fixtures through the `fixture` provider's one data source, `fixture_state`, named `setup`, and reads what they recorded through the `observed` module:

| Module | Purpose |
|---|---|
| `tests/integration/hcl/modules/fixtures` | From the document, the gateway's compute driver and, with a managed Docker gateway, what a mocked Docker provider would leave on the engine: images, each service image with the architecture its document requires, the gateway container, and each service's ready container with its generated key. Outputs the owner, the engine object prefix, and each service's container. |
| `tests/integration/hcl/modules/observed` | Outputs the registrations and `agents` the gateway holds, by name, each agent with its latest Fabric `start` command and decoded configuration, plus OpenShell, engine, and upstream records: current sandbox IDs, gateway effects, Fabric starts, and the most sandboxes created at once. Credential values appear only by source: `env:NAME` or `file:CONTAINER:PATH`. A test file for an authored example applies it with `declare` to declare the fixtures and read their endpoints. |

Harness variables change what the fixtures do:

| Variable | Effect |
|---|---|
| `compute_driver` | The driver the gateway reports instead of the one the document requires |
| `sandbox_create_delay_ms` | How long the gateway takes to create each sandbox, so that overlapping creations show |
| `sandbox_delete_delay_ms` | How long the gateway takes to answer each sandbox deletion |
| `permit_destroy` | The `openshell` and `fabric` providers' `destroy`, which the runner sets from it as the SDK's teardown graph does |
| `baseline` | What an earlier run observed, for assertions to compare |

A test file usually runs four steps:

1. `fixtures` targets `data.fixture_state.setup`, so the fixtures exist before the deployment's first plan.
2. `deploy` applies.
3. `verify` applies again and asserts against what deploy produced.
4. `teardown` sets `permit_destroy = true`. OpenTofu's cleanup uses the last applying run's variables.

A plan-only scenario needs no apply runs.
A run's `module.observed` is read when the run plans, so it shows what the previous run left.
A scenario that checks change, recovery, or isolation asserts each outcome in the run after the one that caused it.

OpenTofu 1.12's test framework sets these limits:

- Assertions cannot reference other runs. A test file passes an earlier run's `gateway` or `baseline` output, or the `observed` module's `openshell` output, in as the `baseline` variable. A plain second apply does not prove that nothing changed, so the scenario that owns unchanged reconciliation compares gateway effects and Fabric starts with that baseline.
- OpenTofu keeps only the latest applying run's outputs of each module.
- OpenTofu's cleanup evaluates the last applying run's variables again, and silently skips the destroy when one references a run whose outputs it no longer keeps. Keep run references out of a module's last applying run; the runner's teardown check reports what such a skip leaves.
- Test files compare collections as lists or sets: a JSON array is a tuple, which never equals a list.
- A run that is expected to fail lists the checkable object in `expect_failures`; a provider error fails the run. A targeted plan does not evaluate locals or module outputs.

Docker scenarios mock the Docker provider by its generated alias and give mocked resources the IDs the `fixtures` module declares.
On Unix, one fixed engine socket, `/tmp/nemoclaw-integration/engine.sock`, gives every scenario the same alias and image addresses.
On Windows, the engine is `ssh://127.0.0.1:PORT`, which the `nemoclaw-fixture-ssh` relay that the integration step puts on `PATH` forwards. Managed Docker gateway storage takes only a local engine socket, so Windows skips scenarios with a managed Docker gateway and runs the others.

The runner deals the scenarios round-robin across four tests, `scenarios_in_shard_1` to `scenarios_in_shard_4`, so each stays within the integration per-test budget. They share the fixed engine socket, so nextest's `hcl-integration` test group runs one at a time on a runner, and `cargo test` needs `--test-threads=1`.
Each shard runs `tofu init` once and then `tofu test -filter=tests/<scenario>.tftest.hcl` for each scenario, resetting the fixtures between scenarios.
After each scenario it checks that at least one run passed and that teardown failed only on storage NemoClaw retains. It also checks that the gateway holds no objects or Fabric runtimes, naming any it finds, that the engine deleted no storage and received no unrecognized request, and that no fixture credential appears in output or diagnostics.
When a scenario fails, the runner keeps its work directory and writes redacted OpenTofu output and observations to `evidence/<scenario>`, or under `NEMOCLAW_INTEGRATION_EVIDENCE` when it is set.
In CI / Bundle, each `Integration` job sets `NEMOCLAW_INTEGRATION_EVIDENCE`. The runner records each scenario's result there, and the job summary lists the results. A failed job uploads that directory as `hcl-integration-evidence-PLATFORM-SHARD-ATTEMPT`, kept for 7 days.
An upstream operation the fixtures cannot simulate needs fixture support once, in `tests/integration/tofu_test/fixtures.rs`.

Each scenario runs the real OpenShell, Fabric, and host providers, plus the vLLM or Ollama provider where it applies:

| Scenario | Checks |
|---|---|
| `docker-openclaw-nvidia` | The live hosted document: two OpenClaw agents on NVIDIA hosted inference. Covers gateway storage on the fake engine, the mocked gateway container and sandbox image read by ID, and the shared registration with the fixture credential. Also checks each sandbox's binding and policy, and each agent started through `ExecSandbox` with its compiled configuration. |
| `docker-openclaw-vllm` | The live local document: an unauthenticated vLLM service with an isolated OpenClaw sandbox. There is only a data volume and no credential storage, and readiness reads the status file and no key. The registration has no credential, and the agent has its model and address. |
| `docker-openclaw-vllm-bearer` | A vLLM service with bearer authentication. The credential storage is created on the engine and mounted by the container, and readiness reads the status file and the generated key. The registration holds that key under the sandbox's name for it, and the agent gets its model, address, and key name. |
| `docker-openclaw-ollama` | A managed Ollama service. The container's Docker inputs come from the Ollama runtime launch, the runtime image is found on the engine, and readiness comes from the container's status file. The registration is at the service address without a credential, the sandbox's policy allows that address, and the agent gets its model and address. |
| `docker-hosted-ollama-two-agents` | An OpenClaw agent on hosted inference and a Hermes agent on Ollama. There are two registrations, and each sandbox is bound to and may reach only its own provider. Each agent starts once in its own sandbox with its own harness and configuration. |
| `docker-hermes-kept-state` | A Hermes agent whose sandbox mounts a volume on `/sandbox/artifacts` and one on `/sandbox/skills`, which its `skills.paths` lists. Replacing the sandbox gives the new one the same mounts, and the agent starts again under the same name with kept state and the same skills paths, so Fabric hands it the same state folder. Whether Hermes finds its sessions and skills there needs real Hermes. |
| `docker-ollama-proxy` | An authenticating proxy in front of an existing Ollama daemon, which the fixture upstream lists the model for. The registration reads the key from the proxy's retained `/data` volume, and no resource or readiness check keeps it in OpenTofu state. An unchanged apply changes nothing; replacing the proxy container keeps the volume, the key's registration, and the agent's sandbox. |
| `docker-vllm-shared-two-agents` | One authenticated vLLM service shared by OpenClaw and Hermes agents. Each harness has its own registration holding the generated key under its own sandbox name. Each sandbox names only its own registration, and each agent starts with that key name. |
| `openshift-external-two-providers` | An OpenShift gateway with an Anthropic Messages provider and an NVIDIA provider. Each registration has its own API, base URL, and credential. The OpenClaw agent has both routes, the Hermes agent has one, and their sandboxes share no binding. An unchanged apply keeps every sandbox, registration, and agent start. |
| `kubernetes-gateway-driver-mismatch` | A Kubernetes document against a gateway that reports Docker. The workspace precondition rejects the plan, and the gateway's incompatibility names the Kubernetes driver. Nothing reaches OpenShell, Fabric, or the upstream. |
| `kubernetes-external-three-agents` | `examples/kubernetes/external-gateway.yaml`, unchanged: three agents share one registration holding the credential from `INFERENCE_API_KEY`, and each starts with its own name; independent sandboxes are created at the same time, and no sandbox runs an inference or runtime probe. An unchanged apply changes nothing on the gateway and starts no agent. Replacing one sandbox stops and starts only its agent |
| `kubernetes-slow-sandbox-delete` | The gateway takes 31 seconds to answer a sandbox deletion during a replacement: the provider deletes it once, without asking again, and then creates the replacement |
| `gtc-dc-dgx-spark`, `gtc-dc-dgx-station`, `gtc-dc-windows-wsl2-rtx-spark` | The Hermes, OpenClaw, and Deep Agents examples in `examples/gtc-dc` for that target, unchanged and only planned. Each plan creates the managed Docker gateway, the Nemotron Super vLLM service, which the vLLM provider validates for the target's hardware profile, and one sandbox with the example's harness whose agent uses that service's address and model. GPU access, the model download, and inference need the target host |
| `gtc-dc-kubernetes-amd64` | `examples/gtc-dc/kubernetes-amd64.yaml`, unchanged and only planned: the existing gateway supports the Kubernetes driver, and the OpenClaw and Hermes sandboxes' agents use the hosted NVIDIA model. Its HCL equivalent is not planned, because it names gateway TLS references and the fixture gateway serves plaintext gRPC |
| `external-multiple-providers` | Two deployments on one gateway. The researcher attaches its hosted and local registrations, and the writer only the local one. The second deployment has its own workspace, each registration carries its deployment's owner, and each sandbox attaches only its own workspace's registrations. Applying the first deployment again after the second changes nothing |
| `travel` | `examples/hcl/travel` applied unchanged with the Docker provider mocked: Ollama readiness against the fixture upstream listing the model, the registration at the address sandboxes use, the sandbox's policy, and the Pi agent's name, model, and instructions. An unchanged apply changes nothing on the gateway and starts no agent |
| `travel-team` | `examples/hcl/travel-team` applied the same way: four registrations, each role's attachments, grants, and toolsets, and a hosted-model change that replaces only the scheduler's and buyer's sandboxes |

In every scenario except the authored examples and the Ollama proxy, whose readiness lists the model, the inference upstream receives no request.
The scenarios do not invoke agents or perform inference; the live E2E suites do.
The vLLM and Ollama runtimes are represented by declared containers and files, not run.
The OpenShift scenario does not exercise gateway TLS or bearer credentials.

### Helm Release Recovery

The `helm_recovery` tests run the bundle's OpenTofu and Helm provider against the in-memory Kubernetes API in `crates/test-support/kube_api.rs`, then call the SDK's public `destroy`, `plan_destroy`, `export`, and `apply`.
Installing a release through `apply` would pull the pinned chart, so each test starts from an interrupted runtime apply with a fixture release, which the Helm provider imports.
The SDK's test-only `test-scenarios` feature builds that starting state; `nemoclaw-e2e` enables it in its dev-dependencies, so the tests need no extra flag.
On Unix, run them with:

```sh
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/bundle \
  cargo test -p nemoclaw-e2e --test integration -- --ignored --test-threads=4 helm_recovery::
```

`cargo test` runs the tests as threads of one process, and on Linux a child that one thread forks can briefly hold the deployment lock of another test, which then fails with "another operation holds the deployment lock"; `--test-threads=4` keeps that rare.
Nextest, which CI uses, runs each test in its own process.

Each test that makes destroy fail or stop ends by removing the cause, if any, and running destroy again, which must finish: a failed destroy must leave the deployment recoverable, not only unchanged.
Every test also starts with objects that belong to someone else: a second deployment's namespace, key-encryption key, and gateway claim, and, in the fixture deployment's namespace, another release's Helm record and a ConfigMap the second deployment owns.
No request in the test may write to any of them, and the final destroy must leave each of them as it was.

| Module | Checks |
|---|---|
| `helm_recovery` | An outage or a permission failure before planning keeps the Helm release binding, and after the saved plan the binding is restored; cancellation after the release is deleted keeps a resumable checkpoint; a preview leaves an interrupted destroy unchanged and a retry recovers it |
| `helm_recovery::destroy_faults` | An authentication failure (HTTP 401) before planning, after the saved plan, or after it on the issuer's ConfigMap reads alone stops destroy, keeps the issuer, and lets a retry finish; cancelling at the first refresh returns promptly while the API is unreachable and changes nothing |

### SSH Service Fixtures

Run `cargo test -p nemoclaw-e2e --test integration remote_service:: -- --ignored` with the bundle set as above.
The tests exercise the bundled CLI and providers with an isolated Docker-over-SSH simulator and the OpenShell fixture, for remote models and Ollama, managed Pi, and bearer credentials.
They check recovery after failed startup, export and unchanged reapply, failed observation without lost bindings, and replacement of credentials outside state.
Destroy removes disposable containers and service networks while retaining storage; the partial-runtime tests tear down after failed creation without first creating the missing compute.
`unverified_vllm_images_are_checked_after_pull_before_storage` checks that an image is rejected after pull without creating storage or compute, and that the recorded image binding is cleaned up; the image check after pull and the storage it protects are the same for Ollama.
The remote vLLM scenario checks that apply sends no generation probes; Fabric owns native service startup, authentication, configuration, and protocol checks.
Each runtime-independent check runs in one scenario. The SDK's runtime tests own the Preserve and Recreate decision for every model kind; the Ollama scenario keeps a real plan reaching it, and the SDK's `runtime_compile` tests own where a remote service publishes its port.
Runtime status and Docker responses are simulated; the tests do not download or serve a model.

## Other Fixture Tests

These unit and image tests use local fixtures for the same features.

### Ollama and Platform Fixtures

Managed Ollama's runtime, provider, and SDK tests use local registry, capacity, configuration, and runtime-plan fixtures, not live containers or model downloads.
They cover immutable model resolution, bounded readiness, retained storage, service references, independent installer resources, and provider connection resolution:

```sh
cargo test -p nemoclaw-runtime ollama
cargo test -p nemoclaw-provider --lib
cargo test -p nemoclaw-sdk --test integration -- service_references:: multiple_providers::
```

The `docker-ollama-proxy` [scenario](#tofu-test-cases) checks the managed proxy through its production provider graph: its key stays in its retained volume and out of OpenTofu state, an unchanged apply changes nothing, and replacing its container keeps the key and registration. The `nemoclaw-provider` contract test `standalone_proxy_readiness_rechecks_identity_and_credentials_without_sdk_or_gateway` refuses a stopped proxy, a rewritten key, a replaced container, or a changed model, and `missing_foreign_or_substituted_storage_stops_plan_and_apply_without_changing_state` refuses a lost or substituted key volume.

The OpenShell and Fabric backends' tests against the fake gateway, in each provider's `src/fake_gateway_tests.rs`, run in the default workspace suite; they include bound exec identity and a deadline for an exec stream that never finishes.
Launch compatibility runs there too.
`agent_compatibility` checks that the launch serves Fabric's bridge without naming an agent, harness selection, and default policy restrictions without frozen launch snapshots.
The separately scheduled Fabric lifecycle cases and installed-adapter image tests exercise the supported harnesses.
The `tls` test generates certificates and verifies both trust directions and bearer references through a real TLS connection.

The `CI / Bundle` matrix builds and executes bundles on Linux ARM64/x64, macOS ARM64, and Windows x64.
CI's protocol and lifecycle fixtures do not establish local Docker, Podman, GPU, or real model availability on those platforms.
Report build results separately from runtime test results.


### Runtime Boundaries

Runtime separation has focused checks:

```sh
cargo test -p nemoclaw-runtime
cargo test -p nemoclaw-sdk --test integration -- runtime_boundaries::
```

The supervisor tests use an ordinary owned process and validated memory thresholds, without a DGX Spark document.
They exercise readiness, pressure, failed observations, cancellation, and the loading deadline.
Cancellation must leave a neighboring process alive.

The backend HTTP fixture rejects unavailable, unauthorized, and redirect responses before accepting readiness.
The executable test rejects invalid `NEMOCLAW_RUNTIME_SPEC` input and the removed environment alias without starting model work.
Runtime contract tests check field/version diagnostics without configuration values or user-defined map keys; provider fixtures check read-only image compatibility and distinguish absence from authentication or transport failure.

The recipe test checks declared serving arguments and capacity, and rejects model/backend/hardware combinations outside the declared compatibility requirements.
The [live image-change test](live-tests.md#spark-and-fabric) requires plan and apply to replace only the inference process.
Managed-resource fixtures check storage identity and explicit recovery; the recipe tests verify prepared data before reuse.
The fixture checks that the supervisor runs independently of the CLI; it does not test another real serving backend.


### Fabric Discovery and Execution

The image's [reference tests](../../image/fabric/test_reference.py) run NemoClaw's test adapter through Fabric's real `fabric-agent-ctl`.
The SDK's [compatibility tests](../../crates/nemoclaw-sdk/tests/fabric_compatibility.rs) check an image catalog's adapters, revision and filesystem requirements; NemoClaw doesn't plan adapter settings.


### Inference API Fixtures

Native adapter protocol and configuration tests belong to [Fabric](https://github.com/NVIDIA/NeMo-Fabric/tree/316fbdfbd7ac9eb63ffd52023ab4464f2d23e938/tests), alongside the implementation.
The [image source checks](testing.md#image-source-checks) cover NemoClaw packaging separately.


### Hermes Relay Tracing Fixture

Hermes Relay tracing is configured and tested by Fabric's Hermes adapter.
Its trace files do not establish a native API listener or a fresh runtime health observation.
Live Relay and OpenShell behavior need separate qualification at the selected Fabric revision.
