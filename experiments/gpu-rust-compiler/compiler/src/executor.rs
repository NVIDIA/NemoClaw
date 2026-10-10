// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Persistent CPU workers for the existing sparse bitset worklist.
//! Inputs are immutable Arc snapshots. Every submission allocates zeroed facts;
//! buffer/thread reuse never carries liveness across changing source programs.

use crate::analysis::{solve_cpu_serial, solve_words, PackedAnalysis};
use std::{
    collections::{HashMap, HashSet},
    ops::Range,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc,
    },
    thread::{self, JoinHandle},
    time::Instant,
};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum CpuMode {
    Serial,
    Functions,
    Words,
}

impl CpuMode {
    pub const ALL: [Self; 3] = [Self::Serial, Self::Functions, Self::Words];
    pub fn name(self) -> &'static str {
        match self {
            Self::Serial => "serial",
            Self::Functions => "function_pool",
            Self::Words => "word_pool",
        }
    }
}

#[derive(Clone, Debug)]
pub struct CpuTiming {
    pub mode: CpuMode,
    pub workers: usize,
    pub samples_ms: Vec<f64>,
    pub median_ms: f64,
    pub p90_ms: f64,
}

#[derive(Clone, Debug)]
pub struct CpuCalibration {
    pub selected_mode: CpuMode,
    pub selected_workers: usize,
    pub variants: Vec<CpuTiming>,
    pub repeats: usize,
}

/// Indexed view of an already prepared pack; no CFG or GEN/DEF reconstruction.
#[derive(Clone, Debug)]
pub struct AnalysisSelection {
    pub module_indices: Vec<usize>,
    pub functions: Vec<usize>,
    pub row_ranges: Vec<Range<usize>>,
    pub total_cells: usize,
}

impl AnalysisSelection {
    pub fn new(packed: &PackedAnalysis, module_indices: &[usize]) -> Result<Self, String> {
        let mut seen = HashSet::new();
        let mut selection = Self {
            module_indices: module_indices.to_vec(),
            functions: Vec::new(),
            row_ranges: Vec::new(),
            total_cells: 0,
        };
        for &module_index in module_indices {
            if !seen.insert(module_index) {
                return Err("Duplicate selected module function".into());
            }
            let index = packed
                .functions
                .get(module_index)
                .filter(|f| f.module_index == module_index)
                .map(|_| module_index)
                .or_else(|| {
                    packed
                        .functions
                        .iter()
                        .position(|f| f.module_index == module_index)
                })
                .ok_or_else(|| format!("Selected module function {module_index} is absent"))?;
            let f = &packed.functions[index];
            let count = f.block_count * f.words;
            selection.functions.push(index);
            selection.row_ranges.push(f.row_base..f.row_base + count);
            selection.total_cells += count;
        }
        Ok(selection)
    }

