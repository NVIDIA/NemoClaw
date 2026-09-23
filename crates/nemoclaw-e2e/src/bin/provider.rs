// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use async_trait::async_trait;
use nemoclaw_provider::{Backend, Definition, Mutation, ResourceAdapter, Row};
use nemoclaw_sdk::ObservationError;
use std::{collections::HashMap, fs, path::PathBuf, sync::Arc};
use tf_provider::{Diagnostics, DynamicResource, Provider, schema::Schema, value::ValueEmpty};

struct Fixture {
    directory: PathBuf,
}
impl Fixture {
    fn mode(&self) -> String {
        fs::read_to_string(self.directory.join("mode")).unwrap()
    }
}
#[async_trait]
impl Backend for Fixture {
    async fn plan(
        &self,
        kind: &str,
        desired: &Row,
        _: Option<&Row>,
    ) -> Result<(), nemoclaw_sdk::Error> {
        if kind != "inference_service" {
            return Ok(());
        }
        if self.mode() == "capacity-unavailable" {
            return Err(ObservationError::Transport.into());
        }
        let spec: nemoclaw_sdk::managed::Spec = serde_json::from_str(&desired["spec"]).unwrap();
        let definition: nemoclaw_sdk::services::ServiceDefinition =
            serde_json::from_str(&spec.process.unwrap().configuration).unwrap();
        let nemoclaw_sdk::services::ServiceDefinition::Vllm(service) = definition else {
            panic!("expected vLLM")
        };
        use nemoclaw_sdk::hardware::{Capacity, GIB};
        let capacity = Capacity {
            architecture: "arm64".into(),
            gpu: "NVIDIA GB10".into(),
            compute_capability: 121,
            driver_major: if self.mode() == "old-driver" {
                570
            } else {
                610
            },
            total: 128 * GIB,
            available: 120 * GIB,
            disk_free: 500 * GIB,
            ..Default::default()
        };
        nemoclaw_sdk::services::installers::vllm::hardware_capacity::check_memory(
            &service, &capacity, false,
        )
    }
    async fn read(&self, _: &str, _: &Row, _: bool) -> Result<Option<Row>, ObservationError> {
        let mode = self.mode();
        if mode == "read-error" {
            return Err(ObservationError::Transport);
        }
        if mode == "absent" {
            return Ok(None);
        }
        let bytes = match fs::read(self.directory.join("resource.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(ObservationError::Transport),
        };
        let mut row: Row =
            serde_json::from_slice(&bytes).map_err(|_| ObservationError::Incomplete)?;
        if mode == "partial" {
            row.remove("id");
        }
        if mode == "foreign" {
            row.insert("owner".into(), "someone-else".into());
        }
        Ok(Some(row))
    }
    async fn ensure(&self, _: &str, want: &Row) -> Mutation {
        let mut row = want.clone();
        row.insert("id".into(), "fixture-id".into());
        fs::write(
            self.directory.join("resource.json"),
            serde_json::to_vec(&row).unwrap(),
        )
        .unwrap();
        if self.mode() == "create-error" {
            Mutation::partial(row, ObservationError::Transport)
        } else {
            Mutation::complete(row)
        }
    }
    async fn remove(&self, _: &str, _: &Row, _: bool) -> Result<(), ObservationError> {
        fs::remove_file(self.directory.join("resource.json"))
            .map_err(|_| ObservationError::Transport)
    }
}
struct FixtureProvider {
    backend: Arc<Fixture>,
}
#[async_trait]
impl Provider for FixtureProvider {
    type Config<'a> = ValueEmpty;
    type MetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        Some(Schema {
            version: 0,
            block: Default::default(),
        })
    }
    fn get_resources(
        &self,
        _: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicResource>>> {
        let definition = Definition::new(
            "provider",
            &["name", "owner", "generation", "endpoint"],
            &["endpoint"],
        );
        Some(HashMap::from([
            (
                "provider".into(),
                Box::new(ResourceAdapter::new(definition, self.backend.clone()))
                    as Box<dyn DynamicResource>,
            ),
            (
                "inference_service".into(),
                Box::new(ResourceAdapter::new(
                    Definition::new("inference_service", &["spec"], &[]),
                    self.backend.clone(),
                )) as Box<dyn DynamicResource>,
            ),
        ]))
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let directory =
        PathBuf::from(std::env::var_os("NEMOCLAW_FIXTURE_DIR").ok_or("missing fixture directory")?);
    tf_provider::serve(
        "nemoclaw",
        FixtureProvider {
            backend: Arc::new(Fixture { directory }),
        },
    )
    .await?;
    Ok(())
}
