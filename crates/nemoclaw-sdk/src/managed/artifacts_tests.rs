// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::docker::fixture::Fixture;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
fn observed() -> RuntimeObservation {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!("reference.json")).unwrap();
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
fn artifact_completion_records_require_matching_identity_and_unchanged_regular_files() {
    let service = observed().spec.service.unwrap();
    let recipe = service.recipe.as_ref().unwrap();
    let manifest = recipe.snapshot.as_ref().unwrap().clone();
    let modified = timestamp("2026-09-14T00:00:00.123456789Z")
        .unwrap()
        .unix_timestamp_nanos() as u64;
    let mut completion = CompletionRecord {
        manifest: manifest.key(),
        files: manifest
            .files
            .clone()
            .into_iter()
            .map(|file| VerifiedFile { file, modified })
            .collect(),
    };
    validate_snapshot_manifest(&completion, &manifest).unwrap();
    let original = completion.clone();
    completion.files.swap(0, 1);
    assert!(validate_snapshot_manifest(&completion, &manifest).is_err());
    completion = original.clone();
    completion.files.pop();
    assert!(validate_snapshot_manifest(&completion, &manifest).is_err());
    completion = original;
    completion.manifest = "wrong".into();
    assert!(validate_snapshot_manifest(&completion, &manifest).is_err());
    let file = &completion.files[0];
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
    let mut prep = crate::recipes::preparation::CompletionRecord {
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
    crate::recipes::preparation::validate_completion(recipe, &recipe.key(&service), &prep).unwrap();
    let original = prep.clone();
    prep.files[1] = prep.files[0].clone();
    assert!(
        crate::recipes::preparation::validate_completion(recipe, &recipe.key(&service), &prep)
            .is_err()
    );
    prep = original;
    prep.key = "wrong".into();
    assert!(
        crate::recipes::preparation::validate_completion(recipe, &recipe.key(&service), &prep)
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
                let service = observation.spec.service.as_mut().unwrap();
                service.recipe = None;
                service.backend = "vllm".into();
                service.model.repository = "owner/model".into();
                service.model.revision = "a".repeat(40);
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
