<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Using the Providers From Your Own OpenTofu Project

Teams that keep OpenTofu configuration in their own repositories and apply it from their own pipelines can use NemoClaw's providers directly, without the CLI or SDK.
Your repository holds the HCL, and OpenTofu keeps the state in any backend it supports.
This guide covers installing the providers, keeping state, running from a pipeline, passing credentials, replacing a sandbox with its agent, and tearing the configuration down.

The examples come from [`examples/features/travel/hcl`](../../examples/features/travel/hcl/main.tf), a Pi agent in an OpenShell sandbox answering with a local Ollama model, and [`examples/features/travel-team/hcl`](../../examples/features/travel-team/hcl/README.md), six agents with their own sandboxes, models, and grants.
An integration test applies each example unchanged with the bundle's providers, a mocked Docker provider, and a fixture gateway, image engine, and model server.
As the [provider reference](../references/provider.md#resource-and-state-ownership) states, no test qualifies a complete deployment from hand-written HCL on live resources.
The steps use OpenTofu: the provider addresses are under `registry.opentofu.org`, and the providers are not tested under Terraform ([#14725](https://github.com/NVIDIA/NemoClaw/issues/14725)).

## Choosing a Path

Both paths run the same providers.
They differ in who writes the configuration, where the state lives, and which checks surround each operation:

| | Your Own OpenTofu Project | NemoClaw CLI or SDK |
|---|---|---|
| Configuration | HCL that you write, review, and keep in your repository | YAML that the SDK compiles into a generated graph |
| State | Any backend OpenTofu supports, locked by that backend | A local [state directory](state.md#local-deployment-files), locked by NemoClaw; remote backends are not supported |
| OpenTofu | The bundle's `libexec/tofu` or your own installation, run by you or your pipeline | The bundle's, run by the SDK |
| Lost creation replies | A create whose reply is lost can leave an object on the gateway that OpenTofu state does not record; nothing guards against it ([#14726](https://github.com/NVIDIA/NemoClaw/issues/14726)) | The SDK's pending-creation guard records the OpenShell and Fabric objects it might create before each apply, and keeps a lost reply's record until a later operation matches it with a saved binding; refer to [Recovering an Interrupted Operation](usage.md#recovering-an-interrupted-operation) |
| Ownership generations | Each OpenShell, vLLM, and Ollama object the providers create carries an `owner` and a `generation` that identify it. When the HCL omits them, the provider generates them during apply; after a lost reply, the next apply generates new ones and stops at the object the lost reply created, as described for [credential storage](../references/provider.md#vllm-and-ollama-types) | The SDK chooses each object's `owner` and `generation` and records them before OpenTofu runs |
| Plan checks | You review each plan; `prevent_destroy` protects a resource only while its declaration stays in the configuration | The SDK checks each plan against the deployment's scope, retained bindings, and recovery rules before applying it, and refuses to remove retained storage |
| Destroy | `tofu destroy` deletes every object the configuration manages, including volumes such as model caches. With a managed Kubernetes or OpenShift gateway, a plain `tofu destroy` fails at plan because the provider never deletes `openshell_kubernetes_storage`, so [teardown](#tearing-the-configuration-down) uses a targeted destroy that keeps it | `nemoclaw destroy` keeps model caches, credential volumes, and gateway storage, as [retained resources](state.md#understanding-the-retained-resources) describes |
| Recovery and export | OpenTofu state is the only record, apart from the Kubernetes state directory that [Keeping State in Your Backend](#keeping-state-in-your-backend) describes | The SDK keeps the deployment's intent and operation progress beside OpenTofu state for recovery, and `nemoclaw export` writes the observed configuration back as YAML |
| Graph | You write each resource, as the examples do | One document becomes the whole graph, including managed gateways and model services, image checks, readiness reads, and sandbox replacement |

Choose your own project when your team needs its own repository, its own pipelines, or a remote state backend.
Choose the [CLI](../references/cli.md) or [SDK](../references/sdk.md) when one YAML document can describe the deployment and you want the SDK's checks.

## Installing the Providers From a Bundle

The providers are not published yet ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)), so OpenTofu installs them from a NemoClaw bundle's `providers` directory, used as a filesystem mirror.
Use the providers, agent images, and runtime images of one release, as [compatibility](../references/compatibility.md#using-one-release-together) describes.

Before you start, you need:

- A bundle for the platform that runs OpenTofu: the unpacked `dist/PLATFORM` directory of a [release archive](../get-started/install.md), or a copy of a bundle [built from source](build.md#building-a-native-bundle), because the next build replaces `dist/PLATFORM`.
- An OpenShell gateway at the version the release pins, with exactly one initialized compute driver matching `required_compute_drivers`, as [Gateway Capabilities](../references/provider.md#gateway-capabilities) describes.
- Agent and runtime images from the same release, pinned by digest.
- The OpenShell version and image pins: the release's [`version-pins.json`](../references/compatibility.md#using-one-release-together), or for a source-built bundle, the repository's `versions.json` at the commit the bundle came from.
- OpenTofu 1.12 or a later 1.x release, which the examples require; the bundle's `libexec/tofu` is the version its tests use, and the manifest records it as `OpenTofu`.
- `jq`, to read the bundle's manifest.

The commands write `tofu` for whichever OpenTofu you run.
To install the providers, perform the following steps from your project's root directory:

1. Read the providers' version from the bundle's manifest:

   ```sh
   jq -r .Version /absolute/path/to/bundle/manifest.json
   ```

   A release archive reports its tag without the leading `v`, such as `0.1.0-rc.1`.
   Another CI build reports a version numbered by its run, such as `0.1.0-3011`, and a bundle you build reports `-dev.` and a hash of its sources, such as `0.1.0-dev.9be3917c1bbe5321`, so the version changes with every build or source change.

2. Pin each NVIDIA provider to that exact version.
   This is the travel example's `terraform` block with the pins added; replace `0.1.0-rc.1` with the version that step 1 printed:

   ```hcl
   terraform {
     required_version = "~> 1.12"
     required_providers {
       docker    = { source = "registry.opentofu.org/kreuzwerker/docker", version = "4.7.0" }
       ollama    = { source = "registry.opentofu.org/nvidia/ollama", version = "0.1.0-rc.1" }
       openshell = { source = "registry.opentofu.org/nvidia/openshell", version = "0.1.0-rc.1" }
       fabric    = { source = "registry.opentofu.org/nvidia/fabric", version = "0.1.0-rc.1" }
     }
   }
   ```

   OpenTofu selects a pre-release version, such as a release candidate's or a development bundle's, only when the constraint names it exactly.

3. Write an OpenTofu CLI configuration file outside the project, such as `nemoclaw.tfrc`, that installs the NVIDIA providers from the bundle and every other provider from its registry:

   ```hcl
   provider_installation {
     filesystem_mirror {
       path    = "/absolute/path/to/bundle/providers"
       include = ["registry.opentofu.org/nvidia/*"]
     }
     direct {
       exclude = ["registry.opentofu.org/nvidia/*"]
     }
   }
   ```

   The bundle also holds the Docker and Helm providers that generated graphs use.
   To install those from the bundle too, add `registry.opentofu.org/kreuzwerker/docker` and `registry.opentofu.org/hashicorp/helm` to both lists.
   If OpenTofu already reads a CLI configuration file in your pipeline, add the `provider_installation` block to that file instead, because the next step replaces it.

4. Point OpenTofu at the file and initialize the project:

   ```sh
   export TF_CLI_CONFIG_FILE=/absolute/path/to/nemoclaw.tfrc
   tofu init
   ```

   OpenTofu lists each NVIDIA provider as installed at the pinned version and labels it `unauthenticated`, because no registry signed it.

`tofu init` records each provider's checksum in `.terraform.lock.hcl`; commit that file with the configuration.
OpenTofu rejects provider files whose checksum differs from the recorded one, even at the same version.
Use copies of the same bundle for each platform on every runner and workstation.

After moving to a bundle with another version, update the pins and run `tofu init -upgrade`.
Without `-upgrade`, `tofu init` refuses a lock file whose versions no longer match the pins.
After moving to a bundle whose providers keep their version but have other files, remove the NVIDIA providers' entries from `.terraform.lock.hcl` and run `tofu init` again.
After either move, record the other platforms' checksums again, as [Running From CI/CD](#running-from-cicd) describes.

## Keeping State in Your Backend

The providers do not depend on the state backend, so the configuration can use any backend OpenTofu supports.
Add it to the same `terraform` block as in any OpenTofu project; refer to OpenTofu's [backend configuration](https://opentofu.org/docs/language/settings/backends/configuration/).

State holds resource identities and settings.
For credentials, NemoClaw's providers store the names of environment variables, never their values.
Other providers in the same configuration, such as Docker, store what you pass them.
Protect state like any OpenTofu state.

Choose a backend that locks state.
The CLI's lock covers only its local state directory, so in your project the backend's lock is what keeps two runs from changing the same state at once.
Neither lock stops another client of the same gateway from changing its objects.

Keep this state separate from every CLI or SDK deployment.
Do not point the project at a NemoClaw state directory, and do not edit an SDK-generated graph.
`tofu import` is not supported, and the providers do not adopt objects they did not create.
An existing CLI deployment cannot be handed over to your project yet ([#14721](https://github.com/NVIDIA/NemoClaw/issues/14721)).

On a shared gateway, each project, and each OpenTofu workspace such as staging or production, needs its own OpenShell workspace name.
The travel team takes the name from `var.workspace`, and the travel example names its OpenShell workspace `travel`.
Two copies of the travel example on one Docker engine also collide on its container and volume names and its host port.

HCL that installs a managed Kubernetes or OpenShift gateway also keeps that gateway's ownership receipt and development credentials in the directory that `NEMOCLAW_KUBERNETES_STATE` names.
Keep that directory with the state, as the [GTC DC example](../../examples/guides/nemotron-super.md#amd64-kubernetes-with-nvidia-cloud-inference) describes, because a runner that starts empty does not have it.

## Running From CI/CD

A pipeline job runs the same commands as a workstation, so it needs the same inputs:

- OpenTofu, the bundle for the runner's platform, and the CLI configuration file, with `TF_CLI_CONFIG_FILE` naming it.
- Network access to the gateway endpoint and to each container engine the configuration names, such as the engine that holds the agent images.
- Network access to each model endpoint that a readiness data source polls; the travel example's defaults poll `127.0.0.1`, so they need the job to run on the model's host.
- The environment variables that the configuration names for credentials, as [Passing Credentials](#passing-credentials) describes.

Plan changes no runtime resources, so a pipeline can stop for review between `tofu plan -out` and `tofu apply`.
Planning reads the gateway, so plan jobs need the gateway's credential and TLS variables, not only apply jobs.
An endpoint readiness read waits up to 32,400 seconds by default for its model; set its `wait_timeout_seconds` or a job timeout.

`data.openshell_gateway` reports `compatible` and `incompatibility` without failing, and the travel examples do not check them.
To stop a plan at an incompatible gateway, as generated graphs do, add a postcondition:

```hcl
data "openshell_gateway" "current" {
  endpoint                 = var.gateway_endpoint
  required_compute_drivers = ["docker"]
  lifecycle {
    postcondition {
      condition     = self.compatible
      error_message = "The gateway is incompatible: ${self.incompatibility}"
    }
  }
}
```

Use the same gateway endpoint from every runner and workstation.
Objects keep their gateway connection in state, and the provider treats a different endpoint as a different gateway.
It replaces sandboxes and the other objects it can recreate, and the OpenShell workspace refuses the change.

`tofu init` records the NVIDIA providers' checksums only for the platform it runs on.
Because the providers are not published, add each other runner platform's checksums from that platform's bundle, from your project's root directory:

```sh
tofu providers lock \
  -fs-mirror=/absolute/path/to/linux_amd64/bundle/providers \
  -platform=linux_amd64 \
  registry.opentofu.org/nvidia/ollama \
  registry.opentofu.org/nvidia/openshell \
  registry.opentofu.org/nvidia/fabric
```

List the NVIDIA providers that your configuration requires.
The command keeps the checksums already in `.terraform.lock.hcl`.

## Passing Credentials

Set each secret in the environment of the process that runs OpenTofu, and name the variable in `credential_env`.
The provider reads the value during apply and sends it to OpenShell's credential store.
OpenTofu state and the resource's `ref` hold only the variable's name.
The travel team passes its booking service's key this way, in [`registrations.tf`](../../examples/features/travel-team/hcl/registrations.tf):

```hcl
resource "openshell_api" "bookings" {
  gateway        = local.gateway
  workspace      = openshell_workspace.team.ref
  name           = "bookings"
  endpoints      = [var.bookings.url]
  credential_env = var.bookings.credential_env
  binaries       = local.binaries.buyer
  # The example's mcp block limits the buyer to the booking tools.
}
```

`var.bookings.credential_env` defaults to `BOOKINGS_API_KEY`, so the job sets that variable before `tofu apply`.
In a pipeline, map it from your secret store into the job's environment.
The gateway connection takes names the same way: `data.openshell_gateway` takes `credential_env` for the gateway's bearer credential, `tls_ca_env` for the variable naming its CA file, and `tls_certificate_env` and `tls_key_env` for mutual TLS.
For a managed Kubernetes or OpenShift gateway, `openshell_kubernetes_storage`, `openshell_kubernetes_auth`, and `openshell_kubernetes_gateway` take `kubeconfig_env`, the variable whose value is the kubeconfig file's path, and `environment`, the variables the kubeconfig's exec credential plugin needs.
Without `kubeconfig_env`, the provider uses the service account of the pod that runs OpenTofu, as [Managed Kubernetes Gateway](../references/provider.md#managed-kubernetes-gateway) describes.
The Helm provider takes the same kubeconfig as `config_path` in its `kubernetes` attribute, and `data.openshell_gateway` names the variable in `settings.target.kubernetes.kubeconfig.env` of its `kubernetes` specification, as in [the Kubernetes HCL example](../../examples/platforms/kubernetes/hosted-inference/hosted-nvidia.tf).

A model server's key reaches `openshell_inference` through its `server` object, and the provider reads the key during apply.
For a server NemoClaw does not run, such as the travel team's hosted model in [`models.tf`](../../examples/features/travel-team/hcl/models.tf), the literal `inference_server` object names the key's variable in `credential_env`.
A readiness read's `ref` for a server NemoClaw runs names no variable.
When that server requires its generated key, as vLLM with `authentication` and every Ollama proxy do, the ref's `credential_source` names where the key lives, as [Runtime Capacity and Readiness](../references/provider.md#runtime-capacity-and-readiness) describes.

A plan whose environment holds a new value behind the same variable updates `openshell_inference` or `openshell_api` in place and plans its `credential_digest` unknown.
To replace a sandbox, and its agent, when that happens, list the digest in the sandbox's `lifecycle`:

```hcl
lifecycle {
  replace_triggered_by = [openshell_api.booking.credential_digest]
}
```

See [rotating credentials](../security/credential-rotation.md).
The [provider reference](../references/provider.md#api-credentials) describes each type's credential inputs.

## Replacing a Sandbox With Its Agent

Fabric runs one agent in each sandbox, so a changed agent needs a new sandbox, and planning refuses to replace a `fabric_agent` while its sandbox stays.
Keep the agent settings that can change in one local value, give that value to both a `terraform_data` and the `fabric_agent`, and replace the sandbox when the `terraform_data` changes, as [`examples/features/travel/hcl`](../../examples/features/travel/hcl/main.tf) does:

```hcl
locals {
  agent = {
    # The file's license comment is not an instruction.
    instructions = trimspace(replace(file("${path.module}/instructions.md"), "/(?s)<!--.*?-->/", ""))
    model        = data.ollama_readiness.nemotron.ref.model
  }
}

resource "terraform_data" "agent" {
  input = local.agent
}

resource "openshell_sandbox" "travel" {
  # The example also sets gateway, workspace, owner, name, image, launch_json, providers, and policy.
  lifecycle {
    replace_triggered_by = [terraform_data.agent]
  }
}

resource "fabric_agent" "travel" {
  gateway = local.gateway
  sandbox = openshell_sandbox.travel.ref
  harness = data.fabric_harness.pi.ref
  name    = "travel"
  instructions {
    system {
      content = local.agent.instructions
      mode    = "replace"
    }
  }
  models "default" {
    provider    = "openai"
    model       = local.agent.model
    api_key_env = "NEMOCLAW_ANONYMOUS_API_KEY"
  }
}
```

The travel example keeps its instructions and model in `local.agent`.
A change to another agent setting, such as `api_key_env`, needs the sandbox replaced by hand, with the command at the end of this section.
The travel team keeps each agent's whole configuration in its `terraform_data`.

Triggering on the `fabric_agent` itself would be a cycle, because the agent refers to its sandbox.
Keep the `terraform_data` input to values known while planning: a value known only during apply replaces the sandbox on every apply.
Replacing a sandbox deletes its files and conversation history.
Keep data that must survive on a [mounted volume](../agents-inference/agents.md#skills-on-a-mounted-volume), as the travel team's researchers do with `skills_volume`.

After an agent's start fails with an unknown outcome or loses its reply, replace the sandbox before creating the agent again:

```sh
tofu apply -replace=openshell_sandbox.travel
```

The CLI and SDK plan that replacement themselves.
The [Fabric agent reference](../references/provider.md#fabric-agents) describes the rest of the agent's lifecycle.

## Tearing the Configuration Down

`tofu destroy` deletes every object the configuration manages.
For the travel example, that is the agent, its sandbox with the sandbox's files and conversation history, the inference registration, the OpenShell workspace, the Ollama container, and the model volume with its downloaded model.
Upstream keys are not revoked.

For HCL that installs a managed Kubernetes or OpenShift gateway, a plain `tofu destroy` fails at plan and deletes nothing.
The provider never deletes `openshell_kubernetes_storage`, and a plan that would delete it fails with "This resource is retained and cannot be deleted", even with `destroy` set.
Follow the [GTC DC example's teardown](../../examples/guides/nemotron-super.md#amd64-kubernetes-with-nvidia-cloud-inference), which targets `openshell_kubernetes_auth` to remove authentication, the gateway, and the agents, and keeps the storage with its namespace, key Secret, and gateway storage.

Set the providers' `destroy` setting, which the examples take from a variable:

```sh
tofu destroy -var destroy=true
```

The `openshell` provider deletes an OpenShell workspace only when `destroy` is true.
To keep the OpenShell workspace, add `lifecycle { prevent_destroy = true }` to it.
`tofu destroy` then refuses to run, so exclude the workspace to remove everything else:

```sh
tofu destroy -var destroy=true -exclude=openshell_workspace.travel
```

Exclude any other resource that holds data you want to keep, such as the model volume, the same way.
