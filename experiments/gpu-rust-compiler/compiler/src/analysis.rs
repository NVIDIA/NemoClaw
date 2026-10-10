// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Native, packed block liveness and conservative scalar dead-code pruning.
//!
//! The frontend supplies value IDs and CFG edges directly. No textual LLVM
//! parsing, subprocess, or JSON round trip participates in this pass.

use crate::ir::ModuleIR;
use std::{
    collections::HashSet,
    ops::Range,
    sync::atomic::{AtomicUsize, Ordering},
};

const MAX_CELLS: usize = 100_000_000;
const MAX_VALUES: usize = 1_000_000;

/// This layout is the five `uint` fields consumed by `liveness.metal`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct GPUGroup {
    pub block_base: u32,
    pub block_count: u32,
    pub row_base: u32,
    pub words: u32,
    pub word: u32,
}

#[derive(Clone, Debug)]
pub struct FunctionDesc {
    /// Index in the original ModuleIR, also retained by subset packing.
    pub module_index: usize,
    pub block_base: usize,
    pub block_count: usize,
    pub row_base: usize,
    pub words: usize,
    pub value_count: usize,
}

#[derive(Clone, Debug)]
pub struct PackedAnalysis {
    pub functions: Vec<FunctionDesc>,
    pub groups: Vec<GPUGroup>,
    /// CSR edges use global packed block indices.
    pub successor_offsets: Vec<u32>,
    pub successors: Vec<u32>,
    pub predecessor_offsets: Vec<u32>,
    pub predecessors: Vec<u32>,
    /// One offset per block, followed by the total cell count.
    pub row_offsets: Vec<usize>,
    pub uses: Vec<u32>,
    pub defs: Vec<u32>,
    /// Phi incoming values are live out of their predecessor, not live in
    /// to the phi's block. The predecessor DEF is applied by the solver.
    pub phi_out: Vec<u32>,
    pub total_cells: usize,
}

impl PackedAnalysis {
    pub fn block_count(&self) -> usize {
        self.row_offsets.len() - 1
    }

    pub fn max_blocks(&self) -> usize {
        self.functions
            .iter()
            .map(|f| f.block_count)
            .max()
            .unwrap_or(0)
    }

    fn successor_range(&self, block: usize) -> Range<usize> {
        self.successor_offsets[block] as usize..self.successor_offsets[block + 1] as usize
    }

    fn predecessor_range(&self, block: usize) -> Range<usize> {
        self.predecessor_offsets[block] as usize..self.predecessor_offsets[block + 1] as usize
    }
}

pub fn prepare(module: &ModuleIR) -> Result<PackedAnalysis, String> {
    prepare_subset(module, &(0..module.functions.len()).collect::<Vec<_>>())
}

