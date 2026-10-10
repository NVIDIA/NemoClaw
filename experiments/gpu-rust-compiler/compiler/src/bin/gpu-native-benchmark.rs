// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Persistent native workpack driver. Python is only the external controller.

#[allow(dead_code, clippy::needless_range_loop)]
#[path = "../analysis.rs"]
mod analysis;
#[allow(dead_code)]
#[path = "../cuda.rs"]
mod cuda;
#[allow(dead_code)]
#[path = "../executor.rs"]
mod executor;
#[path = "../glc.rs"]
mod glc;
#[allow(dead_code)]
#[path = "../ir.rs"]
mod ir;
#[allow(dead_code)]
#[path = "../routing.rs"]
mod routing;

use analysis::{select_packed, PackedAnalysis};
use cuda::{Algorithm, Context};
use executor::{AnalysisSelection, CpuExecutor, CpuMode};
use std::{
    env, fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};

fn elapsed(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1_000.0
}

fn quote(value: &str) -> String {
    let mut output = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            c if c.is_control() => output.push_str(&format!("\\u{:04x}", c as u32)),
            c => output.push(c),
        }
    }
    output.push('"');
    output
}

fn cpu_mode(value: &str) -> Result<Option<CpuMode>, String> {
    match value.split('@').next().unwrap_or(value) {
        "auto" => Ok(None),
        "serial" => Ok(Some(CpuMode::Serial)),
        "function_pool" | "function_parallel" => Ok(Some(CpuMode::Functions)),
        "word_pool" | "word_parallel" => Ok(Some(CpuMode::Words)),
        _ => Err("CPU mode must be auto, serial, function_pool or word_pool".into()),
    }
}

fn algorithm(value: &str) -> Result<Algorithm, String> {
    match value {
        "dense" => Ok(Algorithm::Dense),
        "sparse" => Ok(Algorithm::Sparse),
        _ => Err("CUDA algorithm must be dense or sparse".into()),
    }
}

fn write_result(path: &Path, words: &[u32]) -> Result<(), String> {
    let mut bytes = Vec::with_capacity(8 + words.len() * 4);
    bytes.extend_from_slice(b"GLR1");
    bytes.extend_from_slice(&(words.len() as u32).to_le_bytes());
    for word in words {
        bytes.extend_from_slice(&word.to_le_bytes());
    }
    fs::write(path, bytes).map_err(|error| format!("Cannot write output: {error}"))
}

struct Session {
    pool: CpuExecutor,
    pool_initialization_ms: f64,
    library: Option<PathBuf>,
    context: Option<Context>,
    decoded: Option<(Vec<u8>, Arc<PackedAnalysis>)>,
    resident_cuda: Option<Vec<u8>>,
    profile_path: Option<PathBuf>,
    requests: usize,
    context_creations: usize,
}

impl Session {
    fn new(library: Option<PathBuf>, profile_path: Option<PathBuf>, workers: usize) -> Self {
        let start = Instant::now();
        let pool = CpuExecutor::new(workers);
        Self {
            pool,
            pool_initialization_ms: elapsed(start),
            library,
            context: None,
            decoded: None,
            resident_cuda: None,
            profile_path,
            requests: 0,
            context_creations: 0,
        }
    }

    fn context(&mut self) -> Result<&mut Context, String> {
        if self.context.is_none() {
            let path = self
                .library
                .as_ref()
                .ok_or("CUDA library was not specified")?;
            self.context = Some(Context::new(path)?);
            self.context_creations += 1;
        }
        Ok(self.context.as_mut().unwrap())
    }

