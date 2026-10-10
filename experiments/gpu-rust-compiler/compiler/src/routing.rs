// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Measured placement policy. Profiles are specific to hardware and objective,
//! and GPU admission requires separate heldout samples of total recurring cost.
//! Shape classes are input properties, never device-name thresholds.

use crate::{
    analysis::{FunctionDesc, PackedAnalysis},
    executor::CpuMode,
};
use std::{collections::BTreeMap, fs, path::Path};

/// Bind evidence to CPU capacity, compiled experimental revision, and the
/// complete GPU/driver/runtime fingerprint supplied by the native adapter.
pub fn hardware_identity(gpu_fingerprint: &str, worker_count: usize) -> String {
    let model = fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|text| {
            text.lines().find_map(|line| {
                line.strip_prefix("model name").and_then(|value| {
                    value
                        .split_once(':')
                        .map(|(_, name)| name.trim().to_string())
                })
            })
        })
        .unwrap_or_else(|| format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH));
    let available = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let revision = std::env::var("CANDIDATE_SHA").unwrap_or_else(|_| "unversioned-local".into());
    format!("gpu={gpu_fingerprint}|cpu={model}|available={available}|workers={worker_count}|revision={revision}")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Objective {
    Latency,
    Throughput,
}
impl Objective {
    pub fn name(self) -> &'static str {
        match self {
            Self::Latency => "latency",
            Self::Throughput => "throughput",
        }
    }
    fn parse(s: &str) -> Result<Self, String> {
        match s {
            "latency" => Ok(Self::Latency),
            "throughput" => Ok(Self::Throughput),
            _ => Err("Unknown routing objective".into()),
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GpuAlgorithm {
    Dense,
    Sparse,
}
impl GpuAlgorithm {
    pub fn name(self) -> &'static str {
        match self {
            Self::Dense => "dense",
            Self::Sparse => "sparse",
        }
    }
    fn parse(s: &str) -> Result<Self, String> {
        match s {
            "dense" => Ok(Self::Dense),
            "sparse" => Ok(Self::Sparse),
            _ => Err("Unknown GPU algorithm".into()),
        }
    }
}

/// Powers-of-two dimension classes plus GEN/phi density and dependence shape.
/// Include aggregate batch size so a fast large batch cannot admit tiny inputs.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ShapeBucket {
    pub functions: usize,
    pub cells: usize,
    pub blocks: usize,
    pub words: usize,
    pub density: usize,
    pub edges: usize,
    pub depth: usize,
    pub cycles: usize,
}
impl ShapeBucket {
    pub fn from_packed(p: &PackedAnalysis) -> Self {
        Self::from_functions(p, p.functions.iter())
    }
    fn from_functions<'a>(
        p: &PackedAnalysis,
        functions: impl Iterator<Item = &'a FunctionDesc>,
    ) -> Self {
        let (
            mut count,
            mut cells,
            mut max_blocks,
            mut max_words,
            mut used,
            mut edges,
            mut depth,
            mut cycles,
        ) = (0, 0, 0, 0, 0usize, 0, 0, 0);
        for f in functions {
            count += 1;
            cells += f.block_count * f.words;
            max_blocks = max_blocks.max(f.block_count);
            max_words = max_words.max(f.words);
            let end = f.row_base + f.block_count * f.words;
            used += p.uses[f.row_base..end]
                .iter()
                .zip(&p.phi_out[f.row_base..end])
                .map(|(u, phi)| (u | phi).count_ones() as usize)
                .sum::<usize>();
            edges += (p.successor_offsets[f.block_base + f.block_count]
                - p.successor_offsets[f.block_base]) as usize;
            let (function_depth, has_cycle) = forward_depth(p, f);
            depth = depth.max(function_depth);
            cycles |= usize::from(has_cycle);
        }
        let density = if used == 0 {
            0
        } else if used.saturating_mul(100) <= cells.saturating_mul(32) {
            1
        } else if used.saturating_mul(10) <= cells.saturating_mul(32) {
            2
        } else {
            3
        };
        // Edge density is normalized by maximum function dimensions and count;
        // other shape fields still distinguish varying-width/size batches.
        Self {
            functions: log_class(count),
            cells: log_class(cells),
            blocks: log_class(max_blocks),
            words: log_class(max_words),
            density,
            edges: log_class(edges.div_ceil(count.max(1))),
            depth: log_class(depth),
            cycles,
        }
    }
    fn fields(self) -> [usize; 8] {
        [
            self.functions,
            self.cells,
            self.blocks,
            self.words,
            self.density,
            self.edges,
            self.depth,
            self.cycles,
        ]
    }
    fn from_fields(v: &[usize]) -> Self {
        Self {
            functions: v[0],
            cells: v[1],
            blocks: v[2],
            words: v[3],
            density: v[4],
            edges: v[5],
            depth: v[6],
            cycles: v[7],
        }
    }
    fn function_key(mut self) -> Self {
        self.functions = 0;
        self.cells = 0;
        self
    }
}
fn log_class(n: usize) -> usize {
    if n == 0 {
        0
    } else {
        usize::BITS as usize - n.leading_zeros() as usize
    }
}

