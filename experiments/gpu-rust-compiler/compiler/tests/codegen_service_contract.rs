// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[path = "../src/codegen_service.rs"]
#[allow(dead_code)]
mod codegen_service;

use codegen_service::*;
use std::{
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};

fn batch(id: &str, generation: u64) -> Arc<FlatBatch> {
    Arc::new(
        FlatBatch::new(
            BatchIdentity {
                workload_id: "scalar-fixture".into(),
                toolchain_id: "fixture-emitter-v1".into(),
                policy_id: "stack-home-fast-v1".into(),
                target_abi: "test-i64".into(),
                source_revision: format!("source-{generation}"),
            },
            BatchKey {
                logical_id: id.into(),
                generation,
            },
            vec![Function {
                symbol: 0,
                instruction_start: 0,
                instruction_count: 2,
                value_count: 1,
                abi: 0,
            }],
            vec![
                Instruction {
                    opcode: Opcode::Const,
                    result: Some(0),
                    operands: [0, 0],
                    immediate: 42,
                },
                Instruction {
                    opcode: Opcode::Return,
                    result: None,
                    operands: [0, 0],
                    immediate: 0,
                },
            ],
            vec![Symbol {
                name: "answer".into(),
            }],
            vec![Abi {
                calling_convention: CallingConvention::SystemV,
                parameter_count: 0,
                returns_i64: true,
                requires_unwind: false,
            }],
        )
        .unwrap(),
    )
}

fn cpu() -> Box<dyn BatchExecutor> {
    Box::new(CpuCallbackExecutor::new("cpu-0", |input| {
        Ok(Emission {
            functions: input
                .functions()
                .iter()
                .map(|f| FunctionEmission {
                    symbol: f.symbol,
                    code: input.instructions()[f.instruction_start as usize]
                        .immediate
                        .to_le_bytes()
                        .to_vec(),
                    relocations: vec![],
                    unwind: vec![],
                })
                .collect(),
            execution: ExecutionRecord::Cpu,
        })
    }))
}

fn output(input: &FlatBatch, execution: ExecutionRecord) -> Emission {
    Emission {
        functions: input
            .functions()
            .iter()
            .map(|f| FunctionEmission {
                symbol: f.symbol,
                code: input.instructions()[f.instruction_start as usize]
                    .immediate
                    .to_le_bytes()
                    .to_vec(),
                relocations: vec![],
                unwind: vec![],
            })
            .collect(),
        execution,
    }
}

struct ReleaseOnDrop(Option<mpsc::Sender<()>>);
impl ReleaseOnDrop {
    fn release(mut self) {
        self.0.take().unwrap().send(()).unwrap();
    }
}
impl Drop for ReleaseOnDrop {
    fn drop(&mut self) {
        if let Some(sender) = self.0.take() {
            let _ = sender.send(());
        }
    }
}

type GatedCpu = (
    Box<dyn BatchExecutor>,
    mpsc::Receiver<String>,
    mpsc::Sender<()>,
    Arc<Mutex<Vec<String>>>,
);
fn gated_cpu() -> GatedCpu {
    let (started, observed) = mpsc::channel();
    let (release, resumed) = mpsc::channel();
    let resumed = Mutex::new(resumed);
    let order = Arc::new(Mutex::new(Vec::new()));
    let recorded = order.clone();
    let executor = CpuCallbackExecutor::new("cpu-0", move |input| {
        recorded
            .lock()
            .unwrap()
            .push(input.key().logical_id.clone());
        if input.key().logical_id == "gate" {
            started.send(input.key().logical_id.clone()).unwrap();
            resumed.lock().unwrap().recv().unwrap();
        }
        Ok(output(input, ExecutionRecord::Cpu))
    });
    (Box::new(executor), observed, release, order)
}

fn wait_started(receiver: &mpsc::Receiver<String>) {
    assert_eq!(
        receiver.recv_timeout(Duration::from_secs(5)).unwrap(),
        "gate"
    );
}

