// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Print two offline journey previews for visual design review.

use nemoclaw_authoring::{Capabilities, JourneyDefinition, PartialDocument};
use nemoclaw_sdk::fabric_catalog::FabricCatalog;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut catalog = FabricCatalog::bundled();
    catalog.adapters.retain(|adapter| {
        matches!(
            adapter.descriptor["adapter_id"].as_str(),
            Some("nvidia.fabric.openclaw" | "nvidia.fabric.hermes")
        )
    });
    let capabilities = Capabilities::from_catalog(&catalog);

    let minimum = PartialDocument::from_yaml(
        b"apiVersion: nemoclaw.nvidia.com/v1alpha1\nkind: NemoClawConfig\nspec:\n  sandboxes:\n    - {}\n",
    )?;
    let minimum = JourneyDefinition::new("minimum viable values", minimum)
        .ask(["/metadata/name"])
        .omit(["adapter:nvidia.fabric.openclaw:/cli"]);
    println!("{}", minimum.print_tree(&capabilities)?);

    let express =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))?;
    let express = JourneyDefinition::new("express", express).omit([
        "adapter:nvidia.fabric.openclaw:/agent_name",
        "adapter:nvidia.fabric.openclaw:/cli",
        "adapter:nvidia.fabric.openclaw:/home",
        "adapter:nvidia.fabric.openclaw:/native_config",
        "adapter:nvidia.fabric.openclaw:/timeout_seconds",
    ]);
    println!();
    println!("{}", express.print_tree(&capabilities)?);

    let guided =
        PartialDocument::from_yaml(include_bytes!("../../../examples/onboarding/openclaw.yaml"))?;
    let guided = JourneyDefinition::new("guided preview", guided)
        .ask(["/metadata/name", "/spec/sandboxes/0/harness/kind"]);
    println!();
    println!("{}", guided.print_tree(&capabilities)?);
    Ok(())
}
