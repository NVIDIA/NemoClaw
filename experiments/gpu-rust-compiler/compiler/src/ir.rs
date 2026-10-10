// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Compiler-owned control flow and operand identities, recorded during emission.
//! Text is retained only for final LLVM output; analysis never reparses it.

#[derive(Clone, Debug)]
pub struct ModuleIR {
    pub text: String,
    pub preamble: String,
    pub functions: Vec<FunctionIR>,
    pub postamble: String,
}

#[derive(Clone, Debug)]
pub struct FunctionIR {
    pub name: String,
    pub header: String,
    pub footer: String,
    pub value_count: usize,
    pub blocks: Vec<BlockIR>,
    pub phi_edges: Vec<PhiEdge>,
}

#[derive(Clone, Debug)]
pub struct BlockIR {
    pub name: String,
    pub instructions: Vec<InstructionIR>,
    pub successors: Vec<usize>,
}

#[derive(Clone, Debug)]
pub struct InstructionIR {
    /// Complete indented LLVM instruction, without its trailing newline.
    pub text: String,
    pub definition: Option<usize>,
    /// SSA operand IDs. Constants and globals do not require liveness bits.
    pub uses: Vec<usize>,
    /// Only computations which can safely be removed when their result is dead.
    pub pure: bool,
    pub is_phi: bool,
}

#[derive(Clone, Debug)]
pub struct PhiEdge {
    pub from: usize,
    pub to: usize,
    pub values: Vec<usize>,
}

impl ModuleIR {
    pub fn render(&self) -> String {
        let mut text = self.preamble.clone();
        for function in &self.functions {
            text.push_str(&function.render());
        }
        text.push_str(&self.postamble);
        text
    }
}

impl FunctionIR {
    pub fn render(&self) -> String {
        let mut text = self.header.clone();
        for block in &self.blocks {
            text.push_str(&block.name);
            text.push_str(":\n");
            for instruction in &block.instructions {
                text.push_str(&instruction.text);
                text.push('\n');
            }
        }
        text.push_str(&self.footer);
        text
    }
}