#[test]
fn cpu_callback_outputs_are_bound_to_the_submitted_batch_and_never_gpu_proof() {
    let service = BuildSession::new(SessionConfig::default(), vec![cpu()]).unwrap();
    let client = service.register_client("rustc-a", 1).unwrap();
    let input = batch("answer", 0);
    let ticket = service
        .submit(&client, input.clone(), SubmitOptions::default())
        .unwrap();
    let receipt = ticket.wait().unwrap();
    assert_eq!(receipt.batch_key, input.key().clone());
    assert_eq!(receipt.identity, input.identity().clone());
    assert_eq!(receipt.output.functions[0].code, 42_i64.to_le_bytes());
    assert!(!receipt.execution.is_physical_gpu());
    assert_eq!(receipt.route.device_id, "cpu-0");
    assert_eq!(service.client_credits(&client).unwrap(), (1, 1));
}

#[test]
fn requesting_cuda_without_a_physical_cuda_executor_returns_an_error() {
    let service = BuildSession::new(SessionConfig::default(), vec![cpu()]).unwrap();
    let client = service.register_client("rustc-a", 1).unwrap();
    let options = SubmitOptions {
        placement: Placement::RequireGpu(GpuBackend::Cuda),
        ..Default::default()
    };
    assert!(matches!(
        service.submit(&client, batch("cuda", 0), options),
        Err(ServiceError::Unavailable(_))
    ));
}

#[test]
fn undefined_values_are_rejected_before_executor_submission() {
    let original = batch("invalid", 0);
    let mut instructions = original.instructions().to_vec();
    instructions[0].opcode = Opcode::Copy;
    let error = FlatBatch::new(
        original.identity().clone(),
        original.key().clone(),
        original.functions().to_vec(),
        instructions,
        original.symbols().to_vec(),
        original.abis().to_vec(),
    )
    .unwrap_err();
    assert!(error.contains("undefined"), "{error}");
}

#[test]
fn queue_backpressure_does_not_replace_or_cancel_an_existing_request() {
    let (executor, started, release, _) = gated_cpu();
    let config = SessionConfig {
        max_queued_batches: 1,
        ..Default::default()
    };
    let service = BuildSession::new(config, vec![executor]).unwrap();
    let release = ReleaseOnDrop(Some(release));
    let client = service.register_client("rustc", 1).unwrap();
    let gate = service
        .submit(&client, batch("gate", 0), SubmitOptions::default())
        .unwrap();
    wait_started(&started);
    let queued = service
        .submit(&client, batch("work", 0), SubmitOptions::default())
        .unwrap();
    assert!(matches!(
        service.submit(&client, batch("work", 1), SubmitOptions::default()),
        Err(ServiceError::Backpressure)
    ));
    assert_eq!(queued.status(), JobStatus::Queued);
    release.release();
    gate.wait().unwrap();
    assert_eq!(queued.wait().unwrap().batch_key.generation, 0);
}

#[test]
fn owned_input_budget_includes_running_work_and_rejects_oversize_submissions() {
    let input = batch("gate", 0);
    let config = SessionConfig {
        max_owned_bytes: input.owned_bytes(),
        ..Default::default()
    };
    let (executor, started, release, _) = gated_cpu();
    let service = BuildSession::new(config, vec![executor]).unwrap();
    let release = ReleaseOnDrop(Some(release));
    let client = service.register_client("rustc", 1).unwrap();
    let gate = service
        .submit(&client, input.clone(), SubmitOptions::default())
        .unwrap();
    wait_started(&started);
    assert_eq!(service.snapshot().owned_bytes, input.owned_bytes());
    assert!(matches!(
        service.submit(&client, batch("work", 0), SubmitOptions::default()),
        Err(ServiceError::Backpressure)
    ));
    release.release();
    gate.wait().unwrap();
    assert_eq!(service.snapshot().owned_bytes, 0);
}

