<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Multiple Sandboxes

One configuration can declare several sandboxes.
Each sandbox compiles to its own resources, and the order of named declarations never changes what NemoClaw deploys.

## Five Agents

[`examples/multiple-sandboxes.yaml`](../../../examples/multiple-sandboxes.yaml) declares five agents that share one inference provider.

Starting from `examples/multiple-sandboxes.yaml`, it compiles to 5 sandboxes and 3 provider registrations.
Exporting it and reading the export back gives the same configuration.

Each harness adapter receives its own registration of a provider, so two sandboxes share a registration only when they use the same harness.
Compiling `examples/multiple-sandboxes.yaml` gives each sandbox its harness, its agent, and the partner that shares its provider registration:

| sandbox  | harness                            | agent      | partner  |
| -------- | ---------------------------------- | ---------- | -------- |
| alice    | nvidia.fabric.openclaw             | alice      | bob      |
| bob      | nvidia.fabric.openclaw             | bob        | alice    |
| research | nvidia.fabric.langchain.deepagents | researcher | review   |
| review   | nvidia.fabric.langchain.deepagents | reviewer   | research |
| coding   | nvidia.fabric.pi                   | coder      | none     |

## Declaration Order

Sandboxes and providers are named, so their order in the file is presentation.
Reordering them changes no compiled resource and no digest.

Starting from `examples/fabric-openclaw.yaml`, add a sandbox named "research" and give it the "deepagents" harness.
It compiles to 2 sandboxes and 2 provider registrations.
Reversing the sandboxes changes no compiled resource.

---

Starting from `examples/fabric-openclaw.yaml`, add a provider named "other-models" at "http://172.20.0.1:11447/v1", add a sandbox named "bob", and route it to "other-models".
It compiles to 2 sandboxes and 2 provider registrations.
Reversing the sandboxes and providers changes no compiled resource.

---

Starting from `examples/fabric-openclaw.yaml`, add a sandbox named "another".
It compiles to 2 sandboxes and 1 provider registration.
Reversing the sandboxes gives the same digest.

---

Managed discovery requests keep their identity too.
Starting from `examples/onboarding/openclaw.yaml`, add a sandbox named "research" and give it the "deepagents" harness.
It compiles to 2 sandboxes and 2 provider registrations.
Reversing the sandboxes changes no compiled resource.

## Sandbox-Local Providers

A provider declared inside a sandbox belongs to that sandbox, so two sandboxes can each declare a provider with the same name.

Starting from `examples/fabric-openclaw.yaml`, move the "local" provider into the first sandbox and add a sandbox named "other".
It compiles to 2 sandboxes and 2 provider registrations, and the registrations have 2 different names.
Reversing the sandboxes changes no compiled resource.

## Adding a Sandbox

Adding a sandbox must not replace or modify the resources that already exist.
The one exception is the discovery fields `runtime_json` and `binaries_json`: their expression lists every sandbox, but the image metadata they resolve to is the same.

Starting from `examples/fabric-openclaw.yaml`, adding a sandbox named "additional" changes no existing compiled resource.
