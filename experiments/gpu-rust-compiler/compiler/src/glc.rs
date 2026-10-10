// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Validated GLC1 workpacks shared with the experimental CUDA executable.

use crate::analysis::{FunctionDesc, GPUGroup, PackedAnalysis};
use std::collections::BTreeMap;
use std::time::Instant;

#[cfg(test)]
pub fn decode(bytes: &[u8]) -> Result<PackedAnalysis, String> {
    decode_timed(bytes).map(|(packed, _, _)| packed)
}

pub fn decode_timed(bytes: &[u8]) -> Result<(PackedAnalysis, f64, f64), String> {
    let decode_start = Instant::now();
    if bytes.get(..4) != Some(b"GLC1") {
        return Err("Expected GLC1 input magic".into());
    }
    let mut reader = Reader { bytes, position: 4 };
    let functions = reader.word()? as usize;
    let blocks = reader.word()? as usize;
    let cells = reader.word()? as usize;
    let groups = reader.word()? as usize;
    let max_blocks = reader.word()? as usize;
    let edges = reader.word()? as usize;
    if functions == 0 || blocks == 0 || cells == 0 || groups == 0 {
        return Err("Empty workload dimensions".into());
    }
    let expected_words = groups as u64 * 5 + blocks as u64 + 1 + edges as u64 + cells as u64 * 3;
    if expected_words * 4 != (bytes.len() - reader.position) as u64 {
        return Err("Binary length does not match header dimensions".into());
    }
    let descriptors = (0..groups)
        .map(|_| {
            Ok(GPUGroup {
                block_base: reader.word()?,
                block_count: reader.word()?,
                row_base: reader.word()?,
                words: reader.word()?,
                word: reader.word()?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let successor_offsets = reader.words(blocks + 1)?;
    let successors = reader.words(edges)?;
    let uses = reader.words(cells)?;
    let defs = reader.words(cells)?;
    let phi_out = reader.words(cells)?;
    if successor_offsets[0] != 0 || successor_offsets[blocks] as usize != edges {
        return Err("Successor offsets do not span the edges array".into());
    }
    if successor_offsets
        .windows(2)
        .any(|pair| pair[0] > pair[1] || pair[1] as usize > edges)
    {
        return Err("Invalid successor offsets".into());
    }

    struct Shape {
        blocks: usize,
        row: usize,
        words: usize,
        seen: Vec<bool>,
    }
    let mut shapes = BTreeMap::new();
    let mut largest = 0;
    for group in &descriptors {
        let block_base = group.block_base as usize;
        let block_count = group.block_count as usize;
        let row = group.row_base as usize;
        let words = group.words as usize;
        let word = group.word as usize;
        if block_count == 0
            || words == 0
            || words > groups
            || word >= words
            || block_base as u64 + block_count as u64 > blocks as u64
            || row as u64 + block_count as u64 * words as u64 > cells as u64
        {
            return Err("Invalid function-word group".into());
        }
        largest = largest.max(block_count);
        let shape = shapes.entry(block_base).or_insert_with(|| Shape {
            blocks: block_count,
            row,
            words,
            seen: vec![false; words],
        });
        if shape.blocks != block_count
            || shape.row != row
            || shape.words != words
            || shape.seen[word]
        {
            return Err("Duplicate or inconsistent function-word group".into());
        }
        shape.seen[word] = true;
    }
    if shapes.len() != functions || largest != max_blocks {
        return Err("Function count or maximum block count does not match descriptors".into());
    }
    let mut function_descs = Vec::with_capacity(functions);
    let mut row_offsets = Vec::with_capacity(blocks + 1);
    let (mut next_block, mut next_cell) = (0, 0);
    for (base, shape) in shapes {
        if base != next_block || shape.row != next_cell || shape.seen.contains(&false) {
            return Err(
                "Function groups do not cover every block and output cell exactly once".into(),
            );
        }
        let end = base + shape.blocks;
        for block in base..end {
            for &successor in &successors
                [successor_offsets[block] as usize..successor_offsets[block + 1] as usize]
            {
                let successor = successor as usize;
                if successor < base || successor >= end {
                    return Err("CFG successor escapes its owning function".into());
                }
            }
            row_offsets.push(shape.row + (block - base) * shape.words);
        }
        function_descs.push(FunctionDesc {
            module_index: function_descs.len(),
            block_base: base,
            block_count: shape.blocks,
            row_base: shape.row,
            words: shape.words,
            value_count: shape.words * 32,
        });
        next_block = end;
        next_cell += shape.blocks * shape.words;
    }
    if next_block != blocks || next_cell != cells {
        return Err("Function groups leave uncovered blocks or cells".into());
    }
    row_offsets.push(cells);
    let input_decode_ms = decode_start.elapsed().as_secs_f64() * 1_000.0;
    let predecessor_start = Instant::now();

    // Build predecessor CSR once. Solvers benchmark resident input rather
    // than paying file decoding or reverse-edge construction on each pass.
    let mut predecessor_offsets = vec![0u32; blocks + 1];
    for &successor in &successors {
        predecessor_offsets[successor as usize + 1] += 1;
    }
    for block in 0..blocks {
        predecessor_offsets[block + 1] += predecessor_offsets[block];
    }
    let mut cursor = predecessor_offsets[..blocks].to_vec();
    let mut predecessors = vec![0; edges];
    for block in 0..blocks {
        for &successor in
            &successors[successor_offsets[block] as usize..successor_offsets[block + 1] as usize]
        {
            let successor = successor as usize;
            predecessors[cursor[successor] as usize] = block as u32;
            cursor[successor] += 1;
        }
    }
    let predecessor_prepare_ms = predecessor_start.elapsed().as_secs_f64() * 1_000.0;
    Ok((
        PackedAnalysis {
            functions: function_descs,
            groups: descriptors,
            successor_offsets,
            successors,
            predecessor_offsets,
            predecessors,
            row_offsets,
            uses,
            defs,
            phi_out,
            total_cells: cells,
        },
        input_decode_ms,
        predecessor_prepare_ms,
    ))
}

struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl Reader<'_> {
    fn word(&mut self) -> Result<u32, String> {
        let raw = self
            .bytes
            .get(self.position..self.position + 4)
            .ok_or("Truncated input")?;
        self.position += 4;
        Ok(u32::from_le_bytes(raw.try_into().unwrap()))
    }

    fn words(&mut self, count: usize) -> Result<Vec<u32>, String> {
        (0..count).map(|_| self.word()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::{solve_cpu_parallel, solve_cpu_serial, solve_cpu_word_parallel};

    fn encode(words: &[u32]) -> Vec<u8> {
        let mut bytes = b"GLC1".to_vec();
        bytes.extend(words.iter().flat_map(|word| word.to_le_bytes()));
        bytes
    }

    #[test]
    fn native_solvers_keep_phi_uses_and_definitions_correct_across_a_loop() {
        // Two blocks and two bitset words. Block zero defines bit 1;
        // block one uses it. A phi operand on block zero uses bit 2.
        let bytes = encode(&[
            1, 2, 4, 2, 2, 2, // counts
            0, 2, 0, 2, 0, 0, 2, 0, 2, 1, // groups
            0, 1, 2, // successor offsets
            1, 0, // loop successors
            1, 0, 2, 8, // uses
            2, 0, 0, 0, // definitions
            4, 16, 0, 0, // phi-out uses
        ]);
        let packed = decode(&bytes).unwrap();
        // OUT0=(IN1|PHI0), then DEF0 kills bit 1. The loop carries
        // both words to block one, where its local use restores bit 1.
        let expected = vec![5, 24, 7, 24];
        assert_eq!(solve_cpu_serial(&packed), expected);
        assert_eq!(solve_cpu_parallel(&packed), expected);
        assert_eq!(solve_cpu_word_parallel(&packed), expected);
    }

    #[test]
    fn workpack_decoder_rejects_truncation_and_invalid_graph_ownership() {
        let words = vec![
            2, 2, 2, 2, 1, 0, // two isolated one-block functions
            0, 1, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, // offsets, then no edges
            1, 2, 0, 0, 0, 0,
        ];
        let valid = encode(&words);
        assert_eq!(solve_cpu_serial(&decode(&valid).unwrap()), vec![1, 2]);
        for length in 0..valid.len() {
            assert!(
                decode(&valid[..length]).is_err(),
                "Accepted truncated length {length}"
            );
        }
        let mut trailing = valid.clone();
        trailing.push(0);
        assert!(decode(&trailing).is_err());
        let mut wrong_magic = valid.clone();
        wrong_magic[0] = b'X';
        assert!(decode(&wrong_magic).is_err());
        for (index, value) in [(0, 0), (4, 2), (6, 1), (11, 0), (13, 0)] {
            let mut malformed = words.clone();
            malformed[index] = value;
            assert!(
                decode(&encode(&malformed)).is_err(),
                "Accepted malformed word {index}"
            );
        }
        let crossing = encode(&[
            2, 2, 2, 2, 1, 1, 0, 1, 0, 1, 0, 1, 1, 1, 1, 0, 0, 1, 1,
            1, // function zero has an edge to function one
            1, 2, 0, 0, 0, 0,
        ]);
        assert!(decode(&crossing)
            .unwrap_err()
            .contains("escapes its owning function"));
    }
}