#[test]
fn cancellation_retains_input_and_client_credit_until_pending_work_completes() {
    let (executor, started, release, _) = gated_cpu();
    let service = BuildSession::new(SessionConfig::default(), vec![executor]).unwrap();
    let release = ReleaseOnDrop(Some(release));
    let client = service.register_client("rustc", 1).unwrap();
    let input = batch("gate", 0);
    let weak = Arc::downgrade(&input);
    let ticket = service
        .submit(&client, input.clone(), SubmitOptions::default())
        .unwrap();
    drop(input);
    wait_started(&started);
    assert_eq!(
        ticket.cancel(),
        Cancellation {
            was_running: true,
            resources_pending: true
        }
    );
    assert_eq!(ticket.status(), JobStatus::CancellationPending);
    assert!(weak.upgrade().is_some());
    assert_eq!(service.client_credits(&client).unwrap(), (1, 0));
    assert!(service.snapshot().owned_bytes > 0);
    release.release();
    assert!(matches!(ticket.wait(), Err(ServiceError::Canceled)));
    assert!(weak.upgrade().is_none());
    assert_eq!(service.client_credits(&client).unwrap(), (1, 1));
    assert_eq!(service.snapshot().owned_bytes, 0);
}

#[test]
fn newer_source_generation_suppresses_a_running_old_generation() {
    let (executor, started, release, _) = gated_cpu();
    let service = BuildSession::new(SessionConfig::default(), vec![executor]).unwrap();
    let release = ReleaseOnDrop(Some(release));
    let client = service.register_client("rustc", 1).unwrap();
    let old = service
        .submit(&client, batch("gate", 0), SubmitOptions::default())
        .unwrap();
    wait_started(&started);
    let new = service
        .submit(&client, batch("gate", 1), SubmitOptions::default())
        .unwrap();
    assert_eq!(old.status(), JobStatus::CancellationPending);
    assert!(matches!(
        service.submit(&client, batch("gate", 0), SubmitOptions::default()),
        Err(ServiceError::Duplicate)
    ));
    // The callback gates every revision. Permit both to finish.
    release.0.as_ref().unwrap().send(()).unwrap();
    assert!(matches!(old.wait(), Err(ServiceError::Canceled)));
    wait_started(&started);
    release.release();
    assert_eq!(new.wait().unwrap().batch_key.generation, 1);
}

#[test]
fn queued_cancellation_releases_input_without_executor_submission() {
    let (executor, started, release, order) = gated_cpu();
    let service = BuildSession::new(SessionConfig::default(), vec![executor]).unwrap();
    let release = ReleaseOnDrop(Some(release));
    let client = service.register_client("rustc", 1).unwrap();
    let gate = service
        .submit(&client, batch("gate", 0), SubmitOptions::default())
        .unwrap();
    wait_started(&started);
    let input = batch("never-executed", 0);
    let weak = Arc::downgrade(&input);
    let ticket = service
        .submit(&client, input, SubmitOptions::default())
        .unwrap();
    assert_eq!(
        ticket.cancel(),
        Cancellation {
            was_running: false,
            resources_pending: false
        }
    );
    assert!(matches!(ticket.wait(), Err(ServiceError::Canceled)));
    assert!(weak.upgrade().is_none());
    release.release();
    gate.wait().unwrap();
    assert_eq!(*order.lock().unwrap(), ["gate"]);
}

#[test]
fn prerequisites_override_priority_and_ready_critical_work_runs_first() {
    let (executor, started, release, order) = gated_cpu();
    let service = BuildSession::new(SessionConfig::default(), vec![executor]).unwrap();
    let release = ReleaseOnDrop(Some(release));
    let client = service.register_client("rustc", 1).unwrap();
    let gate = service
        .submit(&client, batch("gate", 0), SubmitOptions::default())
        .unwrap();
    wait_started(&started);
    let low = service
        .submit(&client, batch("low", 0), SubmitOptions::default())
        .unwrap();
    let critical = service
        .submit(
            &client,
            batch("critical", 0),
            SubmitOptions {
                critical_path_cost: 100,
                ..Default::default()
            },
        )
        .unwrap();
    let dependent = service
        .submit(
            &client,
            batch("dependent", 0),
            SubmitOptions {
                prerequisites: vec![low.key().clone()],
                critical_path_cost: 1000,
                ..Default::default()
            },
        )
        .unwrap();
    release.release();
    for ticket in [gate, low, critical, dependent] {
        ticket.wait().unwrap();
    }
    assert_eq!(
        *order.lock().unwrap(),
        ["gate", "critical", "low", "dependent"]
    );
}