    fn complete(packed: &PackedAnalysis) -> Self {
        Self {
            module_indices: packed.functions.iter().map(|f| f.module_index).collect(),
            functions: (0..packed.functions.len()).collect(),
            row_ranges: packed
                .functions
                .iter()
                .map(|f| f.row_base..f.row_base + f.block_count * f.words)
                .collect(),
            total_cells: packed.total_cells,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SubsetSolution {
    pub values: Vec<u32>,
    pub row_ranges: Vec<Range<usize>>,
}

impl SubsetSolution {
    pub fn scatter_into(&self, output: &mut [u32]) -> Result<(), String> {
        let mut source = 0;
        for range in &self.row_ranges {
            if range.end > output.len() || range.end < range.start {
                return Err("Subset scatter destination dimensions differ".into());
            }
            let end = source + range.len();
            if end > self.values.len() {
                return Err("Subset scatter source dimensions differ".into());
            }
            output[range.clone()].copy_from_slice(&self.values[source..end]);
            source = end;
        }
        if source != self.values.len() {
            return Err("Subset scatter has trailing facts".into());
        }
        Ok(())
    }
}

#[derive(Clone)]
struct Task {
    function: usize,
    first_word: usize,
    words: usize,
    output_base: usize,
}
struct Job {
    packed: Arc<PackedAnalysis>,
    tasks: Vec<Vec<Task>>,
    next: AtomicUsize,
}
enum Command {
    Solve(Arc<Job>),
    Stop,
}
type WorkerOutput = Vec<(Task, Vec<u32>)>;

/// Creation and destruction are outside warm solve timings. Scheduling, fresh
/// scratch/output allocation and result assembly remain inside every solve.
pub struct CpuExecutor {
    workers: Vec<(mpsc::Sender<Command>, JoinHandle<()>)>,
    completed: mpsc::Receiver<WorkerOutput>,
    selected: HashMap<[usize; 5], CpuMode>,
    worker_limits: HashMap<([usize; 5], CpuMode), usize>,
    jobs_completed: usize,
    pool_submissions: usize,
    initialization_ms: f64,
}

impl CpuExecutor {
    pub fn new(max_workers: usize) -> Self {
        let initialization = Instant::now();
        let available = thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1);
        let count = if max_workers == 0 {
            available
        } else {
            available.min(max_workers)
        }
        .max(1);
        let (completed_tx, completed) = mpsc::channel();
        let workers = (0..count)
            .map(|_| {
                let (sender, receiver) = mpsc::channel();
                let completed = completed_tx.clone();
                let handle = thread::spawn(move || {
                    while let Ok(Command::Solve(job)) = receiver.recv() {
                        let mut output = Vec::new();
                        loop {
                            let task = job.next.fetch_add(1, Ordering::Relaxed);
                            let Some(batch) = job.tasks.get(task) else {
                                break;
                            };
                            for task in batch {
                                let f = &job.packed.functions[task.function];
                                output.push((
                                    task.clone(),
                                    solve_words(
                                        &job.packed,
                                        f,
                                        task.first_word..task.first_word + task.words,
                                    ),
                                ));
                            }
                        }
                        if completed.send(output).is_err() {
                            break;
                        }
                    }
                });
                (sender, handle)
            })
            .collect();
        Self {
            workers,
            completed,
            selected: HashMap::new(),
            worker_limits: HashMap::new(),
            jobs_completed: 0,
            pool_submissions: 0,
            initialization_ms: initialization.elapsed().as_secs_f64() * 1000.0,
        }
    }

    pub fn worker_count(&self) -> usize {
        self.workers.len()
    }
    pub fn jobs_completed(&self) -> usize {
        self.jobs_completed
    }
    pub fn workers(&self) -> usize {
        self.worker_count()
    }
    pub fn requests(&self) -> usize {
        self.jobs_completed()
    }
    pub fn pool_reused(&self) -> bool {
        self.pool_submissions > 1
    }
    pub fn pool_submissions(&self) -> usize {
        self.pool_submissions
    }
    pub fn initialization_ms(&self) -> f64 {
        self.initialization_ms
    }

    fn key(packed: &PackedAnalysis) -> [usize; 5] {
        [
            packed.functions.len(),
            packed.block_count(),
            packed.total_cells,
            packed.max_blocks(),
            packed.functions.iter().map(|f| f.words).max().unwrap_or(0),
        ]
    }

    /// Default to serial until CPU modes have been explicitly calibrated. A
    /// resident pool is not an excuse to slow down tiny analyses with dispatch.
    pub fn solve(&mut self, packed: Arc<PackedAnalysis>) -> Vec<u32> {
        let mode = self
            .selected
            .get(&Self::key(&packed))
            .copied()
            .unwrap_or(CpuMode::Serial);
        self.solve_mode(packed, mode)
    }

    pub fn solve_mode(&mut self, packed: Arc<PackedAnalysis>, mode: CpuMode) -> Vec<u32> {
        let workers = self.worker_limit(&packed, mode);
        self.solve_mode_with_workers(packed, mode, workers)
    }

    pub fn worker_limit(&self, packed: &PackedAnalysis, mode: CpuMode) -> usize {
        if mode == CpuMode::Serial {
            1
        } else {
            self.worker_limits
                .get(&(Self::key(packed), mode))
                .copied()
                .unwrap_or(self.workers.len())
        }
    }

    pub fn set_worker_limit(
        &mut self,
        packed: &PackedAnalysis,
        mode: CpuMode,
        workers: usize,
    ) -> Result<(), String> {
        if workers == 0 || workers > self.workers.len() {
            return Err("CPU worker limit exceeds resident pool capacity".into());
        }
        self.worker_limits
            .insert((Self::key(packed), mode), workers);
        Ok(())
    }

    pub fn solve_mode_with_workers(
        &mut self,
        packed: Arc<PackedAnalysis>,
        mode: CpuMode,
        workers: usize,
    ) -> Vec<u32> {
        if mode == CpuMode::Serial || workers <= 1 {
            // Retain the exact optimized serial baseline, without adding
            // indexed selection/task assembly overhead to a whole-pack solve.
            self.jobs_completed += 1;
            return solve_cpu_serial(&packed);
        }
        let selection = AnalysisSelection::complete(&packed);
        self.solve_selection_with_workers(packed, &selection, mode, workers)
            .values
    }

    pub fn solve_selection(
        &mut self,
        packed: Arc<PackedAnalysis>,
        selection: &AnalysisSelection,
        mode: CpuMode,
    ) -> SubsetSolution {
        let workers = self.worker_limit(&packed, mode);
        self.solve_selection_with_workers(packed, selection, mode, workers)
    }

    pub fn solve_selection_with_workers(
        &mut self,
        packed: Arc<PackedAnalysis>,
        selection: &AnalysisSelection,
        mode: CpuMode,
        workers: usize,
    ) -> SubsetSolution {
        let workers = workers.clamp(1, self.workers.len());
        if mode == CpuMode::Serial || workers == 1 {
            let mut values = vec![0; selection.total_cells];
            let mut row = 0;
            for &index in &selection.functions {
                let f = &packed.functions[index];
                let solution = solve_words(&packed, f, 0..f.words);
                values[row..row + solution.len()].copy_from_slice(&solution);
                row += solution.len();
            }
            self.jobs_completed += 1;
            return SubsetSolution {
                values,
                row_ranges: selection.row_ranges.clone(),
            };
        }
        let mut tasks = Vec::new();
        let mut output_base = 0;
        for &index in &selection.functions {
            let f = &packed.functions[index];
            let width = if mode == CpuMode::Words { 4 } else { f.words };
            for first_word in (0..f.words).step_by(width) {
                tasks.push(Task {
                    function: index,
                    first_word,
                    words: width.min(f.words - first_word),
                    output_base,
                });
            }
            output_base += f.block_count * f.words;
        }
        let mut result = vec![0; selection.total_cells];
        if tasks.len() <= 1 {
            for task in tasks {
                let f = &packed.functions[task.function];
                let values = solve_words(&packed, f, task.first_word..task.first_word + task.words);
                assemble(&mut result, f.words, f.block_count, &task, &values);
            }
        } else {
            // Amortize one atomic dequeue over several small functions while
            // preserving dynamic balance for a few wide/long functions.
            self.pool_submissions += 1;
            let active_workers = workers.min(tasks.len());
            let batch_size = tasks.len().div_ceil(active_workers * 4).max(1);
            let batches = tasks
                .chunks(batch_size)
                .map(|batch| batch.to_vec())
                .collect();
            let job = Arc::new(Job {
                packed,
                tasks: batches,
                next: AtomicUsize::new(0),
            });
            for (sender, _) in self.workers.iter().take(active_workers) {
                sender
                    .send(Command::Solve(Arc::clone(&job)))
                    .expect("CPU worker stopped");
            }
            for _ in 0..active_workers {
                for (task, values) in self.completed.recv().expect("CPU worker did not complete") {
                    let f = &job.packed.functions[task.function];
                    assemble(&mut result, f.words, f.block_count, &task, &values);
                }
            }
        }
        self.jobs_completed += 1;
        SubsetSolution {
            values: result,
            row_ranges: selection.row_ranges.clone(),
        }
    }

    /// Calibration runs each mode interleaved and retains all timings. The
    /// selected mode minimizes median elapsed cost, including pool dispatch.
    pub fn calibrate(
        &mut self,
        packed: Arc<PackedAnalysis>,
        repeats: usize,
    ) -> Result<CpuCalibration, String> {
        if !(3..=10_000).contains(&repeats) {
            return Err("CPU calibration requires 3..=10000 samples".into());
        }
        let reference = self.solve_mode(Arc::clone(&packed), CpuMode::Serial);
        let mut candidates = vec![(CpuMode::Serial, 1)];
        for mode in [CpuMode::Functions, CpuMode::Words] {
            let tasks = if mode == CpuMode::Functions {
                packed.functions.len()
            } else {
                packed.functions.iter().map(|f| f.words.div_ceil(4)).sum()
            };
            let max_workers = self.workers.len().min(tasks).max(1);
            let mut limits = Vec::new();
            let mut count = 2;
            while count < max_workers {
                limits.push(count);
                count *= 2;
            }
            limits.push(max_workers);
            candidates.extend(limits.into_iter().map(|workers| (mode, workers)));
        }
        let mut samples = vec![Vec::new(); candidates.len()];
        for iteration in 0..repeats {
            for offset in 0..candidates.len() {
                let index = (iteration + offset) % candidates.len();
                let start = Instant::now();
                let actual = self.solve_mode_with_workers(
                    Arc::clone(&packed),
                    candidates[index].0,
                    candidates[index].1,
                );
                samples[index].push(start.elapsed().as_secs_f64() * 1000.0);
                if actual != reference {
                    return Err("Persistent CPU modes disagree".into());
                }
            }
        }
        let variants: Vec<_> = samples
            .into_iter()
            .enumerate()
            .map(|(index, samples_ms)| {
                let mut sorted = samples_ms.clone();
                sorted.sort_unstable_by(f64::total_cmp);
                let median_ms = percentile(&sorted, 0.5);
                let p90_ms = percentile(&sorted, 0.9);
                CpuTiming {
                    mode: candidates[index].0,
                    workers: candidates[index].1,
                    samples_ms,
                    median_ms,
                    p90_ms,
                }
            })
            .collect();
        for mode in CpuMode::ALL {
            let best = variants
                .iter()
                .filter(|v| v.mode == mode)
                .min_by(|a, b| a.median_ms.total_cmp(&b.median_ms))
                .unwrap();
            self.worker_limits
                .insert((Self::key(&packed), mode), best.workers);
        }
        let best = variants
            .iter()
            .min_by(|a, b| a.median_ms.total_cmp(&b.median_ms))
            .unwrap();
        let selected_mode = best.mode;
        let selected_workers = best.workers;
        self.selected.insert(Self::key(&packed), selected_mode);
        Ok(CpuCalibration {
            selected_mode,
            selected_workers,
            variants,
            repeats,
        })
    }
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    let position = (sorted.len() - 1) as f64 * fraction;
    let first = position.floor() as usize;
    let last = position.ceil() as usize;
    sorted[first] + (sorted[last] - sorted[first]) * (position - first as f64)
}

fn assemble(result: &mut [u32], width: usize, blocks: usize, task: &Task, values: &[u32]) {
    if task.first_word == 0 && task.words == width {
        result[task.output_base..task.output_base + values.len()].copy_from_slice(values);
    } else {
        for block in 0..blocks {
            let target = task.output_base + block * width + task.first_word;
            result[target..target + task.words]
                .copy_from_slice(&values[block * task.words..(block + 1) * task.words]);
        }
    }
}

impl Drop for CpuExecutor {
    fn drop(&mut self) {
        for (sender, _) in &self.workers {
            let _ = sender.send(Command::Stop);
        }
        for (_, handle) in self.workers.drain(..) {
            let _ = handle.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::{solve_cpu_serial, FunctionDesc, GPUGroup};
    fn pack(functions: usize, blocks: usize, words: usize, seed: u32) -> Arc<PackedAnalysis> {
        let cells = functions * blocks * words;
        let mut p = PackedAnalysis {
            functions: Vec::new(),
            groups: Vec::new(),
            successor_offsets: vec![0],
            successors: Vec::new(),
            predecessor_offsets: vec![0],
            predecessors: Vec::new(),
            row_offsets: Vec::new(),
            uses: vec![0; cells],
            defs: vec![0; cells],
            phi_out: vec![0; cells],
            total_cells: cells,
        };
        for f in 0..functions {
            p.functions.push(FunctionDesc {
                module_index: f * 2,
                block_base: f * blocks,
                block_count: blocks,
                row_base: f * blocks * words,
                words,
                value_count: words * 32,
            });
            for word in 0..words {
                p.groups.push(GPUGroup {
                    block_base: (f * blocks) as u32,
                    block_count: blocks as u32,
                    row_base: (f * blocks * words) as u32,
                    words: words as u32,
                    word: word as u32,
                });
            }
            for b in 0..blocks {
                p.row_offsets.push((f * blocks + b) * words);
                if b + 1 < blocks {
                    p.successors.push((f * blocks + b + 1) as u32);
                }
                p.successor_offsets.push(p.successors.len() as u32);
                if b > 0 {
                    p.predecessors.push((f * blocks + b - 1) as u32);
                }
                p.predecessor_offsets.push(p.predecessors.len() as u32);
                for w in 0..words {
                    p.uses[((f * blocks + b) * words) + w] =
                        seed.rotate_left(((f + b + w) % 32) as u32);
                }
            }
        }
        p.row_offsets.push(cells);
        Arc::new(p)
    }

    #[test]
    fn persistent_pool_matches_sparse_oracle_for_changing_and_resized_programs() {
        let mut executor = CpuExecutor::new(4);
        let workers = executor.worker_count();
        for input in [
            pack(37, 9, 7, 1),
            pack(4, 257, 17, 2),
            pack(37, 9, 7, 0),
            pack(2, 3, 1, 8),
            pack(0, 0, 0, 0),
        ] {
            let expected = solve_cpu_serial(&input);
            for mode in CpuMode::ALL {
                assert_eq!(executor.solve_mode(Arc::clone(&input), mode), expected);
            }
            assert_eq!(executor.worker_count(), workers);
        }
        assert_eq!(executor.jobs_completed(), 15);
        if workers > 1 {
            assert!(executor.pool_reused());
            assert!(executor.pool_submissions() > 1);
        }
    }

    #[test]
    fn indexed_subset_preserves_module_ids_and_scatter_does_not_overwrite_neighbors() {
        let input = pack(5, 7, 11, 7);
        let selection = AnalysisSelection::new(&input, &[8, 2]).unwrap();
        assert_eq!(selection.functions, vec![4, 1]);
        let mut executor = CpuExecutor::new(3);
        let expected = solve_cpu_serial(&input);
        for mode in CpuMode::ALL {
            let subset = executor.solve_selection(Arc::clone(&input), &selection, mode);
            let mut output = vec![u32::MAX; input.total_cells];
            subset.scatter_into(&mut output).unwrap();
            for f in &input.functions {
                let range = f.row_base..f.row_base + f.block_count * f.words;
                if selection.module_indices.contains(&f.module_index) {
                    assert_eq!(output[range.clone()], expected[range]);
                } else {
                    assert!(output[range].iter().all(|v| *v == u32::MAX));
                }
            }
        }
        assert!(AnalysisSelection::new(&input, &[2, 2]).is_err());
        assert!(AnalysisSelection::new(&input, &[1]).is_err());
        let subset = crate::analysis::select_packed(&input, &[8, 2]).unwrap();
        assert_eq!(
            subset
                .functions
                .iter()
                .map(|f| f.module_index)
                .collect::<Vec<_>>(),
            vec![8, 2]
        );
        assert_eq!(
            solve_cpu_serial(&subset),
            executor
                .solve_selection(Arc::clone(&input), &selection, CpuMode::Serial)
                .values
        );
        let mut merged = vec![u32::MAX; input.total_cells];
        crate::analysis::scatter(&subset, &solve_cpu_serial(&subset), &input, &mut merged).unwrap();
        for range in &selection.row_ranges {
            assert_eq!(merged[range.clone()], expected[range.clone()]);
        }
        assert!(crate::analysis::select_packed(&input, &[8, 8]).is_err());
        assert!(crate::analysis::select_packed(&input, &[1]).is_err());
        assert_eq!(
            crate::analysis::select_packed(&input, &[])
                .unwrap()
                .total_cells,
            0
        );
    }

    #[test]
    fn measured_cpu_calibration_records_all_modes_and_reuses_pool() {
        let input = pack(40, 7, 5, 3);
        let mut executor = CpuExecutor::new(3);
        assert!(executor.calibrate(Arc::clone(&input), 2).is_err());
        let calibration = executor.calibrate(Arc::clone(&input), 3).unwrap();
        assert!(calibration.variants.len() >= 3);
        assert!(calibration.variants.iter().all(|v| v.samples_ms.len() == 3));
        assert_eq!(executor.solve(Arc::clone(&input)), solve_cpu_serial(&input));
        assert_eq!(
            executor.jobs_completed(),
            calibration.variants.len() * 3 + 2
        );
        assert_eq!(
            executor.worker_limit(&input, calibration.selected_mode),
            calibration.selected_workers
        );
        assert!(executor
            .set_worker_limit(&input, CpuMode::Functions, 0)
            .is_err());
        assert!(executor
            .set_worker_limit(&input, CpuMode::Functions, executor.worker_count() + 1)
            .is_err());
    }
}
