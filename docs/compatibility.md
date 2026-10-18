<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Compatibility Across Releases

NemoClaw v1 is in alpha, and its configuration is `v1alpha1`.
This page says what a release guarantees across releases, and what it doesn't.

## Use One Release Together

A release is its CLI, the SDK crate, its bundle (providers, OpenTofu, and pinned images and charts), and its configuration schema.
Use them together; mixing releases isn't supported.
See [bundle building](build.md) for how a bundle pins its parts.

## Configuration

`v1alpha1` can change between releases without migration.
Release notes list breaking changes once releases are published ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)).
Within a release, configuration from `export` re-applies to the same deployment.

## Deployment State

State isn't migrated between releases while v1 is in alpha.
A release that changes what state records refuses older state, without changing it, and names the cause, for example: "deployment predates openshell_inference; retain state and use the original NemoClaw version for recovery or teardown".
Keep the release that created a deployment until you have destroyed it, then create a new deployment with the new release, using a fresh `metadata.uid` and state directory.

The providers refuse state recorded under an older version of a resource's schema; they don't upgrade it.

## Rust SDK API

`nemoclaw-sdk` follows Semantic Versioning for 0.x versions: a minor release, such as 0.1 to 0.2, may break the API.
The crate isn't published yet ([#12638](https://github.com/NVIDIA/NemoClaw/issues/12638)).
Generate its API reference locally as [the SDK guide](sdk.md#package-distribution-and-api-reference) describes; a hosted reference follows the documentation site ([#12644](https://github.com/NVIDIA/NemoClaw/issues/12644)).

## Derived Agent Images

An image derived from a NemoClaw agent image belongs to the release of its base image.
Rebuild it from the new release's base when you upgrade; see [derived agent images](derived-images.md).

## Hand-Written HCL

Provider type names, inputs, and outputs can change between releases.
Each release's [provider guide](provider.md) and schema snapshots describe that release's types.

The examples under [`examples/hcl`](../examples/hcl) are supported with the release they ship in: [`travel`](../examples/hcl/travel/main.tf), which a system test applies unchanged, and [`travel-team`](../examples/hcl/travel-team/README.md).
Their resources follow the provider's [lifecycle rules](provider.md#openshell-resource-lifecycles), and destroy keeps what [deployment state](state.md#understand-the-retained-resources) lists as retained.

## Import, Adoption, and State Backends

`tofu import` isn't supported: every NemoClaw provider type reports "Import is not supported".
NemoClaw doesn't adopt resources it didn't create; it checks ownership labels and its saved bindings before changing anything.

The CLI and SDK keep each deployment's OpenTofu state in its local [state directory](state.md); remote state backends aren't supported for them.
Hand-written HCL can use any state backend OpenTofu supports, because the providers don't depend on the backend.
State holds resource identities and settings, never credential values; protect it like any OpenTofu state.