    fn request(&mut self, fields: &[&str]) -> Result<String, String> {
        if fields.first() == Some(&"profile") {
            return self.record_profile(fields);
        }
        if fields.len() != 7 {
            return Err(
                "Expected seven TAB fields: id backend algorithm input output residency cpu_mode"
                    .into(),
            );
        }
        let start = Instant::now();
        let (id, backend, algorithm_name, input, output, residency, cpu_name) = (
            fields[0], fields[1], fields[2], fields[3], fields[4], fields[5], fields[6],
        );
        if !matches!(
            backend,
            "cpu" | "cuda" | "hybrid" | "forced-hybrid" | "calibrate" | "abi-check"
        ) {
            return Err("Unknown backend".into());
        }
        if !matches!(residency, "update" | "resident") {
            return Err("Residency must be update or resident".into());
        }
        let mut algorithm = algorithm(algorithm_name)?;
        let mut mode = cpu_mode(cpu_name)?;
        let input_path = fs::canonicalize(input).map_err(|error| error.to_string())?;
        if fs::canonicalize(output).ok().as_ref() == Some(&input_path) {
            return Err("Input and output must differ".into());
        }
        let bytes = fs::read(&input_path).map_err(|error| format!("Cannot read input: {error}"))?;
        let mut decode_ms = 0.0;
        let mut predecessor_ms = 0.0;
        let packed = if residency == "resident" {
            let (previous, packed) = self
                .decoded
                .as_ref()
                .ok_or("No decoded input is resident")?;
            if previous != &bytes {
                return Err("Resident request differs from resident input; use update".into());
            }
            packed.clone()
        } else {
            let (decoded, input_ms, reverse_ms) = glc::decode_timed(&bytes)?;
            decode_ms = input_ms;
            predecessor_ms = reverse_ms;
            let packed = Arc::new(decoded);
            self.decoded = Some((bytes.clone(), packed.clone()));
            packed
        };
        let mut calibration_json = "null".to_string();
        if let Some((_, limit)) = cpu_name.split_once('@') {
            let limit = limit
                .parse()
                .map_err(|_| "Invalid active CPU worker limit")?;
            self.pool.set_worker_limit(
                &packed,
                mode.ok_or("Active worker limit needs explicit mode")?,
                limit,
            )?;
        }
        if backend == "calibrate" {
            let calibration = self.pool.calibrate(packed.clone(), 7)?;
            let variants = calibration
                .variants
                .iter()
                .map(|variant| {
                    format!(
                        "{{\"name\":{},\"workers\":{},\"median_ms\":{},\"p90_ms\":{},\"samples_ms\":{:?}}}",
                        quote(variant.mode.name()),
                        variant.workers,
                        variant.median_ms,
                        variant.p90_ms,
                        variant.samples_ms
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            calibration_json = format!(
                "{{\"selected_mode\":{},\"selected_workers\":{},\"repeats\":{},\"variants\":[{}]}}",
                quote(calibration.selected_mode.name()),
                calibration.selected_workers,
                calibration.repeats,
                variants
            );
            mode = Some(calibration.selected_mode);
        }
        let analysis_start = Instant::now();
        let mut gpu_stats = "null".to_string();
        let mut gpu_functions = 0;
        let mut cpu_functions = packed.functions.len();
        let mut packing_ms = 0.0;
        let mut scatter_ms = 0.0;
        let mut cpu_ms = 0.0;
        let mut submitted_before_cpu = false;
        let mut cpu_while_pending = false;
        let mut event_pending_before_cpu = false;
        let mut event_pending_after_cpu = false;
        let mut pending_rejected = false;
        let mut snapshot_checked = false;
        let mut routing_reason = "Explicit CPU execution".to_string();
        let result = if matches!(backend, "cpu" | "calibrate") {
            let cpu_start = Instant::now();
            let solved = match mode {
                Some(mode) => self.pool.solve_mode(packed.clone(), mode),
                None => self.pool.solve(packed.clone()),
            };
            cpu_ms = elapsed(cpu_start);
            solved
        } else if matches!(backend, "cuda" | "abi-check") {
            if residency == "resident" && self.resident_cuda.as_ref() != Some(&bytes) {
                return Err(
                    "CUDA resident request differs from last GPU upload; use update".into(),
                );
            }
            let context = self.context()?;
            if backend == "abi-check" {
                let mut submitted = (*packed).clone();
                context.submit(&submitted, algorithm)?;
                if context.submit(&submitted, algorithm).is_ok() {
                    return Err("Native adapter accepted a second pending submission".into());
                }
                pending_rejected = true;
                // H2D may still run when the caller changes or drops its input.
                submitted.uses.fill(0);
                submitted.phi_out.fill(0);
                submitted.defs.fill(u32::MAX);
                snapshot_checked = true;
            } else if residency == "resident" {
                context.submit_resident(algorithm)?;
            } else {
                context.submit(&packed, algorithm)?;
            }
            let (solved, stats) = context.finish()?;
            gpu_stats = stats_json(&stats);
            gpu_functions = packed.functions.len();
            cpu_functions = 0;
            self.resident_cuda = Some(bytes);
            routing_reason = "Explicit CUDA execution".into();
            solved
        } else {
            // Mixed execution always counts packing and transfer; replaying a
            // cached subset would conceal costs and changing routing decisions.
            if residency != "update" {
                return Err("Hybrid requires update residency".into());
            }
            let (cpu_indices, gpu_indices, reason, routed_mode, routed_algorithm) =
                self.route(&packed, backend)?;
            if backend == "hybrid" {
                mode = Some(routed_mode);
                algorithm = routed_algorithm;
            }
            routing_reason = reason;
            cpu_functions = cpu_indices.len();
            gpu_functions = gpu_indices.len();
            let mut result = vec![0; packed.total_cells];
            if gpu_indices.is_empty() {
                let cpu_start = Instant::now();
                result = match mode {
                    Some(mode) => self.pool.solve_mode(packed.clone(), mode),
                    None => self.pool.solve(packed.clone()),
                };
                cpu_ms = elapsed(cpu_start);
            } else {
                let packing_start = Instant::now();
                let gpu_pack = select_packed(&packed, &gpu_indices)?;
                let cpu_selection = AnalysisSelection::new(&packed, &cpu_indices)?;
                packing_ms = elapsed(packing_start);
                self.context()?.submit(&gpu_pack, algorithm)?;
                submitted_before_cpu = !cpu_indices.is_empty();
                event_pending_before_cpu = self.context()?.is_pending()?;
                let cpu_start = Instant::now();
                let cpu_output = self.pool.solve_selection(
                    packed.clone(),
                    &cpu_selection,
                    mode.unwrap_or(CpuMode::Serial),
                );
                cpu_ms = elapsed(cpu_start);
                cpu_while_pending = !cpu_indices.is_empty();
                event_pending_after_cpu = self.context()?.is_pending()?;
                let (gpu_output, stats) = self.context()?.finish()?;
                gpu_stats = stats_json(&stats);
                let scatter_start = Instant::now();
                cpu_output.scatter_into(&mut result)?;
                analysis::scatter(&gpu_pack, &gpu_output, &packed, &mut result)?;
                scatter_ms = elapsed(scatter_start);
                self.resident_cuda = None;
            }
            result
        };
        let analysis_ms = elapsed(analysis_start);
        write_result(Path::new(output), &result)?;
        self.requests += 1;
        let total_ms = elapsed(start);
        let capabilities = self
            .context
            .as_ref()
            .map(|context| capabilities_json(&context.capabilities()))
            .unwrap_or_else(|| "null".to_string());
        Ok(format!(concat!(
            "{{\"status\":\"ok\",\"request_id\":{},\"backend\":{},\"algorithm\":{},",
            "\"residency\":{},\"cpu_mode\":{},\"process_id\":{},\"request_number\":{},",
            "\"functions\":{},\"blocks\":{},\"cells\":{},\"actual_gpu_functions\":{},",
            "\"actual_cpu_functions\":{},\"input_decode_ms\":{},\"predecessor_prepare_ms\":{},",
            "\"packing_ms\":{},\"scatter_ms\":{},\"cpu_solve_ms\":{},\"analysis_ms\":{},",
            "\"total_recurrent_ms\":{},\"cpu_pool_initialization_ms\":{},\"cpu_pool_workers\":{},",
            "\"cpu_pool_jobs_completed\":{},\"cpu_pool_submissions\":{},\"cpu_pool_reused\":{},\"cuda_context_creations\":{},\"gpu_stats\":{},",
            "\"capabilities\":{},\"cpu_calibration\":{},\"routing_reason\":{},",
            "\"gpu_submitted_before_cpu\":{},\"cpu_work_before_gpu_finish\":{},",
            "\"second_pending_submit_rejected\":{},\"input_snapshot_ownership_checked\":{},",
            "\"gpu_event_pending_before_cpu\":{},\"gpu_event_pending_after_cpu\":{},",
            "\"overlap_scope\":\"CUDA completion-event state is queried before/after independent CPU work; no device trace is collected to claim kernel/CPU overlap duration.\"}}"
        ), quote(id), quote(backend), quote(match algorithm { Algorithm::Dense => "dense", Algorithm::Sparse => "sparse" }),
            quote(residency), quote(mode.map_or("auto", CpuMode::name)),
            std::process::id(), self.requests, packed.functions.len(), packed.block_count(), packed.total_cells,
            gpu_functions, cpu_functions, decode_ms, predecessor_ms, packing_ms, scatter_ms, cpu_ms,
            analysis_ms, total_ms, self.pool_initialization_ms, self.pool.worker_count(), self.pool.jobs_completed(),
            self.pool.pool_submissions(), self.pool.pool_reused(),
            self.context_creations, gpu_stats, capabilities, calibration_json, quote(&routing_reason),
            submitted_before_cpu, cpu_while_pending, pending_rejected, snapshot_checked,
            event_pending_before_cpu, event_pending_after_cpu))
    }

    fn record_profile(&mut self, fields: &[&str]) -> Result<String, String> {
        if !(9..=10).contains(&fields.len()) {
            return Err("Expected profile,input,cpu_mode,algorithm,four sample arrays,output[,candidate indices]".into());
        }
        let bytes = fs::read(fields[1]).map_err(|error| error.to_string())?;
        let (packed, _, _) = glc::decode_timed(&bytes)?;
        let mode = cpu_mode(fields[2])?.ok_or("Profile requires an explicit CPU mode")?;
        let alg = match fields[3] {
            "dense" => routing::GpuAlgorithm::Dense,
            "sparse" => routing::GpuAlgorithm::Sparse,
            _ => return Err("Unknown profile algorithm".into()),
        };
        let samples = fields[4..8]
            .iter()
            .map(|raw| {
                raw.split(',')
                    .map(|value| {
                        value
                            .parse::<f64>()
                            .map_err(|_| "Invalid sample value".to_string())
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .collect::<Result<Vec<_>, _>>()?;
        let workers = self.pool.worker_count();
        let fingerprint = self.context()?.capabilities().fingerprint(workers);
        let identity = routing::hardware_identity(&fingerprint, workers);
        let path = Path::new(fields[8]);
        let mut profile = if path.exists() {
            routing::RouteProfile::load(path)?
        } else {
            routing::RouteProfile::new(identity.clone(), routing::Objective::Latency)
        };
        if profile.hardware_identity != identity {
            return Err("Existing profile hardware identity differs".into());
        }
        let active_workers = self.pool.worker_limit(&packed, mode);
        if let Some(indices) = fields.get(9) {
            let indices = indices
                .split(',')
                .map(|value| {
                    value
                        .parse::<usize>()
                        .map_err(|_| "Invalid candidate index".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            let candidate = select_packed(&packed, &indices)?;
            profile.record_with_context_and_workers(
                &candidate,
                &packed,
                mode,
                active_workers,
                alg,
                &samples[0],
                &samples[1],
                &samples[2],
                &samples[3],
            )?;
        } else {
            profile.record_with_context_and_workers(
                &packed,
                &packed,
                mode,
                active_workers,
                alg,
                &samples[0],
                &samples[1],
                &samples[2],
                &samples[3],
            )?;
        }
        profile.save(path)?;
        let plan = profile.plan(&packed, &identity, routing::Objective::Latency);
        Ok(format!("{{\"status\":\"ok\",\"process_id\":{},\"profile_path\":{},\"gpu_functions_admitted\":{},\"cpu_functions\":{},\"reason\":{}}}",
            std::process::id(), quote(fields[8]), plan.gpu_indices.len(), plan.cpu_indices.len(), quote(&plan.reason)))
    }

    #[allow(clippy::type_complexity)]
    fn route(
        &mut self,
        packed: &PackedAnalysis,
        backend: &str,
    ) -> Result<(Vec<usize>, Vec<usize>, String, CpuMode, Algorithm), String> {
        if backend == "forced-hybrid" {
            let (gpu, cpu): (Vec<_>, Vec<_>) = packed
                .functions
                .iter()
                .partition(|function| function.block_count <= 64);
            return Ok((
                cpu.iter().map(|f| f.module_index).collect(),
                gpu.iter().map(|f| f.module_index).collect(),
                "Forced split for independent-subset correctness; not a speedup policy".into(),
                CpuMode::Serial,
                Algorithm::Dense,
            ));
        }
        if let Some(path) = self.profile_path.clone() {
            let profile = routing::RouteProfile::load(&path)?;
            let workers = self.pool.worker_count();
            let fingerprint = self.context()?.capabilities().fingerprint(workers);
            let identity = routing::hardware_identity(&fingerprint, workers);
            let plan = profile.plan(packed, &identity, routing::Objective::Latency);
            if let Some(limit) = plan.cpu_worker_limit {
                self.pool.set_worker_limit(packed, plan.cpu_mode, limit)?;
            }
            let algorithm = match plan.algorithm {
                routing::GpuAlgorithm::Dense => Algorithm::Dense,
                routing::GpuAlgorithm::Sparse => Algorithm::Sparse,
            };
            return Ok((
                plan.cpu_indices,
                plan.gpu_indices,
                plan.reason,
                plan.cpu_mode,
                algorithm,
            ));
        }
        Ok((
            packed.functions.iter().map(|f| f.module_index).collect(),
            vec![],
            "No validated route profile; conservative CPU fallback".into(),
            CpuMode::Serial,
            Algorithm::Dense,
        ))
    }
}

fn stats_json(stats: &cuda::Stats) -> String {
    stats.json()
}

fn capabilities_json(cap: &cuda::Capabilities) -> String {
    cap.json()
}

fn run() -> Result<(), String> {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let mut library = None;
    let mut profile = None;
    let mut workers = 0;
    let mut index = 0;
    let mut serve = false;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--serve" => serve = true,
            "--cuda-library" | "--route-profile" | "--threads" => {
                let value = arguments.get(index + 1).ok_or("Option requires a value")?;
                match arguments[index].as_str() {
                    "--cuda-library" => library = Some(PathBuf::from(value)),
                    "--route-profile" => profile = Some(PathBuf::from(value)),
                    _ => workers = value.parse().map_err(|_| "Invalid thread count")?,
                }
                index += 1;
            }
            "--help" => {
                println!("Usage: gpu-native-benchmark --serve [--cuda-library LIB] [--route-profile CSV] [--threads N]");
                println!("stdin: id TAB backend TAB algorithm TAB input TAB output TAB update|resident TAB auto|serial|function_parallel|word_parallel");
                return Ok(());
            }
            _ => return Err(format!("Unknown argument: {}", arguments[index])),
        }
        index += 1;
    }
    if !serve || workers > 256 {
        return Err(
            "--serve is required; thread count must be 0..=256 (0 uses all available CPUs)".into(),
        );
    }
    let mut session = Session::new(library, profile, workers);
    for line in io::stdin().lock().lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line == "quit" {
            break;
        }
        let fields = line.split('\t').collect::<Vec<_>>();
        let response = match session.request(&fields) {
            Ok(value) => value,
            Err(error) => format!(
                "{{\"status\":\"error\",\"request_id\":{},\"error\":{},\"process_id\":{}}}",
                quote(fields.first().copied().unwrap_or("")),
                quote(&error),
                std::process::id()
            ),
        };
        println!("{response}");
        io::stdout().flush().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{{\"error\":{}}}", quote(&error));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn subset_pack_remaps_edges_and_scatter_without_leaking_function_ownership() {
        let words = [
            2u32, 3, 3, 2, 2, 1, 0, 2, 0, 1, 0, 2, 1, 2, 1, 0, 0, 1, 1, 1, 1, 0, 1, 2, 0, 0, 0, 0,
            0, 0,
        ];
        let mut bytes = b"GLC1".to_vec();
        bytes.extend(words.iter().flat_map(|word| word.to_le_bytes()));
        let original = glc::decode(&bytes).unwrap();
        let subset = select_packed(&original, &[1]).unwrap();
        assert_eq!(subset.functions[0].module_index, 1);
        assert_eq!(subset.functions[0].block_base, 0);
        assert!(subset.successors.is_empty());
        let mut result = vec![0; 3];
        analysis::scatter(
            &subset,
            &analysis::solve_cpu_serial(&subset),
            &original,
            &mut result,
        )
        .unwrap();
        assert_eq!(result, vec![0, 0, 2]);
        assert!(select_packed(&original, &[1, 1]).is_err());
    }
}
