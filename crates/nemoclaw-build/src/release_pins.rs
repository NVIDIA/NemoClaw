// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The versions and digests that a deployment of a release uses, which the
//! release attaches as `version-pins.json`. They come from the tag's
//! `versions.json` and the images the release staged; tools that only build
//! and test NemoClaw are left out.

use crate::download::Artifact;
use crate::images::SourcePins;
use crate::release_assessment::release::{digest, hex};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

type Result<T> = std::result::Result<T, String>;

/// The Fabric source archive's URL up to its revision.
const FABRIC_SOURCE: &str = "https://codeload.github.com/NVIDIA/NeMo-Fabric/tar.gz/";

#[derive(Serialize)]
struct VersionPins<'a> {
    release: &'a str,
    components: BTreeMap<String, Component>,
}

#[derive(Serialize)]
struct Component {
    /// Absent when `versions.json` pins the component by digest alone.
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(flatten)]
    pin: Pin,
}

/// What fixes a component's bytes.
#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Pin {
    /// An image reference by digest.
    Image(String),
    /// An OCI Helm chart reference by digest.
    Chart(String),
    /// Each platform's release archive.
    Archives(BTreeMap<String, Artifact>),
    /// A source archive.
    Source(Artifact),
}

impl Pin {
    fn at(self, version: &str) -> Component {
        Component {
            version: Some(version.into()),
            pin: self,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Versions {
    opentofu: String,
    openshell: String,
    docker_provider: String,
    helm_provider: String,
    platforms: BTreeMap<String, BTreeMap<String, Artifact>>,
    images: BTreeMap<String, String>,
    image_sources: SourcePins,
}

/// An image as the release's `inventory.json` lists it.
#[derive(Deserialize)]
struct Image {
    name: String,
    repository: String,
    index_digest: String,
}

/// The pins of the release `tag` from its `versions.json` and `inventory.json`,
/// as `version-pins.json`'s text. Refuses input that leaves a component
/// unpinned or names one twice.
pub fn pins(versions: &[u8], inventory: &[u8], tag: &str) -> Result<String> {
    let versions: Versions =
        serde_json::from_slice(versions).map_err(|error| format!("versions.json: {error}"))?;
    let inventory: Vec<Image> =
        serde_json::from_slice(inventory).map_err(|error| format!("inventory.json: {error}"))?;
    if !tag.starts_with('v')
        || !tag
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return Err(format!("{tag:?} is not a release tag"));
    }
    let mut components = BTreeMap::new();
    for (name, version, tool) in [
        ("opentofu", &versions.opentofu, "tofu"),
        ("openshellClient", &versions.openshell, "openshell"),
        (
            "dockerProvider",
            &versions.docker_provider,
            "dockerProvider",
        ),
        ("helmProvider", &versions.helm_provider, "helmProvider"),
    ] {
        let archives: BTreeMap<String, Artifact> = versions
            .platforms
            .iter()
            .filter_map(|(platform, tools)| Some((platform.clone(), tools.get(tool)?.clone())))
            .collect();
        if archives.is_empty() || !archives.values().all(pinned) {
            return Err(format!("versions.json doesn't pin each {tool} archive"));
        }
        components.insert(name.into(), Pin::Archives(archives).at(version));
    }
    let image = |name: &str| {
        versions
            .images
            .get(name)
            .filter(|reference| by_digest(reference))
            .cloned()
            .ok_or_else(|| format!("versions.json doesn't pin the {name} image by digest"))
    };
    for (name, pin) in [
        ("gateway", Pin::Image as fn(String) -> Pin),
        ("supervisor", Pin::Image),
        ("sandboxRuntime", Pin::Image),
        ("gatewayChart", Pin::Chart),
    ] {
        components.insert(name.into(), pin(image(name)?).at(&versions.openshell));
    }
    let issuer = Component {
        version: None,
        pin: Pin::Image(image("developmentIssuer")?),
    };
    components.insert("developmentIssuer".into(), issuer);
    let fabric = versions
        .image_sources
        .get("fabric")
        .and_then(|files| files.get("fabric.tar.gz"))
        .filter(|source| pinned(source))
        .ok_or("versions.json doesn't pin the Fabric source archive")?;
    let revision = fabric
        .url
        .strip_prefix(FABRIC_SOURCE)
        .filter(|revision| hex(revision, 40))
        .ok_or("versions.json doesn't pin the Fabric source to a revision")?;
    components.insert("fabric".into(), Pin::Source(fabric.clone()).at(revision));
    if inventory.is_empty() {
        return Err("inventory.json lists no images".into());
    }
    for image in inventory {
        let reference = format!("{}@{}", image.repository, image.index_digest);
        if image.name.is_empty()
            || !image
                .name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || !by_digest(&reference)
        {
            return Err(format!(
                "inventory.json lists an invalid {:?} image",
                image.name
            ));
        }
        let component = Pin::Image(reference).at(tag);
        if components.insert(image.name.clone(), component).is_some() {
            return Err(format!(
                "inventory.json lists {} twice or as another component",
                image.name
            ));
        }
    }
    let pins = VersionPins {
        release: tag,
        components,
    };
    serde_json::to_string_pretty(&pins).map_err(|error| error.to_string())
}

fn pinned(artifact: &Artifact) -> bool {
    artifact.url.starts_with("https://") && hex(&artifact.sha256, 64)
}

fn by_digest(reference: &str) -> bool {
    reference.rsplit_once('@').is_some_and(|(name, value)| {
        !name.is_empty() && !name.contains(|c: char| c == '@' || c.is_whitespace()) && digest(value)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn each_release_exposes_its_own_host_client_pin_and_archives() {
        let source: Value = serde_json::from_str(include_str!("../../../versions.json")).unwrap();
        let current = source["openshell"].as_str().unwrap();
        let inventory = serde_json::to_vec(&json!([{
            "name": "hermes", "repository": "registry.example/hermes",
            "index_digest": format!("sha256:{}", "a".repeat(64)),
        }]))
        .unwrap();
        // Synthetic release fixtures: two share a client; one requires another.
        for (tag, required) in [
            ("v1.0.0-fixture", current),
            ("v1.0.1-fixture", current),
            ("v2.0.0-fixture", "999.0.0-fixture"),
        ] {
            let mut fixture = source.clone();
            fixture["openshell"] = json!(required);
            for tools in fixture["platforms"].as_object_mut().unwrap().values_mut() {
                if let Some(archive) = tools.get_mut("openshell") {
                    archive["url"] =
                        json!(format!("https://releases.example/{required}/client.tar.gz"));
                }
            }
            let generated: Value = serde_json::from_str(
                &pins(&serde_json::to_vec(&fixture).unwrap(), &inventory, tag).unwrap(),
            )
            .unwrap();
            assert_eq!(generated["release"], tag);
            assert_eq!(
                generated["components"]["openshellClient"]["version"],
                required
            );
            assert_eq!(
                generated["components"]["openshellClient"]["archives"]["darwin_arm64"],
                fixture["platforms"]["darwin_arm64"]["openshell"]
            );
        }
    }

    #[test]
    fn input_that_leaves_a_component_unpinned_or_ambiguous_pins_nothing() {
        let versions: Value = serde_json::from_str(include_str!("../../../versions.json")).unwrap();
        let image = |name: &str, digest: &str| {
            json!({
                "name": name,
                "repository": format!("ghcr.io/nvidia/nemoclaw/v1/{name}"),
                "index_digest": digest,
                "manifests": {"manifests": []},
            })
        };
        let indexed = format!("sha256:{}", "a".repeat(64));
        let hermes = image("hermes", &indexed);
        let edited = |pointer: &str, value: Value| {
            let mut versions = versions.clone();
            *versions.pointer_mut(pointer).unwrap() = value;
            versions
        };
        let generate = |versions: &Value, inventory: Value| {
            pins(
                &serde_json::to_vec(versions).unwrap(),
                &serde_json::to_vec(&inventory).unwrap(),
                "v0.1.0",
            )
        };
        let generated: Value =
            serde_json::from_str(&generate(&versions, json!([hermes])).unwrap()).unwrap();
        assert_eq!(
            generated.pointer("/components/openshellClient/version"),
            versions.get("openshell")
        );
        assert_eq!(
            generated.pointer("/components/openshellClient/archives/linux_arm64"),
            versions.pointer("/platforms/linux_arm64/openshell")
        );
        for (case, versions, inventory) in [
            (
                "an image by tag",
                edited(
                    "/images/gateway",
                    json!("ghcr.io/nvidia/openshell/gateway:0.1.9"),
                ),
                json!([hermes]),
            ),
            (
                "an archive without its checksum",
                edited("/platforms/linux_amd64/tofu/sha256", json!("")),
                json!([hermes]),
            ),
            (
                "a Fabric source by branch",
                edited(
                    "/imageSources/fabric/fabric.tar.gz/url",
                    json!(format!("{FABRIC_SOURCE}main")),
                ),
                json!([hermes]),
            ),
            ("no images", versions.clone(), json!([])),
            ("an image twice", versions.clone(), json!([hermes, hermes])),
            (
                "an image named as a component",
                versions.clone(),
                json!([image("gateway", &indexed)]),
            ),
            (
                "an image without its digest",
                versions.clone(),
                json!([image("hermes", "latest")]),
            ),
        ] {
            assert!(generate(&versions, inventory).is_err(), "{case}");
        }
    }
}
