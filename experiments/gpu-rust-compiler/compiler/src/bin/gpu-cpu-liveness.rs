// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[allow(dead_code)]
// Benchmark the existing native solver unchanged, including its indexed
// bitset loop. The shared compiler module predates this benchmark executable.
#[allow(clippy::needless_range_loop)]
#[path = "../analysis.rs"]
mod analysis;
#[path = "../glc.rs"]
mod glc;
#[allow(dead_code)]
#[path = "../ir.rs"]
mod ir;

use analysis::{solve_cpu_parallel, solve_cpu_serial, solve_cpu_word_parallel, PackedAnalysis};
use std::{env, fs, io::Write, time::Instant};

struct Variant {
    name: &'static str,
    threads: usize,
    first_ms: f64,
    samples_ms: Vec<f64>,
}

fn statistics(samples: &[f64]) -> String {
    let mut sorted = samples.to_vec();
    sorted.sort_unstable_by(f64::total_cmp);
    let middle = sorted.len() / 2;
    let median = if sorted.len().is_multiple_of(2) {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    } else {
        sorted[middle]
    };
    format!(
        "{{\"min_ms\":{},\"median_ms\":{},\"max_ms\":{},\"samples_ms\":{:?}}}",
        sorted[0],
        median,
        sorted[sorted.len() - 1],
        samples
    )
}

fn median(variant: &Variant) -> f64 {
    let mut sorted = variant.samples_ms.clone();
    sorted.sort_unstable_by(f64::total_cmp);
    let middle = sorted.len() / 2;
    if sorted.len().is_multiple_of(2) {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    } else {
        sorted[middle]
    }
}

fn measure(
    packed: &PackedAnalysis,
    reference: &[u32],
    repeats: usize,
    name: &'static str,
    threads: usize,
    solve: fn(&PackedAnalysis) -> Vec<u32>,
) -> Result<Variant, String> {
    let first_start = Instant::now();
    let first_result = solve(packed);
    let first_ms = first_start.elapsed().as_secs_f64() * 1_000.0;
    if first_result != reference {
        return Err(format!(
            "CPU {name} output differs from the serial worklist"
        ));
    }
    let mut samples_ms = Vec::with_capacity(repeats);
    for _ in 0..repeats {
        let start = Instant::now();
        let result = solve(packed);
        samples_ms.push(start.elapsed().as_secs_f64() * 1_000.0);
        // Equality checking is deliberately outside the solve timer, as in
        // CUDA. Output allocation, scratch reset and thread creation are in it.
        if result != reference {
            return Err(format!("CPU {name} output changed between repetitions"));
        }
    }
    Ok(Variant {
        name,
        threads,
        first_ms,
        samples_ms,
    })
}

fn run() -> Result<(), String> {
    let arguments = env::args_os().skip(1).collect::<Vec<_>>();
    if arguments.len() == 1 && arguments[0] == "--help" {
        println!("Usage: gpu-cpu-liveness INPUT.bin OUTPUT.bin [repeats]");
        return Ok(());
    }
    if !(2..=3).contains(&arguments.len()) {
        return Err("Usage: gpu-cpu-liveness INPUT.bin OUTPUT.bin [repeats]".into());
    }
    let repeats = if let Some(raw) = arguments.get(2) {
        raw.to_str()
            .ok_or("Invalid repetition count")?
            .parse::<usize>()
            .map_err(|_| "Invalid repetition count")?
    } else {
        15
    };
    if !(1..=10_000).contains(&repeats) {
        return Err("Repetitions must be in 1..=10000".into());
    }
    let input_path = fs::canonicalize(&arguments[0])
        .map_err(|error| format!("Cannot resolve input: {error}"))?;
    if fs::canonicalize(&arguments[1]).ok().as_ref() == Some(&input_path) {
        return Err("Input and output must be different files".into());
    }
    let bytes = fs::read(&arguments[0]).map_err(|error| format!("Cannot read input: {error}"))?;
    let initialize = Instant::now();
    let (packed, input_decode_ms, predecessor_prepare_ms) = glc::decode_timed(&bytes)?;
    let initialization_ms = initialize.elapsed().as_secs_f64() * 1_000.0;
    let reference = solve_cpu_serial(&packed);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let function_worker_limit = threads.min(packed.functions.len());
    let functions_per_worker = packed.functions.len().div_ceil(function_worker_limit);
    let function_workers = packed.functions.len().div_ceil(functions_per_worker);
    let word_tasks = packed
        .functions
        .iter()
        .map(|f| f.words.div_ceil(4))
        .sum::<usize>();
    let variants = [
        measure(&packed, &reference, repeats, "serial", 1, solve_cpu_serial)?,
        measure(
            &packed,
            &reference,
            repeats,
            "function_parallel",
            function_workers,
            solve_cpu_parallel,
        )?,
        measure(
            &packed,
            &reference,
            repeats,
            "word_parallel",
            threads.min(word_tasks),
            solve_cpu_word_parallel,
        )?,
    ];
    let selected = variants
        .iter()
        .min_by(|left, right| median(left).total_cmp(&median(right)))
        .unwrap();
    let mut result = fs::File::create(&arguments[1])
        .map_err(|error| format!("Cannot create output: {error}"))?;
    result
        .write_all(b"GLR1")
        .map_err(|error| error.to_string())?;
    result
        .write_all(&(reference.len() as u32).to_le_bytes())
        .map_err(|error| error.to_string())?;
    for cell in &reference {
        result
            .write_all(&cell.to_le_bytes())
            .map_err(|error| error.to_string())?;
    }
    let variant_json = variants.iter().map(|variant| format!(
        "{{\"name\":\"{}\",\"threads\":{},\"first_pass_end_to_end_ms\":{},\"repeat_outputs_equal\":true,\"warm_pass_end_to_end_ms\":{}}}",
        variant.name, variant.threads, variant.first_ms, statistics(&variant.samples_ms)
    )).collect::<Vec<_>>().join(",");
    println!(concat!(
        "{{\"backend\":\"cpu-native\",\"functions\":{},\"blocks\":{},\"cells\":{},",
        "\"groups\":{},\"max_blocks\":{},\"threads\":{},\"repeats\":{},",
        "\"selected_variant\":\"{}\",\"repeat_outputs_equal\":true,\"initialization_ms\":{},",
        "\"input_decode_ms\":{},\"predecessor_prepare_ms\":{},\"first_pass_end_to_end_ms\":{},",
        "\"warm_pass_end_to_end_ms\":{},\"variants\":[{}],",
        "\"timing_scope\":\"Warm elapsed includes solve, output and scratch allocation/reset, result materialization, and worker thread creation/join where used; excludes input file IO, GLC1 decoding, predecessor CSR preparation, output file IO, and cross-variant verification.\"}}"
    ), packed.functions.len(), packed.block_count(), packed.total_cells,
        packed.groups.len(), packed.max_blocks(), threads, repeats, selected.name,
        initialization_ms, input_decode_ms, predecessor_prepare_ms, selected.first_ms,
        statistics(&selected.samples_ms), variant_json);
    Ok(())
}

fn json_string(value: &str) -> String {
    let mut output = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            control if control.is_control() => {
                output.push_str(&format!("\\u{:04x}", control as u32))
            }
            normal => output.push(normal),
        }
    }
    output.push('"');
    output
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{{\"error\":{}}}", json_string(&error));
        std::process::exit(1);
    }
}