/// Subset packing preserves original function IDs so CPU and GPU results can
/// be scattered back into one complete solution without examining LLVM text.
pub fn prepare_subset(module: &ModuleIR, indices: &[usize]) -> Result<PackedAnalysis, String> {
    let mut packed = PackedAnalysis {
        functions: Vec::with_capacity(indices.len()),
        groups: Vec::new(),
        successor_offsets: vec![0],
        successors: Vec::new(),
        predecessor_offsets: vec![0],
        predecessors: Vec::new(),
        row_offsets: Vec::new(),
        uses: Vec::new(),
        defs: Vec::new(),
        phi_out: Vec::new(),
        total_cells: 0,
    };
    let mut selected = HashSet::new();
    let mut predecessors: Vec<Vec<u32>> = Vec::new();
    for &module_index in indices {
        if !selected.insert(module_index) {
            return Err("Duplicate subset function index".into());
        }
        let function = module
            .functions
            .get(module_index)
            .ok_or_else(|| format!("Invalid subset function index {module_index}"))?;
        let blocks = function.blocks.len();
        if blocks == 0 || function.value_count >= MAX_VALUES {
            return Err(format!("Invalid analysis dimensions in {}", function.name));
        }
        let words = function.value_count.div_ceil(32).max(1);
        let cells = blocks
            .checked_mul(words)
            .ok_or("Analysis dimensions overflow")?;
        if cells > MAX_CELLS - packed.uses.len() {
            return Err("Workload exceeds 100 million bitset words".into());
        }
        let base = predecessors.len();
        let end = base
            .checked_add(blocks)
            .ok_or("Block dimensions overflow")?;
        if end > u32::MAX as usize {
            return Err("Too many CFG blocks".into());
        }
        let row_base = packed.uses.len();
        predecessors.resize_with(end, Vec::new);
        packed.functions.push(FunctionDesc {
            module_index,
            block_base: base,
            block_count: blocks,
            row_base,
            words,
            value_count: function.value_count,
        });
        for word in 0..words {
            packed.groups.push(GPUGroup {
                block_base: base as u32,
                block_count: blocks as u32,
                row_base: row_base as u32,
                words: words as u32,
                word: word as u32,
            });
        }
        for (block_index, block) in function.blocks.iter().enumerate() {
            packed.row_offsets.push(packed.uses.len());
            let mut local_uses = vec![0u32; words];
            let mut local_defs = vec![0u32; words];
            for instruction in &block.instructions {
                if !instruction.is_phi {
                    for &value in &instruction.uses {
                        validate_value(value, function.value_count, &function.name)?;
                        let (word, mask) = bit(value);
                        // Only uses before a same-block definition contribute
                        // to block GEN. All phi operands live on CFG edges.
                        local_uses[word] |= mask & !local_defs[word];
                    }
                }
                if let Some(value) = instruction.definition {
                    validate_value(value, function.value_count, &function.name)?;
                    let (word, mask) = bit(value);
                    local_defs[word] |= mask;
                }
            }
            packed.uses.extend(local_uses);
            packed.defs.extend(local_defs);
            packed.phi_out.resize(packed.uses.len(), 0);
            for &target in &block.successors {
                if target >= blocks {
                    return Err(format!("Invalid CFG target in {}", function.name));
                }
                if packed.successors.len() == u32::MAX as usize {
                    return Err("Too many CFG edges".into());
                }
                packed.successors.push((base + target) as u32);
                predecessors[base + target].push((base + block_index) as u32);
            }
            packed
                .successor_offsets
                .push(packed.successors.len() as u32);
        }
        for edge in &function.phi_edges {
            if edge.from >= blocks
                || edge.to >= blocks
                || !function.blocks[edge.from].successors.contains(&edge.to)
            {
                return Err(format!("Invalid phi edge in {}", function.name));
            }
            let row = row_base + edge.from * words;
            for &value in &edge.values {
                validate_value(value, function.value_count, &function.name)?;
                let (word, mask) = bit(value);
                packed.phi_out[row + word] |= mask;
            }
        }
    }
    for incoming in predecessors {
        if incoming.len() > u32::MAX as usize - packed.predecessors.len() {
            return Err("Too many predecessor edges".into());
        }
        packed.predecessors.extend(incoming);
        packed
            .predecessor_offsets
            .push(packed.predecessors.len() as u32);
    }
    packed.total_cells = packed.uses.len();
    packed.row_offsets.push(packed.total_cells);
    Ok(packed)
}

fn validate_value(value: usize, count: usize, name: &str) -> Result<(), String> {
    if value < count {
        Ok(())
    } else {
        Err(format!("Invalid SSA value {value} in {name}"))
    }
}

fn bit(value: usize) -> (usize, u32) {
    (value / 32, 1u32 << (value % 32))
}

pub fn solve_cpu_serial(packed: &PackedAnalysis) -> Vec<u32> {
    let mut result = vec![0; packed.total_cells];
    for function in &packed.functions {
        let solution = solve_words(packed, function, 0..function.words);
        let end = function.row_base + solution.len();
        result[function.row_base..end].copy_from_slice(&solution);
    }
    result
}

