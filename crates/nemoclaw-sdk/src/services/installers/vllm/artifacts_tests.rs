// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::docker::fixture::Fixture;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
fn observed() -> RuntimeObservation {
    let fixtures: Vec<Value> =
        serde_json::from_str(include_str!("../../../managed/reference.json")).unwrap();
    RuntimeObservation {
        spec: serde_json::from_str(fixtures[1]["spec"].as_str().unwrap()).unwrap(),
        id: "binding".into(),
        container_id: "container".into(),
        data_path: "/data".into(),
        running: true,
        started_at: "2026-09-14T00:00:00Z".into(),
    }
}
#[tokio::test]
async fn runtime_status_requires_complete_current_data_and_never_mutates() {
    let response = Arc::new(Mutex::new((
        200,
        json!({"phase":"ready","detail":"","updated":"2026-09-14T00:01:00Z","pid":123}),
    )));
    let state = response.clone();
    let fixture = Fixture::start(move |r| {
        assert_eq!(r.method, "GET");
        assert!(r.path.starts_with("/containers/container/archive?"));
        let (code, value) = &*state.lock().unwrap();
        let body = if *code == 200 {
            crate::docker::archive(&[("status.json", &serde_json::to_vec(value).unwrap(), 0o600)])
                .unwrap()
        } else {
            b"{}".to_vec()
        };
        Some((*code, body))
    })
    .await;
    let engine = Engine::connect(&fixture.endpoint).unwrap();
    let mut o = observed();
    assert_eq!(engine.runtime_status(&o).await.unwrap().phase, "ready");
    response.lock().unwrap().1["updated"] = json!("2026-09-13T00:00:00Z");
    assert_eq!(
        engine.runtime_status(&o).await.unwrap().phase,
        "initializing"
    );
    for value in [
        json!({}),
        json!({"phase":"surprise","updated":"2026-09-14T00:01:00Z","detail":"","pid":123}),
        json!({"phase":"ready","updated":"bad","detail":"","pid":123}),
    ] {
        *response.lock().unwrap() = (200, value);
        assert!(engine.runtime_status(&o).await.is_err());
    }
    *response.lock().unwrap() = (404, json!({}));
    assert!(engine.runtime_status(&o).await.is_err());
    o.started_at = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    assert_eq!(
        engine.runtime_status(&o).await.unwrap().phase,
        "initializing"
    );
    for code in [401, 403, 500] {
        response.lock().unwrap().0 = code;
        assert!(engine.runtime_status(&o).await.is_err());
    }
    o.started_at = "invalid".into();
    assert!(engine.runtime_status(&o).await.is_err());
}

#[test]
fn artifact_manifests_require_matching_identity_and_unchanged_regular_files() {
    let service = crate::services::installers::vllm::configured_service(&observed().spec).unwrap();
    let recipe = service.recipe.as_ref().unwrap();
    let manifest = recipe.snapshot.as_ref().unwrap().clone();
    let modified = timestamp("2026-09-14T00:00:00.123456789Z")
        .unwrap()
        .unix_timestamp_nanos() as u64;
    let mut local = crate::snapshot::ModelManifest::new(&manifest);
    assert!(local.verified_files().is_err());
    for file in &mut local.files {
        file.modified = Some(modified);
    }
    local.validate_for(&manifest).unwrap();
    crate::services::installers::vllm::recipes::huggingface::decode_manifest(
        &service,
        &serde_json::to_vec(&local).unwrap(),
    )
    .unwrap();
    let original = local.clone();
    local.files[0].file.sha256 = "0".repeat(64);
    assert!(
        crate::services::installers::vllm::recipes::huggingface::decode_manifest(
            &service,
            &serde_json::to_vec(&local).unwrap()
        )
        .is_err()
    );
    local = original.clone();
    local.version = 2;
    assert!(crate::snapshot::ModelManifest::decode(&serde_json::to_vec(&local).unwrap()).is_err());
    local = original.clone();
    local.files.swap(0, 1);
    assert!(local.validate_for(&manifest).is_err());
    local = original.clone();
    local.files.pop();
    assert!(local.validate_for(&manifest).is_err());
    local = original;
    local.revision = "b".repeat(40);
    assert!(local.validate_for(&manifest).is_err());
    let files = local.verified_files().unwrap();
    let file = &files[0];
    let mut stat = bollard::container::PathStatResponse {
        name: file.file.name.clone(),
        size: file.file.size as i64,
        file_mode: 0o600,
        modification_time: Some("2026-09-14T00:00:00.123456789Z".into()),
        link_target: String::new(),
    };
    verify_stat(file, &stat).unwrap();
    stat.modification_time = Some("2026-09-14T00:00:00.123456788Z".into());
    assert!(verify_stat(file, &stat).is_err());
    stat.modification_time = Some("2026-09-14T00:00:00.123456789Z".into());
    stat.size -= 1;
    assert!(verify_stat(file, &stat).is_err());
    stat.size += 1;
    stat.file_mode |= 1 << 27;
    assert!(verify_stat(file, &stat).is_err());
    stat.file_mode = 0o600;
    stat.link_target = "elsewhere".into();
    assert!(verify_stat(file, &stat).is_err());
    let mut prep = crate::services::installers::vllm::recipes::preparation::OutputManifest {
        key: recipe.key(&service),
        files: ["prepared.bin".to_owned(), "prepared.json".to_owned()]
            .into_iter()
            .map(|name| VerifiedFile {
                file: crate::snapshot::File {
                    name,
                    size: 100,
                    sha256: "a".repeat(64),
                },
                modified,
            })
            .collect(),
    };
    crate::services::installers::vllm::recipes::preparation::validate_manifest(
        recipe,
        &recipe.key(&service),
        &prep,
    )
    .unwrap();
    let original = prep.clone();
    prep.files[1] = prep.files[0].clone();
    assert!(
        crate::services::installers::vllm::recipes::preparation::validate_manifest(
            recipe,
            &recipe.key(&service),
            &prep,
        )
        .is_err()
    );
    prep = original;
    prep.key = "wrong".into();
    assert!(
        crate::services::installers::vllm::recipes::preparation::validate_manifest(
            recipe,
            &recipe.key(&service),
            &prep,
        )
        .is_err()
    );
}
#[tokio::test]
async fn unavailable_artifacts_are_errors_not_runtime_absence() {
    for code in [404, 401, 403, 500] {
        let fixture = Fixture::start(move |request| {
            assert_eq!(request.method, "GET");
            Some((code, b"{}".to_vec()))
        })
        .await;
        for generic in [false, true] {
            let mut observation = observed();
            if generic {
                let mut service =
                    crate::services::installers::vllm::configured_service(&observation.spec)
                        .unwrap();
                service.recipe = None;
                service.hardware = Some(
                    serde_json::from_value(serde_json::json!({"profile":"dgx-spark"})).unwrap(),
                );
                service.model.repository = "owner/model".into();
                service.model.revision = "a".repeat(40);
                observation.spec.process.as_mut().unwrap().configuration =
                    serde_json::to_string(&service).unwrap();
            }
            assert!(
                Engine::connect(&fixture.endpoint)
                    .unwrap()
                    .verify_artifacts(&observation)
                    .await
                    .is_err()
            );
        }
    }
}
