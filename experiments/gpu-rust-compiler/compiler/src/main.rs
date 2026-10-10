// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod analysis;
mod frontend;
mod ir;
mod llvm;
mod metal;

use std::{
    env, fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    process::{self, Command},
    time::Instant,
};

#[derive(Clone, Copy, Debug)]
enum Backend {
    Cpu,
    Metal,
    Hybrid,
}
impl Backend {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "cpu" => Ok(Self::Cpu),
            "metal" => Ok(Self::Metal),
            "hybrid" => Ok(Self::Hybrid),
            _ => Err(format!(
                "Unsupported native backend {value}; choose cpu, metal, or hybrid"
            )),
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::Metal => "metal",
            Self::Hybrid => "hybrid",
        }
    }
}
struct Options {
    source: Option<PathBuf>,
    emit: Option<PathBuf>,
    output: Option<PathBuf>,
    report: Option<PathBuf>,
    backend: Option<Backend>,
    shader: PathBuf,
    serve: bool,
    verify: bool,
}
fn options() -> Result<Option<Options>, String> {
    let mut result = Options {
        source: None,
        emit: None,
        output: None,
        report: None,
        backend: None,
        shader: Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("src/liveness.metal"),
        serve: false,
        verify: false,
    };
    let mut arguments = env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--help" | "-h" => {
                println!("Usage: gpu-rust-compiler SOURCE.rs --output EXECUTABLE --backend cpu|metal|hybrid [--verify] [--emit-llvm FILE] [--report FILE]");
                println!("       gpu-rust-compiler --serve --backend cpu|metal|hybrid [--verify] [--shader FILE]");
                println!("Worker input: compile<TAB>SOURCE<TAB>OUTPUT<TAB>REPORT (REPORT may be empty). One JSON response per request.");
                println!("Raw frontend compatibility: SOURCE.rs --emit-llvm FILE (without --backend or --output).");
                return Ok(None);
            }
            "--serve" => result.serve = true,
            "--verify" => result.verify = true,
            "--emit-llvm" => {
                result.emit = Some(PathBuf::from(arguments.next().ok_or("Missing LLVM path")?))
            }
            "--output" => {
                result.output = Some(PathBuf::from(
                    arguments.next().ok_or("Missing executable path")?,
                ))
            }
            "--report" => {
                result.report = Some(PathBuf::from(
                    arguments.next().ok_or("Missing report path")?,
                ))
            }
            "--shader" => {
                result.shader = PathBuf::from(arguments.next().ok_or("Missing shader path")?)
            }
            "--backend" => {
                result.backend = Some(Backend::parse(&arguments.next().ok_or("Missing backend")?)?)
            }
            _ if !argument.starts_with('-') && result.source.is_none() => {
                result.source = Some(PathBuf::from(argument))
            }
            _ => return Err(format!("Unknown option {argument}")),
        }
    }
    if !result.serve && result.source.is_none() {
        return Err("A source path or --serve is required".into());
    }
    if result.serve && result.source.is_some() {
        return Err("--serve receives source paths through stdin".into());
    }
    Ok(Some(result))
}
fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn json_string(text: &str) -> String {
    let mut result = String::from("\"");
    for ch in text.chars() {
        match ch {
            '"' => result.push_str("\\\""),
            '\\' => result.push_str("\\\\"),
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            ch if ch < '\u{20}' => result.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => result.push(ch),
        }
    }
    result.push('"');
    result
}
fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}
struct Report {
    backend: Backend,
    source: PathBuf,
    output: PathBuf,
    request: usize,
    total: f64,
    frontend: f64,
    packing: f64,
    analysis: f64,
    pruning: f64,
    codegen: f64,
    removed: usize,
    functions: usize,
    cpu_functions: usize,
    gpu_functions: usize,
    verified: bool,
    pipeline_creations: usize,
    gpu_submissions: usize,
    gpu: Option<metal::Stats>,
}
impl Report {
    fn json(&self) -> String {
        let (gpu_ms, reused, allocations, sweeps) = if let Some(gpu) = self.gpu {
            (
                format!("{:.6}", gpu.gpu_ms),
                gpu.reused_pipeline != 0,
                gpu.buffer_allocations,
                gpu.max_sweeps,
            )
        } else {
            ("null".into(), false, 0, 0)
        };
        format!(concat!(
            "{{\"status\":\"ok\",\"compiler\":\"native scalar Rust-subset compiler\",",
            "\"backend\":{},\"source\":{},\"output\":{},\"process_id\":{},\"request_number\":{},",
            "\"total_compile_ms\":{:.6},\"frontend_and_structured_ir_ms\":{:.6},\"native_packing_ms\":{:.6},",
            "\"analysis_ms\":{:.6},\"dead_code_pruning_ms\":{:.6},\"native_codegen_and_link_ms\":{:.6},",
            "\"dead_scalar_instructions_removed\":{},\"functions\":{},\"cpu_functions\":{},\"actual_gpu_functions\":{},",
            "\"verified_against_cpu\":{},\"gpu_pipeline_creations\":{},\"gpu_submissions_total\":{},",
            "\"gpu_execution_ms\":{},\"gpu_pipeline_reused\":{},\"gpu_buffer_allocations\":{},\"gpu_max_sweeps\":{},",
            "\"analysis_transport\":\"native memory; no textual IR parsing, JSON handoff, or analysis subprocess\",",
            "\"remaining_codegen_subprocess\":\"clang\"}}"),
            json_string(self.backend.name()), json_string(&self.source.to_string_lossy()), json_string(&self.output.to_string_lossy()),
            process::id(), self.request, self.total, self.frontend, self.packing, self.analysis, self.pruning, self.codegen,
            self.removed, self.functions, self.cpu_functions, self.gpu_functions, self.verified,
            self.pipeline_creations, self.gpu_submissions, gpu_ms, reused, allocations, sweeps)
    }
}
struct Compiler {
    backend: Backend,
    shader: PathBuf,
    verify: bool,
    metal: Option<metal::Context>,
    pipeline_creations: usize,
    requests: usize,
}
impl Compiler {
    fn new(backend: Backend, shader: PathBuf, verify: bool) -> Self {
        Self {
            backend,
            shader,
            verify,
            metal: None,
            pipeline_creations: 0,
            requests: 0,
        }
    }
    fn gpu(&mut self) -> Result<&mut metal::Context, String> {
        if self.metal.is_none() {
            self.metal = Some(metal::Context::new(&self.shader)?);
            self.pipeline_creations += 1;
        }
        Ok(self.metal.as_mut().unwrap())
    }
    fn compile(
        &mut self,
        source: &Path,
        output: &Path,
        emit: Option<&Path>,
        report: Option<&Path>,
    ) -> Result<Report, String> {
        self.requests += 1;
        let start = Instant::now();
        let source_text =
            fs::read_to_string(source).map_err(|e| format!("{}: {e}", source.display()))?;
        let program = frontend::parse(&source_text)?;
        let module = llvm::emit_structured(&program)?;
        let frontend = ms(start);
        let stage = Instant::now();
        let packed = analysis::prepare(&module)?;
        let packing = ms(stage);
        let stage = Instant::now();
        let mut cpu_functions = module.functions.len();
        let mut gpu_functions = 0;
        let mut gpu_stats = None;
        let solution = match self.backend {
            Backend::Cpu => analysis::solve_cpu(&packed),
            Backend::Metal => {
                self.gpu()?.submit(&packed)?;
                let (solution, stats) = self.gpu()?.finish()?;
                cpu_functions = 0;
                gpu_functions = module.functions.len();
                gpu_stats = Some(stats);
                solution
            }
            Backend::Hybrid => {
                let plan = analysis::hybrid_plan(&packed);
                if plan.gpu_indices.is_empty() {
                    analysis::solve_cpu(&packed)
                } else {
                    let gpu_pack = analysis::prepare_subset(&module, &plan.gpu_indices)?;
                    let cpu_pack = analysis::prepare_subset(&module, &plan.cpu_indices)?;
                    self.gpu()?.submit(&gpu_pack)?;
                    let cpu_values = analysis::solve_cpu(&cpu_pack);
                    let (gpu_values, stats) = self.gpu()?.finish()?;
                    let mut result = vec![0; packed.total_cells];
                    analysis::scatter(&cpu_pack, &cpu_values, &packed, &mut result)?;
                    analysis::scatter(&gpu_pack, &gpu_values, &packed, &mut result)?;
                    cpu_functions = plan.cpu_indices.len();
                    gpu_functions = plan.gpu_indices.len();
                    gpu_stats = Some(stats);
                    result
                }
            }
        };
        if self.verify && solution != analysis::solve_cpu_serial(&packed) {
            return Err("Native selected-backend liveness disagrees with CPU oracle".into());
        }
        let analysis = ms(stage);
        let stage = Instant::now();
        let (optimized, removed) = analysis::prune(&module, &packed, &solution)?;
        let pruning = ms(stage);
        let stage = Instant::now();
        let ir_path = emit
            .map(Path::to_owned)
            .unwrap_or_else(|| output.with_extension("native.ll"));
        ensure_parent(&ir_path)?;
        ensure_parent(output)?;
        fs::write(&ir_path, optimized).map_err(|e| e.to_string())?;
        let generated = Command::new("clang")
            .args(["-Wno-override-module", "-O0"])
            .arg(&ir_path)
            .arg("-o")
            .arg(output)
            .output()
            .map_err(|e| format!("clang: {e}"))?;
        if !generated.status.success() {
            return Err(format!(
                "Native code generation failed: {}",
                String::from_utf8_lossy(&generated.stderr)
            ));
        }
        let codegen = ms(stage);
        let result = Report {
            backend: self.backend,
            source: source.to_owned(),
            output: output.to_owned(),
            request: self.requests,
            total: ms(start),
            frontend,
            packing,
            analysis,
            pruning,
            codegen,
            removed,
            functions: module.functions.len(),
            cpu_functions,
            gpu_functions,
            verified: self.verify,
            pipeline_creations: self.pipeline_creations,
            gpu_submissions: self.metal.as_ref().map_or(0, |gpu| gpu.submissions),
            gpu: gpu_stats,
        };
        if let Some(path) = report {
            ensure_parent(path)?;
            fs::write(path, result.json() + "\n").map_err(|e| e.to_string())?;
        }
        Ok(result)
    }
}
fn run() -> Result<(), String> {
    let Some(options) = options()? else {
        return Ok(());
    };
    if options.serve {
        let mut compiler = Compiler::new(
            options.backend.unwrap_or(Backend::Hybrid),
            options.shader,
            options.verify,
        );
        let stdin = io::stdin();
        let mut stdout = io::stdout().lock();
        for line in stdin.lock().lines() {
            let line = line.map_err(|e| e.to_string())?;
            if line == "quit" {
                break;
            }
            let fields: Vec<_> = line.split('\t').collect();
            let result = if fields.len() == 4
                && fields[0] == "compile"
                && !fields[1].is_empty()
                && !fields[2].is_empty()
            {
                compiler.compile(
                    Path::new(fields[1]),
                    Path::new(fields[2]),
                    None,
                    (!fields[3].is_empty()).then(|| Path::new(fields[3])),
                )
            } else {
                Err("Expected compile<TAB>SOURCE<TAB>OUTPUT<TAB>REPORT; paths cannot contain tabs or newlines".into())
            };
            let response = match result {
                Ok(report) => report.json(),
                Err(error) => format!("{{\"status\":\"error\",\"error\":{}}}", json_string(&error)),
            };
            writeln!(stdout, "{response}").map_err(|e| e.to_string())?;
            stdout.flush().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let source = options.source.as_ref().unwrap();
    if options.output.is_none() && options.backend.is_none() {
        let emit = options
            .emit
            .as_ref()
            .ok_or("--emit-llvm or --output is required")?;
        let program = frontend::parse(&fs::read_to_string(source).map_err(|e| e.to_string())?)?;
        ensure_parent(emit)?;
        fs::write(emit, llvm::emit(&program)?).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let output = options
        .output
        .as_ref()
        .ok_or("Native compilation requires --output")?;
    let mut compiler = Compiler::new(
        options.backend.unwrap_or(Backend::Hybrid),
        options.shader,
        options.verify,
    );
    println!(
        "{}",
        compiler
            .compile(
                source,
                output,
                options.emit.as_deref(),
                options.report.as_deref()
            )?
            .json()
    );
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("gpu-rust-compiler: {error}");
        process::exit(1);
    }
}