/// Adaptively avoid starting worker threads for small compiler inputs.
pub fn solve_cpu(packed: &PackedAnalysis) -> Vec<u32> {
    if packed.functions.len() < 16 && packed.total_cells < 4_096 {
        solve_cpu_serial(packed)
    } else {
        solve_cpu_parallel(packed)
    }
}

/// Functions are independent. Workers share immutable CSR input and write
/// disjoint contiguous output slices; each worker solves many functions.
pub fn solve_cpu_parallel(packed: &PackedAnalysis) -> Vec<u32> {
    let workers = worker_count(packed.functions.len());
    if workers <= 1 {
        return solve_cpu_serial(packed);
    }
    let mut result = vec![0; packed.total_cells];
    let per_worker = packed.functions.len().div_ceil(workers);
    std::thread::scope(|scope| {
        let mut remainder = result.as_mut_slice();
        for functions in packed.functions.chunks(per_worker) {
            let start = functions[0].row_base;
            let last = functions.last().unwrap();
            let end = last.row_base + last.block_count * last.words;
            let (destination, rest) = remainder.split_at_mut(end - start);
            remainder = rest;
            scope.spawn(move || {
                for function in functions {
                    let solution = solve_words(packed, function, 0..function.words);
                    let local = function.row_base - start;
                    destination[local..local + solution.len()].copy_from_slice(&solution);
                }
            });
        }
    });
    result
}

/// Four-word chunks expose parallelism in a workload with only a few wide
/// functions. All scheduling, temporary output and scatter costs are included.
pub fn solve_cpu_word_parallel(packed: &PackedAnalysis) -> Vec<u32> {
    let mut tasks = Vec::new();
    for (index, function) in packed.functions.iter().enumerate() {
        for first in (0..function.words).step_by(4) {
            tasks.push((index, first..(first + 4).min(function.words)));
        }
    }
    let workers = worker_count(tasks.len());
    if workers <= 1 {
        return solve_cpu_serial(packed);
    }
    let next = AtomicUsize::new(0);
    let chunks = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..workers)
            .map(|_| {
                let tasks = &tasks;
                let next = &next;
                scope.spawn(move || {
                    let mut output = Vec::new();
                    loop {
                        let task = next.fetch_add(1, Ordering::Relaxed);
                        if task >= tasks.len() {
                            break;
                        }
                        let (function, words) = &tasks[task];
                        output.push((
                            task,
                            solve_words(packed, &packed.functions[*function], words.clone()),
                        ));
                    }
                    output
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().expect("CPU liveness worker panicked"))
            .collect::<Vec<_>>()
    });
    let mut result = vec![0; packed.total_cells];
    for worker in chunks {
        for (task, solution) in worker {
            let (function, words) = &tasks[task];
            let function = &packed.functions[*function];
            let width = words.len();
            for block in 0..function.block_count {
                let destination = function.row_base + block * function.words + words.start;
                result[destination..destination + width]
                    .copy_from_slice(&solution[block * width..(block + 1) * width]);
            }
        }
    }
    result
}

fn worker_count(tasks: usize) -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(tasks)
}

fn solve_words(packed: &PackedAnalysis, function: &FunctionDesc, range: Range<usize>) -> Vec<u32> {
    let blocks = function.block_count;
    let words = range.len();
    let mut live = vec![0u32; blocks * words];
    let mut scratch = vec![0u32; words];
    // A circular queue holds each block at most once. Reverse block order
    // traverses ordinary forward CFGs in one visit per block.
    let mut queue: Vec<usize> = (0..blocks).rev().collect();
    let mut queued = vec![true; blocks];
    let (mut head, mut tail, mut pending) = (0, 0, blocks);
    while pending > 0 {
        let local = queue[head];
        head += 1;
        if head == blocks {
            head = 0;
        }
        pending -= 1;
        queued[local] = false;
        let block = function.block_base + local;
        let row = function.row_base + local * function.words + range.start;
        scratch.copy_from_slice(&packed.phi_out[row..row + words]);
        for edge in packed.successor_range(block) {
            let target = packed.successors[edge] as usize - function.block_base;
            for word in 0..words {
                scratch[word] |= live[target * words + word];
            }
        }
        let mut changed = false;
        for word in 0..words {
            let value = packed.uses[row + word] | (scratch[word] & !packed.defs[row + word]);
            let cell = local * words + word;
            if live[cell] != value {
                live[cell] = value;
                changed = true;
            }
        }
        if changed {
            for edge in packed.predecessor_range(block) {
                let predecessor = packed.predecessors[edge] as usize - function.block_base;
                if !queued[predecessor] {
                    queue[tail] = predecessor;
                    tail += 1;
                    if tail == blocks {
                        tail = 0;
                    }
                    pending += 1;
                    queued[predecessor] = true;
                }
            }
        }
    }
    live
}