// Forward-only dependence depth is cheap and deterministic. Backedges are
// separately encoded; no unmeasured SCC decomposition is hidden in routing.
fn forward_depth(p: &PackedAnalysis, f: &FunctionDesc) -> (usize, bool) {
    let mut lengths = vec![1usize; f.block_count];
    let mut cycle = false;
    for local in 0..f.block_count {
        let block = f.block_base + local;
        for &target in &p.successors
            [p.successor_offsets[block] as usize..p.successor_offsets[block + 1] as usize]
        {
            let target = target as usize - f.block_base;
            if target > local {
                lengths[target] = lengths[target].max(lengths[local] + 1);
            } else {
                cycle = true;
            }
        }
    }
    (lengths.into_iter().max().unwrap_or(0), cycle)
}
fn long_forward_chain(p: &PackedAnalysis, f: &FunctionDesc) -> bool {
    if f.block_count < 128 {
        return false;
    }
    let (depth, cycle) = forward_depth(p, f);
    !cycle
        && depth == f.block_count
        && (0..f.block_count).all(|local| {
            let block = f.block_base + local;
            p.successor_offsets[block + 1] - p.successor_offsets[block] <= 1
        })
}

#[derive(Clone, Debug)]
pub struct CostInterval {
    pub p10_ms: f64,
    pub median_ms: f64,
    pub p90_ms: f64,
    pub samples: usize,
}
impl CostInterval {
    fn new(samples: &[f64]) -> Result<Self, String> {
        if samples.len() < 5 || samples.iter().any(|v| !v.is_finite() || *v <= 0.0) {
            return Err(
                "Routing calibration needs at least five finite positive elapsed samples".into(),
            );
        }
        let mut sorted = samples.to_vec();
        sorted.sort_unstable_by(f64::total_cmp);
        let q = |fraction: f64| {
            let position = (sorted.len() - 1) as f64 * fraction;
            let first = position.floor() as usize;
            let last = position.ceil() as usize;
            sorted[first] + (sorted[last] - sorted[first]) * (position - first as f64)
        };
        Ok(Self {
            p10_ms: q(0.1),
            median_ms: q(0.5),
            p90_ms: q(0.9),
            samples: samples.len(),
        })
    }
    fn valid(&self) -> bool {
        self.samples >= 5
            && self.p10_ms.is_finite()
            && self.p10_ms > 0.0
            && self.median_ms >= self.p10_ms
            && self.p90_ms.is_finite()
            && self.p90_ms >= self.median_ms
    }
}
#[derive(Clone, Debug)]
pub struct RouteObservation {
    pub bucket: ShapeBucket,
    pub context_bucket: ShapeBucket,
    pub cpu_mode: CpuMode,
    pub cpu_worker_limit: usize,
    pub algorithm: GpuAlgorithm,
    pub training_cpu: CostInterval,
    pub training_gpu: CostInterval,
    pub heldout_cpu: CostInterval,
    pub heldout_gpu: CostInterval,
}
impl RouteObservation {
    fn stable_win(&self) -> bool {
        // A 10% separation of the central 80% distributions rejects noise and
        // removes the temptation to route from kernel-only speedups.
        self.training_gpu.p90_ms < self.training_cpu.p10_ms * 0.9
            && self.heldout_gpu.p90_ms < self.heldout_cpu.p10_ms * 0.9
    }
}