#[test]
fn aging_dispatches_old_low_priority_work_before_an_unbounded_high_priority_stream() {
    let (executor, started, release, order) = gated_cpu();
    let service = BuildSession::new(
        SessionConfig {
            starvation_after_dispatches: 2,
            ..Default::default()
        },
        vec![executor],
    )
    .unwrap();
    let release = ReleaseOnDrop(Some(release));
    let client = service.register_client("rustc", 1).unwrap();
    let gate = service
        .submit(&client, batch("gate", 0), SubmitOptions::default())
        .unwrap();
    wait_started(&started);
    let mut tickets = vec![
        gate,
        service
            .submit(&client, batch("old", 0), SubmitOptions::default())
            .unwrap(),
    ];
    for (id, priority) in [("high-3", 3), ("high-2", 2), ("high-1", 1)] {
        tickets.push(
            service
                .submit(
                    &client,
                    batch(id, 0),
                    SubmitOptions {
                        critical_path_cost: priority,
                        ..Default::default()
                    },
                )
                .unwrap(),
        );
    }
    release.release();
    for ticket in tickets {
        ticket.wait().unwrap();
    }
    assert_eq!(
        *order.lock().unwrap(),
        ["gate", "high-3", "high-2", "old", "high-1"]
    );
}

#[test]
fn canceled_prerequisites_fail_dependents_without_running_them() {
    let (executor, started, release, order) = gated_cpu();
    let service = BuildSession::new(SessionConfig::default(), vec![executor]).unwrap();
    let release = ReleaseOnDrop(Some(release));
    let client = service.register_client("rustc", 1).unwrap();
    let gate = service
        .submit(&client, batch("gate", 0), SubmitOptions::default())
        .unwrap();
    wait_started(&started);
    let canceled = service
        .submit(&client, batch("prerequisite", 0), SubmitOptions::default())
        .unwrap();
    let dependent = service
        .submit(
            &client,
            batch("dependent", 0),
            SubmitOptions {
                prerequisites: vec![canceled.key().clone()],
                ..Default::default()
            },
        )
        .unwrap();
    canceled.cancel();
    release.release();
    gate.wait().unwrap();
    assert!(matches!(
        dependent.wait(),
        Err(ServiceError::DependencyFailed)
    ));
    assert_eq!(*order.lock().unwrap(), ["gate"]);
}

struct FixedExecutor {
    capabilities: DeviceCapabilities,
    execution: ExecutionRecord,
}
struct FixedPending {
    batch: Arc<FlatBatch>,
    execution: ExecutionRecord,
}
impl PendingExecution for FixedPending {
    fn wait(self: Box<Self>) -> Result<Emission, String> {
        Ok(output(&self.batch, self.execution))
    }
}
impl BatchExecutor for FixedExecutor {
    fn capabilities(&self) -> DeviceCapabilities {
        self.capabilities.clone()
    }
    fn submit(&mut self, batch: Arc<FlatBatch>) -> Result<Box<dyn PendingExecution>, String> {
        Ok(Box::new(FixedPending {
            batch,
            execution: self.execution.clone(),
        }))
    }
}