#[derive(Clone, Debug)]
pub struct HybridPlan {
    pub cpu_indices: Vec<usize>,
    pub gpu_indices: Vec<usize>,
    pub candidate_gpu_functions: usize,
    pub candidate_gpu_cells: usize,
    pub candidate_gpu_word_groups: usize,
    pub reason: &'static str,
}

pub const MAX_GPU_BLOCKS: usize = 64;
pub const MIN_GPU_FUNCTIONS: usize = 32;
pub const MIN_GPU_CELLS: usize = 50_000;
pub const MIN_GPU_WORD_GROUPS: usize = 1_024;

pub fn hybrid_plan(packed: &PackedAnalysis) -> HybridPlan {
    let candidates: Vec<_> = packed
        .functions
        .iter()
        .filter(|f| f.block_count <= MAX_GPU_BLOCKS)
        .collect();
    let count = candidates.len();
    let cells = candidates.iter().map(|f| f.block_count * f.words).sum();
    let groups = candidates.iter().map(|f| f.words).sum();
    let admit =
        count >= MIN_GPU_FUNCTIONS && (cells >= MIN_GPU_CELLS || groups >= MIN_GPU_WORD_GROUPS);
    let mut cpu_indices = Vec::new();
    let mut gpu_indices = Vec::new();
    for function in &packed.functions {
        if admit && function.block_count <= MAX_GPU_BLOCKS {
            gpu_indices.push(function.module_index);
        } else {
            cpu_indices.push(function.module_index);
        }
    }
    HybridPlan {
        cpu_indices,
        gpu_indices,
        candidate_gpu_functions: count,
        candidate_gpu_cells: cells,
        candidate_gpu_word_groups: groups,
        reason: if admit {
            "GPU batch admission thresholds met"
        } else {
            "GPU batch below admission thresholds"
        },
    }
}

pub fn scatter(
    subset: &PackedAnalysis,
    source: &[u32],
    original: &PackedAnalysis,
    destination: &mut [u32],
) -> Result<(), String> {
    if source.len() != subset.total_cells || destination.len() != original.total_cells {
        return Err("Analysis scatter dimensions do not match".into());
    }
    for function in &subset.functions {
        let target = find_function(original, function.module_index)
            .ok_or("Subset function absent from original analysis")?;
        if target.block_count != function.block_count || target.words != function.words {
            return Err("Analysis scatter function dimensions do not match".into());
        }
        let count = function.block_count * function.words;
        destination[target.row_base..target.row_base + count]
            .copy_from_slice(&source[function.row_base..function.row_base + count]);
    }
    Ok(())
}

fn find_function(packed: &PackedAnalysis, module_index: usize) -> Option<&FunctionDesc> {
    // Full module packing retains source order, so scattering and pruning
    // normally resolve a function directly instead of repeatedly scanning.
    packed
        .functions
        .get(module_index)
        .filter(|f| f.module_index == module_index)
        .or_else(|| {
            packed
                .functions
                .iter()
                .find(|f| f.module_index == module_index)
        })
}