#[derive(Clone, Debug)]
pub struct RoutePlan {
    pub cpu_indices: Vec<usize>,
    pub gpu_indices: Vec<usize>,
    pub cpu_mode: CpuMode,
    pub cpu_worker_limit: Option<usize>,
    pub algorithm: GpuAlgorithm,
    pub reason: String,
    pub cpu_ms: Option<f64>,
    pub gpu_ms: Option<f64>,
}
#[derive(Clone, Debug)]
pub struct RouteProfile {
    pub hardware_identity: String,
    pub objective: Objective,
    pub observations: Vec<RouteObservation>,
}
impl RouteProfile {
    pub fn new(hardware_identity: String, objective: Objective) -> Self {
        Self {
            hardware_identity,
            objective,
            observations: Vec::new(),
        }
    }
    /// GPU samples must be total recurring elapsed cost: subset packing and
    /// staging, upload, kernel and convergence wait, download and assembly.
    /// For mixed execution include the CPU remainder and overlap boundary.
    #[allow(clippy::too_many_arguments)]
    pub fn record(
        &mut self,
        p: &PackedAnalysis,
        cpu_mode: CpuMode,
        algorithm: GpuAlgorithm,
        training_cpu_ms: &[f64],
        training_gpu_total_ms: &[f64],
        heldout_cpu_ms: &[f64],
        heldout_gpu_total_ms: &[f64],
    ) -> Result<(), String> {
        self.record_with_context(
            p,
            p,
            cpu_mode,
            algorithm,
            training_cpu_ms,
            training_gpu_total_ms,
            heldout_cpu_ms,
            heldout_gpu_total_ms,
        )
    }