#[test]
fn simulated_cuda_never_qualifies_required_cuda_and_reports_simulation() {
    let simulation = FixedExecutor {
        capabilities: DeviceCapabilities::simulated_gpu(GpuBackend::Cuda, "sim-0"),
        execution: ExecutionRecord::Simulated {
            backend: GpuBackend::Cuda,
            device_id: "sim-0".into(),
        },
    };
    let service = BuildSession::new(SessionConfig::default(), vec![Box::new(simulation)]).unwrap();
    let client = service.register_client("rustc", 1).unwrap();
    assert!(matches!(
        service.submit(
            &client,
            batch("required", 0),
            SubmitOptions {
                placement: Placement::RequireGpu(GpuBackend::Cuda),
                ..Default::default()
            }
        ),
        Err(ServiceError::Unavailable(_))
    ));
    assert!(matches!(
        service.submit(&client, batch("auto", 0), SubmitOptions::default()),
        Err(ServiceError::Unavailable(_))
    ));
    let ticket = service
        .submit(
            &client,
            batch("sim", 0),
            SubmitOptions {
                placement: Placement::SimulatedGpu(GpuBackend::Cuda),
                ..Default::default()
            },
        )
        .unwrap();
    let receipt = ticket.wait().unwrap();
    assert_eq!(receipt.route.reality, ExecutionReality::Simulation);
    assert!(!receipt.execution.is_physical_gpu());
    assert!(receipt.route.reason.contains("not GPU evidence"));
}