/// Remove dead pure scalar instructions, preserving every call, memory
/// operation, phi node, and control-flow operation. Phi incoming operands are
/// seeded in predecessor live-out; they must keep their definitions alive.
pub fn prune(
    module: &ModuleIR,
    packed: &PackedAnalysis,
    solution: &[u32],
) -> Result<(String, usize), String> {
    if solution.len() != packed.total_cells || packed.functions.len() != module.functions.len() {
        return Err("Pruning requires a complete analysis solution".into());
    }
    let mut output = String::with_capacity(module.text.len());
    output.push_str(&module.preamble);
    let mut removed = 0;
    for (module_index, function) in module.functions.iter().enumerate() {
        let desc = find_function(packed, module_index)
            .ok_or("Pruning analysis omitted a module function")?;
        output.push_str(&function.header);
        if !function.header.ends_with('\n') {
            output.push('\n');
        }
        for (local_block, block) in function.blocks.iter().enumerate() {
            let global = desc.block_base + local_block;
            let row = desc.row_base + local_block * desc.words;
            let mut live = packed.phi_out[row..row + desc.words].to_vec();
            for edge in packed.successor_range(global) {
                let target = packed.successors[edge] as usize;
                let target_row = packed.row_offsets[target];
                for word in 0..desc.words {
                    live[word] |= solution[target_row + word];
                }
            }
            let mut keep = vec![true; block.instructions.len()];
            for (index, instruction) in block.instructions.iter().enumerate().rev() {
                if let Some(value) = instruction.definition {
                    let (word, mask) = bit(value);
                    if instruction.pure && !instruction.is_phi && live[word] & mask == 0 {
                        keep[index] = false;
                        removed += 1;
                        continue;
                    }
                    live[word] &= !mask;
                }
                if !instruction.is_phi {
                    for &value in &instruction.uses {
                        let (word, mask) = bit(value);
                        live[word] |= mask;
                    }
                }
            }
            output.push_str(&block.name);
            output.push_str(":\n");
            for (instruction, keep) in block.instructions.iter().zip(keep) {
                if keep {
                    output.push_str(&instruction.text);
                    if !instruction.text.ends_with('\n') {
                        output.push('\n');
                    }
                }
            }
        }
        output.push_str(&function.footer);
        if !function.footer.ends_with('\n') {
            output.push('\n');
        }
    }
    output.push_str(&module.postamble);
    Ok((output, removed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ir::{BlockIR, FunctionIR, InstructionIR, PhiEdge};
    use std::collections::BTreeSet;

    fn instruction(
        text: &str,
        definition: Option<usize>,
        uses: &[usize],
        pure: bool,
        phi: bool,
    ) -> InstructionIR {
        InstructionIR {
            text: format!("  {text}"),
            definition,
            uses: uses.to_vec(),
            pure,
            is_phi: phi,
        }
    }

    fn block(name: &str, successors: &[usize], instructions: Vec<InstructionIR>) -> BlockIR {
        BlockIR {
            name: name.into(),
            successors: successors.to_vec(),
            instructions,
        }
    }

    fn module(functions: Vec<FunctionIR>) -> ModuleIR {
        ModuleIR {
            text: String::new(),
            preamble: "; test\n".into(),
            functions,
            postamble: String::new(),
        }
    }

    fn function(
        name: &str,
        values: usize,
        blocks: Vec<BlockIR>,
        phi_edges: Vec<PhiEdge>,
    ) -> FunctionIR {
        FunctionIR {
            name: name.into(),
            header: format!("define i64 @{name}() {{\n"),
            footer: "}\n".into(),
            value_count: values,
            blocks,
            phi_edges,
        }
    }

    /// Deliberately independent set equations, rebuilding GEN/DEF from
    /// instructions and scanning the entire CFG rather than packed rows.
    fn oracle(module: &ModuleIR, packed: &PackedAnalysis) -> Vec<u32> {
        let mut result = vec![0; packed.total_cells];
        for desc in &packed.functions {
            let function = &module.functions[desc.module_index];
            let mut gen = Vec::new();
            let mut defs = Vec::new();
            let mut phi = vec![BTreeSet::new(); function.blocks.len()];
            for block in &function.blocks {
                let mut g = BTreeSet::new();
                let mut d = BTreeSet::new();
                for instruction in &block.instructions {
                    if !instruction.is_phi {
                        for value in &instruction.uses {
                            if !d.contains(value) {
                                g.insert(*value);
                            }
                        }
                    }
                    if let Some(value) = instruction.definition {
                        d.insert(value);
                    }
                }
                gen.push(g);
                defs.push(d);
            }
            for edge in &function.phi_edges {
                phi[edge.from].extend(edge.values.iter().copied());
            }
            let mut live = vec![BTreeSet::new(); function.blocks.len()];
            loop {
                let previous = live.clone();
                for (index, block) in function.blocks.iter().enumerate() {
                    let mut out = phi[index].clone();
                    for &target in &block.successors {
                        out.extend(previous[target].iter().copied());
                    }
                    live[index] = gen[index]
                        .union(&out.difference(&defs[index]).copied().collect())
                        .copied()
                        .collect();
                }
                if live == previous {
                    break;
                }
            }
            for (block, values) in live.iter().enumerate() {
                for &value in values {
                    let (word, mask) = bit(value);
                    result[desc.row_base + block * desc.words + word] |= mask;
                }
            }
        }
        result
    }

    #[test]
    fn phi_incoming_is_live_out_but_killed_by_predecessor_definition() {
        let source = module(vec![function(
            "phi",
            4,
            vec![
                block(
                    "entry",
                    &[1],
                    vec![
                        instruction("%a = add i64 7, 1", Some(0), &[], true, false),
                        instruction("%unused = add i64 5, 6", Some(3), &[], true, false),
                        instruction("br label %join", None, &[], false, false),
                    ],
                ),
                block(
                    "join",
                    &[],
                    vec![
                        instruction("%p = phi i64 [ %a, %entry ]", Some(1), &[], false, true),
                        instruction("ret i64 %p", None, &[1], false, false),
                    ],
                ),
            ],
            vec![PhiEdge {
                from: 0,
                to: 1,
                values: vec![0],
            }],
        )]);
        let packed = prepare(&source).unwrap();
        let actual = solve_cpu_serial(&packed);
        assert_eq!(actual, oracle(&source, &packed));
        assert_eq!(actual, vec![0, 0]);
        assert_eq!(packed.phi_out, vec![1, 0]);
        let (output, removed) = prune(&source, &packed, &actual).unwrap();
        assert!(output.contains("%a = add"));
        assert!(output.contains("%p = phi"));
        assert!(!output.contains("%unused"));
        assert_eq!(removed, 1);
    }

    #[test]
    fn loops_word_boundaries_and_parallel_variants_match_set_oracle() {
        let mut functions = Vec::new();
        for index in 0..37 {
            functions.push(function(
                &format!("loop{index}"),
                161,
                vec![
                    block(
                        "entry",
                        &[1],
                        vec![instruction(
                            "br label %loop",
                            None,
                            &[0, 31, 32, 63, 64, 127, 160],
                            false,
                            false,
                        )],
                    ),
                    block(
                        "loop",
                        &[1, 2],
                        vec![
                            instruction("%x = add i64 %arg, 1", Some(1), &[0], true, false),
                            instruction(
                                "br i1 %condition, label %loop, label %exit",
                                None,
                                &[32],
                                false,
                                false,
                            ),
                        ],
                    ),
                    block(
                        "exit",
                        &[],
                        vec![instruction("ret i64 %x", None, &[1, 160], false, false)],
                    ),
                ],
                vec![],
            ));
        }
        let source = module(functions);
        let packed = prepare(&source).unwrap();
        let expected = oracle(&source, &packed);
        assert_eq!(solve_cpu_serial(&packed), expected);
        assert_eq!(solve_cpu(&packed), expected);
        assert_eq!(solve_cpu_parallel(&packed), expected);
        assert_eq!(solve_cpu_word_parallel(&packed), expected);
        assert_eq!(std::mem::size_of::<GPUGroup>(), 20);
    }

    #[test]
    fn pruning_preserves_effects_and_removes_dead_dependency_chain() {
        let source = module(vec![function(
            "effects",
            8,
            vec![block(
                "entry",
                &[],
                vec![
                    instruction("%a = add i64 1, 2", Some(0), &[], true, false),
                    instruction("%b = mul i64 %a, 3", Some(1), &[0], true, false),
                    instruction("%ptr = alloca i64", Some(2), &[], false, false),
                    instruction("%load = load i64, ptr %ptr", Some(3), &[2], false, false),
                    instruction(
                        "%call = call i64 @observe(i64 %load)",
                        Some(4),
                        &[3],
                        false,
                        false,
                    ),
                    instruction("store i64 %call, ptr %ptr", None, &[4, 2], false, false),
                    instruction("call void @llvm.trap()", None, &[], false, false),
                    instruction("ret i64 0", None, &[], false, false),
                ],
            )],
            vec![],
        )]);
        let packed = prepare(&source).unwrap();
        let (output, removed) = prune(&source, &packed, &solve_cpu(&packed)).unwrap();
        assert_eq!(removed, 2);
        for retained in [
            "alloca",
            "load i64",
            "@observe",
            "store i64",
            "@llvm.trap",
            "ret i64",
        ] {
            assert!(output.contains(retained));
        }
    }

    #[test]
    fn hybrid_admission_scatter_and_empty_subset() {
        let mut functions = Vec::new();
        for index in 0..32 {
            functions.push(function(
                &format!("wide{index}"),
                1024,
                vec![block(
                    "entry",
                    &[],
                    vec![instruction("ret i64 %arg", None, &[index], false, false)],
                )],
                vec![],
            ));
        }
        functions.push(function(
            "long",
            1,
            (0..65)
                .map(|block_index| {
                    let successors = if block_index == 64 {
                        Vec::new()
                    } else {
                        vec![block_index + 1]
                    };
                    block(
                        &format!("b{block_index}"),
                        &successors,
                        vec![instruction("ret i64 %arg", None, &[0], false, false)],
                    )
                })
                .collect(),
            vec![],
        ));
        let source = module(functions);
        let packed = prepare(&source).unwrap();
        let plan = hybrid_plan(&packed);
        assert_eq!(plan.candidate_gpu_word_groups, 1024);
        assert_eq!(plan.gpu_indices.len(), 32);
        assert_eq!(plan.cpu_indices, vec![32]);
        let mut merged = vec![0; packed.total_cells];
        for indices in [&plan.cpu_indices, &plan.gpu_indices] {
            let subset = prepare_subset(&source, indices).unwrap();
            scatter(&subset, &solve_cpu_serial(&subset), &packed, &mut merged).unwrap();
        }
        assert_eq!(merged, solve_cpu_serial(&packed));
        let empty = prepare_subset(&source, &[]).unwrap();
        assert_eq!(solve_cpu(&empty), Vec::<u32>::new());
        assert_eq!(empty.row_offsets, vec![0]);
        let small = prepare_subset(&source, &[0]).unwrap();
        assert!(hybrid_plan(&small).gpu_indices.is_empty());
    }

    #[test]
    fn invalid_phi_edges_and_values_fail_closed() {
        let mut source = module(vec![function(
            "bad",
            1,
            vec![block("entry", &[], vec![])],
            vec![PhiEdge {
                from: 0,
                to: 0,
                values: vec![0],
            }],
        )]);
        assert!(prepare(&source).unwrap_err().contains("Invalid phi edge"));
        source.functions[0].phi_edges.clear();
        source.functions[0].blocks[0].instructions.push(instruction(
            "bad",
            None,
            &[1],
            false,
            false,
        ));
        assert!(prepare(&source).unwrap_err().contains("Invalid SSA value"));
        assert!(prepare_subset(&source, &[2]).is_err());
    }
}
