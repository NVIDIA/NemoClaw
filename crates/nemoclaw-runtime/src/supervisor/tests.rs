// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use nemoclaw_sdk::spark::GIB;
use process_wrap::tokio::{CommandWrap, KillOnDrop, ProcessGroup};
fn service() -> Service {
    nemoclaw_sdk::config::Document::parse(
        include_str!("../../../nemoclaw-sdk/tests/fixtures/config/spark.yaml").as_bytes(),
    )
    .unwrap()
    .spec
    .inference_providers
    .remove(0)
    .service
    .unwrap()
}
#[tokio::test]
async fn protection_kills_owned_child_when_readiness_never_responds() {
    for scenario in ["pressure", "observation", "operator", "closed"] {
        let mut command = CommandWrap::with_new("/bin/sleep", |command| {
            command.arg("100");
        });
        command.wrap(KillOnDrop).wrap(ProcessGroup::leader());
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let (samples_tx, samples) = tokio::sync::mpsc::channel(5);
        let (_ready_tx, ready) = tokio::sync::mpsc::channel(1);
        let trip = CancellationToken::new();
        if scenario == "operator" {
            trip.cancel();
        } else if scenario != "closed" {
            for _ in 0..5 {
                let sample = if scenario == "observation" {
                    Err(Error::State("fixture memory failure"))
                } else {
                    Ok(Capacity {
                        available: GIB,
                        free: GIB,
                        ..Default::default()
                    })
                };
                samples_tx.send(sample).await.unwrap();
            }
        }
        if scenario == "closed" {
            drop(samples_tx);
        }
        let report = |_: &str, _: &str, _: u32| Ok(());
        let result = tokio::time::timeout(
            Duration::from_secs(3),
            supervise(
                &service(),
                child.as_mut(),
                Monitors {
                    samples,
                    ready,
                    trip,
                    report: &report,
                },
                &CancellationToken::new(),
            ),
        )
        .await
        .unwrap();
        let error = result.unwrap_err().to_string();
        let expected = match scenario {
            "pressure" => "available=1073741824 free=1073741824",
            "observation" => "memory observation failed",
            "closed" => "memory sample stream closed",
            _ => "tripped by operator",
        };
        assert!(error.contains(expected), "{scenario}: {error}");
        assert!(child.wait().await.is_ok());
        assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
    }
}

#[tokio::test]
async fn protection_remains_active_after_readiness_and_never_restarts_the_child() {
    let mut command = CommandWrap::with_new("/bin/sleep", |command| {
        command.arg("100");
    });
    command.wrap(KillOnDrop).wrap(ProcessGroup::leader());
    let mut child = command.spawn().unwrap();
    let pid = child.id().unwrap();
    let (_samples_tx, samples) = tokio::sync::mpsc::channel(1);
    let (ready_tx, ready) = tokio::sync::mpsc::channel(1);
    ready_tx.send(true).await.unwrap();
    let trip = CancellationToken::new();
    let reported = std::sync::Mutex::new(Vec::new());
    let report = |phase: &str, _: &str, reported_pid: u32| {
        reported
            .lock()
            .unwrap()
            .push((phase.to_owned(), reported_pid));
        trip.cancel();
        Ok(())
    };
    assert!(
        supervise(
            &service(),
            child.as_mut(),
            Monitors {
                samples,
                ready,
                trip: trip.clone(),
                report: &report
            },
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    assert_eq!(*reported.lock().unwrap(), [("ready".into(), pid)]);
    assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
}

#[tokio::test(start_paused = true)]
async fn stalled_loading_honors_the_full_startup_budget_then_stops() {
    let mut command = CommandWrap::with_new("/bin/sleep", |command| {
        command.arg("100");
    });
    command.wrap(KillOnDrop).wrap(ProcessGroup::leader());
    let mut child = command.spawn().unwrap();
    let (_samples_tx, samples) = tokio::sync::mpsc::channel(1);
    let (_ready_tx, ready) = tokio::sync::mpsc::channel(1);
    let start = tokio::time::Instant::now();
    let spec = service();
    let report = |_: &str, _: &str, _: u32| Ok(());
    let result = supervise(
        &spec,
        child.as_mut(),
        Monitors {
            samples,
            ready,
            trip: CancellationToken::new(),
            report: &report,
        },
        &CancellationToken::new(),
    )
    .await;
    assert!(result.unwrap_err().to_string().contains("startup budget"));
    assert!(start.elapsed() >= Duration::from_secs(spec.serving.startup_timeout_seconds as u64));
    assert!(child.wait().await.is_ok());
}