#[test]
fn a_simulator_cannot_publish_a_forged_physical_execution_record() {
    let simulation = FixedExecutor {
        capabilities: DeviceCapabilities::simulated_gpu(GpuBackend::Cuda, "sim-0"),
        execution: ExecutionRecord::PhysicalGpu {
            backend: GpuBackend::Cuda,
            device_id: "sim-0".into(),
            kernel_dispatches: 1,
            kernel_output_used: true,
        },
    };
    let service = BuildSession::new(SessionConfig::default(), vec![Box::new(simulation)]).unwrap();
    let client = service.register_client("rustc", 1).unwrap();
    let ticket = service
        .submit(
            &client,
            batch("forged", 0),
            SubmitOptions {
                placement: Placement::SimulatedGpu(GpuBackend::Cuda),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(matches!(ticket.wait(), Err(ServiceError::Output(_))));
}

#[test]
fn duplicate_device_ids_and_unfunded_cpu_workers_are_rejected() {
    assert!(matches!(
        BuildSession::new(SessionConfig::default(), vec![cpu(), cpu()]),
        Err(ServiceError::Invalid(_))
    ));
    let service = BuildSession::new(
        SessionConfig {
            cpu_credit_limit: 1,
            ..Default::default()
        },
        vec![cpu()],
    )
    .unwrap();
    service.register_client("rustc-one", 1).unwrap();
    assert!(matches!(
        service.register_client("rustc-two", 1),
        Err(ServiceError::Invalid(_))
    ));
}

#[test]
fn client_credentials_from_another_build_session_are_rejected() {
    let first = BuildSession::new(SessionConfig::default(), vec![cpu()]).unwrap();
    let second = BuildSession::new(SessionConfig::default(), vec![cpu()]).unwrap();
    let client = first.register_client("rustc", 1).unwrap();
    second.register_client("rustc", 1).unwrap();
    assert!(matches!(
        second.submit(&client, batch("other-session", 0), SubmitOptions::default()),
        Err(ServiceError::UnknownClient)
    ));
}

#[test]
fn executor_failure_and_panic_return_credits_and_do_not_poison_later_submissions() {
    let executor =
        CpuCallbackExecutor::new("cpu-0", |input| match input.key().logical_id.as_str() {
            "failure" => Err("test execution failed".into()),
            "panic" => panic!("test callback panicked"),
            _ => Ok(output(input, ExecutionRecord::Cpu)),
        });
    let service = BuildSession::new(SessionConfig::default(), vec![Box::new(executor)]).unwrap();
    let client = service.register_client("rustc", 1).unwrap();
    assert!(matches!(
        service
            .submit(&client, batch("failure", 0), SubmitOptions::default())
            .unwrap()
            .wait(),
        Err(ServiceError::Execution(_))
    ));
    assert!(matches!(
        service
            .submit(&client, batch("panic", 0), SubmitOptions::default())
            .unwrap()
            .wait(),
        Err(ServiceError::WorkerPanicked)
    ));
    service
        .submit(&client, batch("recovery", 0), SubmitOptions::default())
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(service.client_credits(&client).unwrap(), (1, 1));
}

#[test]
fn partial_output_and_missing_required_unwind_are_not_published() {
    let executor = CpuCallbackExecutor::new("cpu-0", |input| {
        let mut emission = output(input, ExecutionRecord::Cpu);
        if input.key().logical_id == "partial" {
            emission.functions.clear();
        }
        Ok(emission)
    });
    let service = BuildSession::new(SessionConfig::default(), vec![Box::new(executor)]).unwrap();
    let client = service.register_client("rustc", 1).unwrap();
    assert!(matches!(
        service
            .submit(&client, batch("partial", 0), SubmitOptions::default())
            .unwrap()
            .wait(),
        Err(ServiceError::Output(_))
    ));
    let original = batch("unwind", 0);
    let mut abi = original.abis().to_vec();
    abi[0].requires_unwind = true;
    let input = Arc::new(
        FlatBatch::new(
            original.identity().clone(),
            original.key().clone(),
            original.functions().to_vec(),
            original.instructions().to_vec(),
            original.symbols().to_vec(),
            abi,
        )
        .unwrap(),
    );
    assert!(matches!(
        service
            .submit(&client, input, SubmitOptions::default())
            .unwrap()
            .wait(),
        Err(ServiceError::Output(_))
    ));
}

#[test]
fn canonical_output_order_uses_stable_symbol_names_instead_of_worker_order() {
    let original = batch("order", 0);
    let mut functions = original.functions().to_vec();
    functions.push(Function {
        symbol: 1,
        instruction_start: 2,
        instruction_count: 2,
        value_count: 1,
        abi: 0,
    });
    let mut instructions = original.instructions().to_vec();
    instructions.extend(original.instructions().iter().cloned());
    let input = Arc::new(
        FlatBatch::new(
            original.identity().clone(),
            original.key().clone(),
            functions,
            instructions,
            vec![
                Symbol {
                    name: "zebra".into(),
                },
                Symbol { name: "ant".into() },
            ],
            original.abis().to_vec(),
        )
        .unwrap(),
    );
    let service = BuildSession::new(SessionConfig::default(), vec![cpu()]).unwrap();
    let client = service.register_client("rustc", 1).unwrap();
    let receipt = service
        .submit(&client, input, SubmitOptions::default())
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(
        receipt
            .output
            .functions
            .iter()
            .map(|f| f.symbol)
            .collect::<Vec<_>>(),
        [1, 0]
    );
    assert_eq!(receipt.schema_version, 1);
    assert!(!receipt.route.reason.is_empty());
}

#[test]
fn dropping_the_last_ticket_releases_completed_output_but_preserves_prerequisite_success() {
    let service = BuildSession::new(SessionConfig::default(), vec![cpu()]).unwrap();
    let client = service.register_client("rustc", 1).unwrap();
    let ticket = service
        .submit(&client, batch("first", 0), SubmitOptions::default())
        .unwrap();
    let key = ticket.key().clone();
    let receipt = ticket.wait().unwrap();
    let weak = Arc::downgrade(&receipt);
    drop(receipt);
    assert!(weak.upgrade().is_some());
    drop(ticket);
    assert!(weak.upgrade().is_none());
    service
        .submit(
            &client,
            batch("dependent", 0),
            SubmitOptions {
                prerequisites: vec![key],
                ..Default::default()
            },
        )
        .unwrap()
        .wait()
        .unwrap();
}

#[test]
fn dropping_an_owner_while_running_cancels_publication_and_retains_storage_until_completion() {
    let (executor, started, release, _) = gated_cpu();
    let service = BuildSession::new(SessionConfig::default(), vec![executor]).unwrap();
    let release = ReleaseOnDrop(Some(release));
    let client = service.register_client("rustc", 1).unwrap();
    let input = batch("gate", 0);
    let weak = Arc::downgrade(&input);
    let ticket = service
        .submit(&client, input, SubmitOptions::default())
        .unwrap();
    wait_started(&started);
    drop(ticket);
    assert!(weak.upgrade().is_some());
    assert_eq!(service.client_credits(&client).unwrap(), (1, 0));
    let after = service
        .submit(&client, batch("after", 0), SubmitOptions::default())
        .unwrap();
    release.release();
    after.wait().unwrap();
    assert!(weak.upgrade().is_none());
}

#[test]
fn client_credits_are_reusable_after_the_client_has_no_pending_work() {
    let service = BuildSession::new(
        SessionConfig {
            cpu_credit_limit: 1,
            ..Default::default()
        },
        vec![cpu()],
    )
    .unwrap();
    let client = service.register_client("rustc-first", 1).unwrap();
    service
        .submit(&client, batch("first", 0), SubmitOptions::default())
        .unwrap()
        .wait()
        .unwrap();
    service.unregister_client(&client).unwrap();
    assert!(matches!(
        service.client_credits(&client),
        Err(ServiceError::UnknownClient)
    ));
    let next = service.register_client("rustc-second", 1).unwrap();
    service
        .submit(&next, batch("second", 0), SubmitOptions::default())
        .unwrap()
        .wait()
        .unwrap();
}

#[test]
fn completed_receipts_are_rejected_after_a_new_source_generation_and_in_other_sessions() {
    let service = BuildSession::new(SessionConfig::default(), vec![cpu()]).unwrap();
    let other = BuildSession::new(SessionConfig::default(), vec![cpu()]).unwrap();
    let client = service.register_client("rustc", 1).unwrap();
    let receipt = service
        .submit(&client, batch("source", 0), SubmitOptions::default())
        .unwrap()
        .wait()
        .unwrap();
    assert!(service.is_current(&receipt));
    assert!(!other.is_current(&receipt));
    let next = service
        .submit(&client, batch("source", 1), SubmitOptions::default())
        .unwrap()
        .wait()
        .unwrap();
    assert!(!service.is_current(&receipt));
    assert!(service.is_current(&next));
}

#[test]
fn an_old_client_handle_cannot_claim_credits_after_its_identifier_is_reused() {
    let service = BuildSession::new(
        SessionConfig {
            cpu_credit_limit: 1,
            ..Default::default()
        },
        vec![cpu()],
    )
    .unwrap();
    let old = service.register_client("rustc", 1).unwrap();
    service.unregister_client(&old).unwrap();
    let new = service.register_client("rustc", 1).unwrap();
    assert!(matches!(
        service.submit(&old, batch("old-client", 0), SubmitOptions::default()),
        Err(ServiceError::UnknownClient)
    ));
    service
        .submit(&new, batch("new-client", 0), SubmitOptions::default())
        .unwrap()
        .wait()
        .unwrap();
}

#[test]
fn unregistering_a_client_with_pending_work_cannot_reissue_its_cpu_credit() {
    let (executor, started, release, _) = gated_cpu();
    let service = BuildSession::new(
        SessionConfig {
            cpu_credit_limit: 1,
            ..Default::default()
        },
        vec![executor],
    )
    .unwrap();
    let release = ReleaseOnDrop(Some(release));
    let client = service.register_client("rustc", 1).unwrap();
    let ticket = service
        .submit(&client, batch("gate", 0), SubmitOptions::default())
        .unwrap();
    wait_started(&started);
    assert!(matches!(
        service.unregister_client(&client),
        Err(ServiceError::Invalid(_))
    ));
    assert!(matches!(
        service.register_client("other", 1),
        Err(ServiceError::Invalid(_))
    ));
    release.release();
    ticket.wait().unwrap();
    service.unregister_client(&client).unwrap();
    service.register_client("other", 1).unwrap();
}
