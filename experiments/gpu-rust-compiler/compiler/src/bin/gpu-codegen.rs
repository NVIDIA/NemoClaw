// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use gpu_rust_compiler::{
    codegen_service::*,
    machine_codegen::{self, MachineTarget},
    native_codegen::NativeExecutor,
};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::Instant,
};

fn hash(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn constants(index: usize, seed: u64, generation: u64) -> (i64, i64) {
    let a = seed
        .wrapping_add(index as u64 * 7919)
        .wrapping_add(generation * 104729)
        .rotate_left(17);
    (a as i64, (a ^ 0x8000000013572468) as i64)
}
fn batch(
    start: usize,
    count: usize,
    seed: u64,
    generation: u64,
    target: MachineTarget,
    source: &str,
) -> Result<Arc<FlatBatch>, String> {
    let mut functions = Vec::new();
    let mut instructions = Vec::new();
    let mut symbols = Vec::new();
    for index in start..start + count {
        let symbol = functions.len() as u32;
        let begin = instructions.len() as u32;
        let (a, b) = constants(index, seed, generation);
        let values = [
            (Opcode::Argument, Some(0), [0, 0], 0),
            (Opcode::Const, Some(1), [0, 0], a),
            (Opcode::Add, Some(2), [0, 1], 0),
            (Opcode::Const, Some(3), [0, 0], b),
            (Opcode::Sub, Some(4), [2, 3], 0),
            (Opcode::Mul, Some(5), [4, 1], 0),
            (Opcode::Copy, Some(6), [5, 0], 0),
            (Opcode::Return, None, [6, 0], 0),
        ];
        instructions.extend(
            values
                .into_iter()
                .map(|(opcode, result, operands, immediate)| Instruction {
                    opcode,
                    result,
                    operands,
                    immediate,
                }),
        );
        functions.push(Function {
            symbol,
            instruction_start: begin,
            instruction_count: 8,
            value_count: 7,
            abi: 0,
        });
        symbols.push(Symbol {
            name: format!("gpu_emitted_{index}"),
        });
    }
    Ok(Arc::new(FlatBatch::new(
        BatchIdentity {
            workload_id: format!("synthetic-leaf:{start}:{count}:{seed}:{generation}"),
            toolchain_id: "rust1.98.1-leaf-schema1".into(),
            policy_id: "fast-leaf-stack-v1".into(),
            target_abi: target.host_triple().into(),
            source_revision: source.into(),
        },
        BatchKey {
            logical_id: format!("leaf-{start}"),
            generation,
        },
        functions,
        instructions,
        symbols,
        vec![Abi {
            calling_convention: if target == MachineTarget::Aarch64 && cfg!(target_os = "macos") {
                CallingConvention::AppleAarch64
            } else {
                CallingConvention::SystemV
            },
            parameter_count: 1,
            returns_i64: true,
            requires_unwind: false,
        }],
    )?))
}
fn execute(
    objects: &[PathBuf],
    count: usize,
    seed: u64,
    generation: u64,
    out: &Path,
) -> Result<serde_json::Value, String> {
    let mut c = String::from("#include <stdint.h>\n#include <stdio.h>\n#include <inttypes.h>\n");
    for i in 0..count {
        c.push_str(&format!("extern uint64_t gpu_emitted_{i}(uint64_t);\n"));
    }
    c.push_str("int main(void){uint64_t xs[]={0,1,UINT64_MAX,INT64_MAX,(uint64_t)INT64_MIN,UINT64_C(0x123456789abcdef0)};uint64_t h=UINT64_C(14695981039346656037);\n");
    for i in 0..count {
        c.push_str(&format!(
            "for(unsigned j=0;j<6;j++){{h^=gpu_emitted_{i}(xs[j]);h*=UINT64_C(1099511628211);}}\n"
        ));
    }
    c.push_str("printf(\"%\" PRIu64 \"\\n\",h);return 0;}\n");
    fs::write(out.join("main.c"), c).map_err(|e| e.to_string())?;
    let link = Instant::now();
    let mut cmd = Command::new("clang");
    cmd.arg(out.join("main.c"))
        .args(objects)
        .arg("-o")
        .arg(out.join("program"));
    let result = cmd.output().map_err(|e| e.to_string())?;
    let link_ms = link.elapsed().as_secs_f64() * 1000.;
    if !result.status.success() {
        return Err(format!(
            "native fixture link failed: {}",
            String::from_utf8_lossy(&result.stderr)
        ));
    }
    let run = Command::new(out.join("program"))
        .output()
        .map_err(|e| e.to_string())?;
    if !run.status.success() {
        return Err("emitted native fixture failed to execute".into());
    }
    let mut expected = 14695981039346656037u64;
    for i in 0..count {
        let (a, b) = constants(i, seed, generation);
        for x in [0i64, 1, -1, i64::MAX, i64::MIN, 0x123456789abcdef0] {
            let value = x.wrapping_add(a).wrapping_sub(b).wrapping_mul(a);
            expected ^= value as u64;
            expected = expected.wrapping_mul(1099511628211);
        }
    }
    let expected = format!("{expected}\n");
    let actual = String::from_utf8(run.stdout).map_err(|e| e.to_string())?;
    if actual != expected {
        return Err(format!(
            "native program mismatch: expected{expected:?}, actual{actual:?}"
        ));
    }
    Ok(
        serde_json::json!({"verified":true,"stdout":actual,"link_ms":link_ms,"program_sha256":hash(&fs::read(out.join("program")).map_err(|e|e.to_string())?)}),
    )
}
fn run() -> Result<(), String> {
    let mut backend = String::from("cpu");
    let mut library = None;
    let mut shader = None;
    let mut functions = 128usize;
    let mut batch_size = 256usize;
    let mut repeats = 3usize;
    let mut workers = 1usize;
    let mut devices = vec![0u32];
    let mut seed = 73u64;
    let mut out = PathBuf::from(".build/codegen-demo");
    let mut execute_program = false;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--help" {
            println!("gpu-codegen --backend cpu|metal|cuda --functions N --batch-functions N --repeats N --cpu-workers N --devices 0,1 --library FILE --shader FILE --seed N --out-dir DIR --execute\nSchema-1 leaf machine-code fixture; no full Rust/Cargo GPU support or scaling claim.");
            return Ok(());
        }
        if arg == "--execute" {
            execute_program = true;
            continue;
        }
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for{arg}"))?;
        match arg.as_str() {
            "--backend" => backend = value,
            "--library" => library = Some(PathBuf::from(value)),
            "--shader" => shader = Some(PathBuf::from(value)),
            "--functions" => functions = value.parse().map_err(|_| "invalid functions")?,
            "--batch-functions" => batch_size = value.parse().map_err(|_| "invalid batch size")?,
            "--repeats" => repeats = value.parse().map_err(|_| "invalid repeats")?,
            "--cpu-workers" => workers = value.parse().map_err(|_| "invalid workers")?,
            "--devices" => {
                devices = value
                    .split(',')
                    .map(|v| v.parse().map_err(|_| "invalid device index"))
                    .collect::<Result<_, _>>()?
            }
            "--seed" => seed = value.parse().map_err(|_| "invalid seed")?,
            "--out-dir" => out = value.into(),
            _ => return Err(format!("unknown option{arg}")),
        }
    }
    if !(1..=65536).contains(&functions)
        || !(1..=4096).contains(&batch_size)
        || !(1..=64).contains(&repeats)
        || !(1..=64).contains(&workers)
        || devices.is_empty()
    {
        return Err("fixture dimensions or worker counts are out of bounds".into());
    }
    let mut unique = devices.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != devices.len() {
        return Err("duplicate device index".into());
    }
    let marker = out.join(".gpuemit-owned");
    if out.exists() && !marker.exists() {
        return Err("refusing unowned output directory".into());
    }
    fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    fs::write(&marker, "gpuemit-schema1\n").map_err(|e| e.to_string())?;
    let target = MachineTarget::host()?;
    let git_source = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let ci_source = env::var("CANDIDATE_SHA")
        .ok()
        .filter(|sha| matches!(sha.len(), 40 | 64) && sha.bytes().all(|c| c.is_ascii_hexdigit()));
    let (source, source_origin) = if let Some(sha) = git_source {
        (sha, "git-checkout")
    } else if let Some(sha) = ci_source {
        (sha, "ci-environment-assertion")
    } else {
        ("unrecorded-source".into(), "unknown")
    };
    let dirty = Command::new("git")
        .args(["status", "--porcelain"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| !o.stdout.is_empty());
    let initialization = Instant::now();
    let mut executors: Vec<Box<dyn BatchExecutor>> = Vec::new();
    let mut stats = Vec::new();
    let placement = if backend == "cpu" {
        for worker in 0..workers {
            executors.push(Box::new(CpuCallbackExecutor::new(
                format!("cpu-{worker}"),
                move |batch| machine_codegen::cpu_emit(batch, target),
            )));
        }
        Placement::Cpu
    } else {
        let kind = match backend.as_str() {
            "metal" => GpuBackend::Metal,
            "cuda" => GpuBackend::Cuda,
            _ => return Err("backend must be cpu, metal, or cuda".into()),
        };
        let library = library
            .as_ref()
            .ok_or("GPU emission requires explicit library path")?;
        for device in &devices {
            let executor = NativeExecutor::new(kind, target, library, shader.as_deref(), *device)?;
            stats.push(executor.stats());
            executors.push(Box::new(executor));
        }
        Placement::RequireGpu(kind)
    };
    let session = BuildSession::new(
        SessionConfig {
            cpu_credit_limit: workers.max(devices.len()),
            max_queued_batches: 32,
            ..Default::default()
        },
        executors,
    )
    .map_err(|e| e.to_string())?;
    let client = session
        .register_client("native-codegen", workers.max(devices.len()))
        .map_err(|e| e.to_string())?;
    let setup_ms = initialization.elapsed().as_secs_f64() * 1000.;
    let mut rounds = Vec::new();
    for round in 0..repeats {
        let generation = round as u64 + 1;
        let start = Instant::now();
        let mut pending = VecDeque::new();
        let mut completed = Vec::new();
        for first in (0..functions).step_by(batch_size) {
            let input = batch(
                first,
                batch_size.min(functions - first),
                seed,
                generation,
                target,
                &source,
            )?;
            loop {
                match session.submit(
                    &client,
                    input.clone(),
                    SubmitOptions {
                        placement: placement.clone(),
                        estimated_work: input.instructions().len() as u64,
                        ..Default::default()
                    },
                ) {
                    Ok(ticket) => {
                        pending.push_back((input.clone(), ticket));
                        break;
                    }
                    Err(ServiceError::Backpressure) => {
                        let (input, ticket) = pending
                            .pop_front()
                            .ok_or("backpressure without pending work")?;
                        completed.push((input, ticket.wait().map_err(|e| e.to_string())?));
                    }
                    Err(e) => return Err(e.to_string()),
                }
            }
        }
        for (input, ticket) in pending {
            completed.push((input, ticket.wait().map_err(|e| e.to_string())?));
        }
        let emit_wall_ms = start.elapsed().as_secs_f64() * 1000.;
        let object_start = Instant::now();
        let mut objects = Vec::new();
        let mut ledgers = Vec::new();
        let mut code_bytes = 0usize;
        for (index, (input, receipt)) in completed.iter().enumerate() {
            if !session.is_current(receipt) {
                return Err("stale completion cannot be published".into());
            }
            let cpu = machine_codegen::cpu_emit(input, target)?;
            let mut oracle = cpu.functions;
            oracle.sort_by_key(|f| f.symbol);
            let mut actual = receipt.output.functions.clone();
            actual.sort_by_key(|f| f.symbol);
            if oracle != actual {
                return Err("GPU/native emission differs from independent CPU bytes".into());
            }
            code_bytes += actual.iter().map(|f| f.code.len()).sum::<usize>();
            let bytes = machine_codegen::write_object(input, target, &receipt.output)?;
            let path = out.join(format!("round{round}-batch{index}.o"));
            fs::write(&path, bytes).map_err(|e| e.to_string())?;
            objects.push(path);
            let c = &receipt.costs;
            ledgers.push(serde_json::json!({"device":receipt.route.device_id,"physical_gpu":receipt.execution.is_physical_gpu(),"validation_ms":c.validation.as_secs_f64()*1000.,"queue_ms":c.queue.as_secs_f64()*1000.,"prepare_ms":c.prepare.as_secs_f64()*1000.,"submit_ms":c.submit.as_secs_f64()*1000.,"wait_ms":c.wait.as_secs_f64()*1000.,"output_validation_ms":c.assemble.as_secs_f64()*1000.}));
        }
        let oracle_and_objects_ms = object_start.elapsed().as_secs_f64() * 1000.;
        let execution = if execute_program {
            execute(&objects, functions, seed, generation, &out)?
        } else {
            serde_json::json!({"verified":false,"reason":"native execution not requested"})
        };
        rounds.push(serde_json::json!({"round":round,"generation":generation,"emission_wall_ms":emit_wall_ms,"oracle_and_objects_ms":oracle_and_objects_ms,"code_bytes":code_bytes,"ledger":ledgers,"program_execution":execution}));
    }
    let native_stats: Vec<_> = stats.iter().map(|s| s.lock().unwrap().clone()).collect();
    let exe = env::current_exe().map_err(|e| e.to_string())?;
    let library_hash = library
        .as_ref()
        .map(|p| fs::read(p).map(|v| hash(&v)))
        .transpose()
        .map_err(|e| e.to_string())?;
    let shader_hash = shader
        .as_ref()
        .map(|p| fs::read(p).map(|v| hash(&v)))
        .transpose()
        .map_err(|e| e.to_string())?;
    let report = serde_json::json!({"schema_version":1,"scope":"Synthetic schema-1 leaf machine-code emission and native execution; not full Rust/Cargo GPU compilation or demonstrated hardware scaling.","backend":backend,"target":target.host_triple(),"functions":functions,"batch_functions":batch_size,"cpu_workers":workers,"requested_devices":devices,"device_ids":session.capabilities().iter().map(|d|d.device_id.clone()).collect::<Vec<_>>(),"service_initialization_ms":setup_ms,"seed":seed,"quality":"fast-leaf-stack-v1","all_cpu_byte_checks_passed":true,"native_stats":native_stats,"rounds":rounds,"source_revision":source,"source_revision_origin":source_origin,"worktree_dirty":dirty,"binary_sha256":hash(&fs::read(exe).map_err(|e|e.to_string())?),"native_library_sha256":library_hash,"shader_sha256":shader_hash,"fixture_spec_sha256":hash(include_bytes!("gpu-codegen.rs")),"comparison_scope":"Emission wall includes fixture construction/validation, queue, preparation, native submission/wait and output validation; independent oracle, object serialization/linking/execution are separately reported."});
    fs::write(
        out.join("report.json"),
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    println!("{}", out.join("report.json").display());
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("gpu-codegen: {error}");
        std::process::exit(1);
    }
}