    /// For heterogeneous placement, the CPU baseline covers the entire parent
    /// and GPU elapsed covers candidate packing + GPU + CPU remainder + scatter.
    /// Binding the parent shape prevents recycling a cheap remainder's evidence
    /// for another program with an expensive CPU critical path.
    #[allow(clippy::too_many_arguments)]
    pub fn record_with_context(
        &mut self,
        p: &PackedAnalysis,
        parent: &PackedAnalysis,
        cpu_mode: CpuMode,
        algorithm: GpuAlgorithm,
        training_cpu_ms: &[f64],
        training_gpu_total_ms: &[f64],
        heldout_cpu_ms: &[f64],
        heldout_gpu_total_ms: &[f64],
    ) -> Result<(), String> {
        self.record_with_context_and_workers(
            p,
            parent,
            cpu_mode,
            0,
            algorithm,
            training_cpu_ms,
            training_gpu_total_ms,
            heldout_cpu_ms,
            heldout_gpu_total_ms,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_with_context_and_workers(
        &mut self,
        p: &PackedAnalysis,
        parent: &PackedAnalysis,
        cpu_mode: CpuMode,
        cpu_worker_limit: usize,
        algorithm: GpuAlgorithm,
        training_cpu_ms: &[f64],
        training_gpu_total_ms: &[f64],
        heldout_cpu_ms: &[f64],
        heldout_gpu_total_ms: &[f64],
    ) -> Result<(), String> {
        let row = RouteObservation {
            bucket: ShapeBucket::from_packed(p),
            context_bucket: ShapeBucket::from_packed(parent),
            cpu_mode,
            cpu_worker_limit,
            algorithm,
            training_cpu: CostInterval::new(training_cpu_ms)?,
            training_gpu: CostInterval::new(training_gpu_total_ms)?,
            heldout_cpu: CostInterval::new(heldout_cpu_ms)?,
            heldout_gpu: CostInterval::new(heldout_gpu_total_ms)?,
        };
        self.observations.retain(|old| {
            old.bucket != row.bucket
                || old.context_bucket != row.context_bucket
                || old.algorithm != algorithm
        });
        self.observations.push(row);
        Ok(())
    }
    pub fn plan(
        &self,
        p: &PackedAnalysis,
        hardware_identity: &str,
        objective: Objective,
    ) -> RoutePlan {
        let mut plan = RoutePlan {
            cpu_indices: p.functions.iter().map(|f| f.module_index).collect(),
            gpu_indices: Vec::new(),
            cpu_mode: CpuMode::Serial,
            cpu_worker_limit: None,
            algorithm: GpuAlgorithm::Dense,
            reason: String::new(),
            cpu_ms: None,
            gpu_ms: None,
        };
        if self.hardware_identity != hardware_identity {
            plan.reason = "CPU default: calibration hardware identity differs".into();
            return plan;
        }
        if self.objective != objective {
            plan.reason = "CPU default: calibration objective differs".into();
            return plan;
        }
        let complete_bucket = ShapeBucket::from_packed(p);
        if let Some(best_cpu) = self
            .observations
            .iter()
            .filter(|r| r.context_bucket == complete_bucket)
            .min_by(|a, b| a.heldout_cpu.median_ms.total_cmp(&b.heldout_cpu.median_ms))
        {
            plan.cpu_mode = best_cpu.cpu_mode;
            plan.cpu_worker_limit =
                (best_cpu.cpu_worker_limit > 0).then_some(best_cpu.cpu_worker_limit);
            plan.cpu_ms = Some(best_cpu.heldout_cpu.median_ms);
        }
        let mut groups: BTreeMap<ShapeBucket, Vec<&FunctionDesc>> = BTreeMap::new();
        let mut chain_count = 0;
        for f in &p.functions {
            if long_forward_chain(p, f) {
                chain_count += 1;
                continue;
            }
            let key = ShapeBucket::from_functions(p, std::iter::once(f)).function_key();
            groups.entry(key).or_default().push(f);
        }
        let mut candidates = Vec::new();
        for functions in groups.values() {
            let bucket = ShapeBucket::from_functions(p, functions.iter().copied());
            if let Some(row) = self
                .observations
                .iter()
                .filter(|r| {
                    r.bucket == bucket && r.context_bucket == complete_bucket && r.stable_win()
                })
                .min_by(|a, b| a.heldout_gpu.p90_ms.total_cmp(&b.heldout_gpu.p90_ms))
            {
                candidates.push((row, functions));
            }
        }
        // One GPU algorithm per submission. Keep groups calibrated for other
        // algorithms on CPU instead of inventing an unmeasured mixed cost.
        if let Some((winner, functions)) = candidates.iter().max_by(|(a, _), (b, _)| {
            (a.heldout_cpu.median_ms - a.heldout_gpu.median_ms)
                .total_cmp(&(b.heldout_cpu.median_ms - b.heldout_gpu.median_ms))
        }) {
            plan.algorithm = winner.algorithm;
            plan.cpu_mode = winner.cpu_mode;
            plan.cpu_worker_limit =
                (winner.cpu_worker_limit > 0).then_some(winner.cpu_worker_limit);
            // Admit one calibrated group. Combining independently measured
            // groups changes the unmeasured packing and overlap boundary.
            plan.gpu_indices
                .extend(functions.iter().map(|f| f.module_index));
            plan.cpu_ms = Some(winner.heldout_cpu.median_ms);
            plan.gpu_ms = Some(winner.heldout_gpu.median_ms);
            plan.cpu_indices
                .retain(|index| !plan.gpu_indices.contains(index));
            plan.reason=format!("{} GPU functions earned a >=10% separated training/heldout total elapsed win; {} structural long chains stay on CPU",plan.gpu_indices.len(),chain_count);
        } else {
            plan.reason=format!("CPU default: no calibrated shape bucket has a stable total elapsed GPU win; {chain_count} structural long chains stay on CPU");
        }
        plan
    }
    pub fn save(&self, path: &Path) -> Result<(), String> {
        fs::write(path, self.to_csv()).map_err(|e| format!("Cannot write route profile: {e}"))
    }
    pub fn load(path: &Path) -> Result<Self, String> {
        let data =
            fs::read_to_string(path).map_err(|e| format!("Cannot read route profile: {e}"))?;
        Self::from_csv(&data)
    }
    pub fn to_csv(&self) -> String {
        let identity = self
            .hardware_identity
            .as_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let mut output = format!("GLC_ROUTE3,{identity},{}\n", self.objective.name());
        for row in &self.observations {
            let fields = row
                .bucket
                .fields()
                .iter()
                .map(usize::to_string)
                .collect::<Vec<_>>()
                .join(",");
            let context_fields = row
                .context_bucket
                .fields()
                .iter()
                .map(usize::to_string)
                .collect::<Vec<_>>()
                .join(",");
            output.push_str(&format!(
                "{fields},{context_fields},{},{},{},",
                row.cpu_mode.name(),
                row.algorithm.name(),
                row.cpu_worker_limit
            ));
            let costs = [
                &row.training_cpu,
                &row.training_gpu,
                &row.heldout_cpu,
                &row.heldout_gpu,
            ];
            output.push_str(
                &costs
                    .iter()
                    .map(|c| format!("{},{},{},{}", c.p10_ms, c.median_ms, c.p90_ms, c.samples))
                    .collect::<Vec<_>>()
                    .join(","),
            );
            output.push('\n');
        }
        output
    }
    pub fn from_csv(data: &str) -> Result<Self, String> {
        if data.len() > 1_000_000 {
            return Err("Route profile exceeds size limit".into());
        }
        let mut lines = data.lines();
        let header = lines
            .next()
            .ok_or("Empty route profile")?
            .split(',')
            .collect::<Vec<_>>();
        if header.len() != 3
            || header[0] != "GLC_ROUTE3"
            || header[1].len() % 2 != 0
            || !header[1].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Invalid route profile header".into());
        }
        let bytes = (0..header[1].len())
            .step_by(2)
            .map(|index| {
                u8::from_str_radix(&header[1][index..index + 2], 16)
                    .map_err(|_| "Invalid routing hardware identity".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        let identity =
            String::from_utf8(bytes).map_err(|_| "Invalid routing hardware identity UTF-8")?;
        let mut profile = Self::new(identity, Objective::parse(header[2])?);
        for line in lines {
            let raw = line.split(',').collect::<Vec<_>>();
            if raw.len() != 35 {
                return Err("Invalid route profile row field count".into());
            }
            let shape = raw[..16]
                .iter()
                .map(|s| {
                    s.parse::<usize>()
                        .map_err(|_| "Invalid route shape".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            if shape.iter().any(|n| *n > usize::BITS as usize)
                || shape[4] > 3
                || shape[7] > 1
                || shape[12] > 3
                || shape[15] > 1
            {
                return Err("Route shape outside supported classes".into());
            }
            let cpu_mode = match raw[16] {
                "serial" => CpuMode::Serial,
                "function_pool" => CpuMode::Functions,
                "word_pool" => CpuMode::Words,
                _ => return Err("Unknown CPU route mode".into()),
            };
            let interval = |first: usize| -> Result<CostInterval, String> {
                let number = |index: usize| {
                    raw[index]
                        .parse::<f64>()
                        .map_err(|_| "Invalid routing elapsed cost".to_string())
                };
                let c = CostInterval {
                    p10_ms: number(first)?,
                    median_ms: number(first + 1)?,
                    p90_ms: number(first + 2)?,
                    samples: raw[first + 3]
                        .parse()
                        .map_err(|_| "Invalid routing sample count")?,
                };
                if !c.valid() {
                    return Err("Invalid routing elapsed interval".into());
                }
                Ok(c)
            };
            profile.observations.push(RouteObservation {
                bucket: ShapeBucket::from_fields(&shape),
                context_bucket: ShapeBucket::from_fields(&shape[8..]),
                cpu_mode,
                cpu_worker_limit: raw[18]
                    .parse::<usize>()
                    .map_err(|_| "Invalid CPU worker limit")?,
                algorithm: GpuAlgorithm::parse(raw[17])?,
                training_cpu: interval(19)?,
                training_gpu: interval(23)?,
                heldout_cpu: interval(27)?,
                heldout_gpu: interval(31)?,
            });
        }
        Ok(profile)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::prepare;
    use crate::ir::{BlockIR, FunctionIR, InstructionIR, ModuleIR};
    fn pack(count: usize, blocks: usize) -> PackedAnalysis {
        prepare(&ModuleIR {
            text: String::new(),
            preamble: String::new(),
            postamble: String::new(),
            functions: (0..count)
                .map(|index| FunctionIR {
                    name: format!("f{index}"),
                    header: String::new(),
                    footer: String::new(),
                    value_count: 1,
                    phi_edges: Vec::new(),
                    blocks: (0..blocks)
                        .map(|b| BlockIR {
                            name: format!("b{b}"),
                            successors: if b + 1 < blocks {
                                vec![b + 1]
                            } else {
                                Vec::new()
                            },
                            instructions: vec![InstructionIR {
                                text: String::new(),
                                definition: None,
                                uses: vec![0],
                                pure: false,
                                is_phi: false,
                            }],
                        })
                        .collect(),
                })
                .collect(),
        })
        .unwrap()
    }
    #[test]
    fn routing_defaults_to_cpu_for_missing_unstable_and_wrong_hardware_evidence() {
        let packed = pack(32, 2);
        let mut profile = RouteProfile::new("test-GPU|driver|CPU".into(), Objective::Latency);
        assert!(profile
            .plan(&packed, "test-GPU|driver|CPU", Objective::Latency)
            .gpu_indices
            .is_empty());
        profile
            .record(
                &packed,
                CpuMode::Functions,
                GpuAlgorithm::Dense,
                &[1.0; 5],
                &[0.95; 5],
                &[1.0; 5],
                &[0.95; 5],
            )
            .unwrap();
        assert!(profile
            .plan(&packed, "test-GPU|driver|CPU", Objective::Latency)
            .gpu_indices
            .is_empty());
        profile
            .record(
                &packed,
                CpuMode::Functions,
                GpuAlgorithm::Dense,
                &[1.0; 5],
                &[0.5; 5],
                &[1.0; 5],
                &[0.5; 5],
            )
            .unwrap();
        assert_eq!(
            profile
                .plan(&packed, "test-GPU|driver|CPU", Objective::Latency)
                .gpu_indices
                .len(),
            32
        );
        assert!(profile
            .plan(&packed, "another-GPU", Objective::Latency)
            .gpu_indices
            .is_empty());
        assert!(profile
            .plan(&packed, "test-GPU|driver|CPU", Objective::Throughput)
            .gpu_indices
            .is_empty());
        assert!(profile
            .plan(&pack(1, 2), "test-GPU|driver|CPU", Objective::Latency)
            .gpu_indices
            .is_empty());
    }
    #[test]
    fn heldout_loss_prevents_training_only_win_and_profile_roundtrip_is_strict() {
        let packed = pack(16, 2);
        let mut p = RouteProfile::new("gpu,uuid\nCPU".into(), Objective::Throughput);
        p.record(
            &packed,
            CpuMode::Words,
            GpuAlgorithm::Sparse,
            &[1.0; 5],
            &[0.5; 5],
            &[1.0; 5],
            &[1.1; 5],
        )
        .unwrap();
        assert!(p
            .plan(&packed, &p.hardware_identity, Objective::Throughput)
            .gpu_indices
            .is_empty());
        let copy = RouteProfile::from_csv(&p.to_csv()).unwrap();
        assert_eq!(copy.hardware_identity, p.hardware_identity);
        assert_eq!(copy.observations.len(), 1);
        assert!(RouteProfile::from_csv(&p.to_csv().replace("0.5", "NaN")).is_err());
        assert!(RouteProfile::from_csv("GLC_ROUTE3,zz,latency\n").is_err());
        assert!(RouteProfile::from_csv("GLC_ROUTE3,aé0,latency\n").is_err());
        assert!(p
            .record(
                &packed,
                CpuMode::Serial,
                GpuAlgorithm::Dense,
                &[1.0; 4],
                &[0.5; 5],
                &[1.0; 5],
                &[0.5; 5]
            )
            .is_err());
    }
    #[test]
    fn earned_compact_batch_can_overlap_long_cpu_chains() {
        let compact = pack(32, 2);
        let chain = pack(1, 257);
        let mut m = ModuleIR {
            text: String::new(),
            preamble: String::new(),
            postamble: String::new(),
            functions: Vec::new(),
        };
        // Use the frontend fixture builder rather than stitching invalid CSR.
        for index in 0..33 {
            let blocks = if index == 32 { 257 } else { 2 };
            m.functions.push(FunctionIR {
                name: format!("f{index}"),
                header: String::new(),
                footer: String::new(),
                value_count: 1,
                phi_edges: Vec::new(),
                blocks: (0..blocks)
                    .map(|b| BlockIR {
                        name: format!("b{b}"),
                        successors: if b + 1 < blocks {
                            vec![b + 1]
                        } else {
                            Vec::new()
                        },
                        instructions: vec![InstructionIR {
                            text: String::new(),
                            definition: None,
                            uses: vec![0],
                            pure: false,
                            is_phi: false,
                        }],
                    })
                    .collect(),
            });
        }
        let mixed = prepare(&m).unwrap();
        let mut p = RouteProfile::new("same-device".into(), Objective::Latency);
        p.record_with_context(
            &compact,
            &mixed,
            CpuMode::Functions,
            GpuAlgorithm::Dense,
            &[1.0; 5],
            &[0.5; 5],
            &[1.0; 5],
            &[0.5; 5],
        )
        .unwrap();
        p.record(
            &chain,
            CpuMode::Functions,
            GpuAlgorithm::Dense,
            &[10.0; 5],
            &[0.1; 5],
            &[10.0; 5],
            &[0.1; 5],
        )
        .unwrap();
        let plan = p.plan(&mixed, "same-device", Objective::Latency);
        assert_eq!(plan.gpu_indices, (0..32).collect::<Vec<_>>());
        assert_eq!(plan.cpu_indices, vec![32]);
        let other_parent = pack(33, 2);
        assert!(p
            .plan(&other_parent, "same-device", Objective::Latency)
            .gpu_indices
            .is_empty());
    }
}
