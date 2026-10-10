// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! LLVM emission for the experimental compiler's small Rust language subset.
//! Integer arithmetic wraps. Shifts mask their count to six bits. Division and
//! remainder trap on zero and MIN / -1 rather than invoking LLVM undefined behavior.
use crate::frontend::{Expr, Function, Program, Stmt, Type};
use crate::ir::{BlockIR, FunctionIR, InstructionIR, ModuleIR, PhiEdge};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ty {
    I64,
    Bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontend;

    #[test]
    fn structured_render_preserves_legacy_llvm() {
        let program = frontend::parse("fn main() -> i64 { return 17; }").unwrap();
        let module = emit_structured(&program).unwrap();
        let expected = concat!(
            "; Experimental Rust subset compiler: target-neutral LLVM IR\n",
            "@.format = private unnamed_addr constant [6 x i8] c\"%lld\\0A\\00\", align 1\n",
            "declare i32 @printf(ptr, ...)\n",
            "declare void @llvm.trap() cold noreturn nounwind\n\n",
            "define i64 @r_main() {\nentry:\n  ret i64 17\n}\n\n",
            "define i32 @main() {\nentry:\n  %result = call i64 @r_main()\n",
            "  %printed = call i32 (ptr, ...) @printf(ptr @.format, i64 %result)\n",
            "  ret i32 0\n}\n",
        );
        assert_eq!(module.text, expected);
        assert_eq!(module.render(), expected);
    }

    #[test]
    fn nested_phi_operands_are_attached_to_predecessor_edges() {
        let program = frontend::parse(
            "fn choose(a: i64, b: i64) -> bool { return a > 0 && (b > 1 || a < 9); }
             fn main() -> bool { return choose(3, 4); }",
        )
        .unwrap();
        let module = emit_structured(&program).unwrap();
        let function = &module.functions[0];
        let phi_count = function
            .blocks
            .iter()
            .flat_map(|block| &block.instructions)
            .filter(|instruction| instruction.is_phi)
            .count();
        assert_eq!(phi_count, 2);
        assert_eq!(function.phi_edges.len(), 2);
        for edge in &function.phi_edges {
            assert!(function.blocks[edge.from].successors.contains(&edge.to));
            assert_eq!(edge.values.len(), 1);
            assert!(function.blocks[edge.from]
                .instructions
                .iter()
                .any(|instruction| instruction.definition == Some(edge.values[0])));
            assert!(function.blocks[edge.to]
                .instructions
                .iter()
                .any(|instruction| instruction.is_phi && instruction.uses.is_empty()));
        }
        let mut definitions = HashSet::new();
        for instruction in function.blocks.iter().flat_map(|block| &block.instructions) {
            if let Some(id) = instruction.definition {
                assert!(id >= 2 && id < function.value_count);
                assert!(definitions.insert(id));
            }
            assert!(instruction.uses.iter().all(|id| *id < function.value_count));
        }
        assert_eq!(definitions.len() + 2, function.value_count);
    }

    #[test]
    fn memory_calls_and_division_guards_are_not_removable() {
        let program = frontend::parse(
            "fn quotient(x: i64, y: i64) -> i64 { let z: i64 = x / y; print_i64(z); return z; }
             fn main() -> i64 { return quotient(10, 2); }",
        )
        .unwrap();
        let module = emit_structured(&program).unwrap();
        let instructions: Vec<_> = module
            .functions
            .iter()
            .flat_map(|function| &function.blocks)
            .flat_map(|block| &block.instructions)
            .collect();
        for marker in [
            "alloca",
            "load",
            "store",
            "call",
            "unreachable",
            "ret",
            "br ",
        ] {
            let matching: Vec<_> = instructions
                .iter()
                .filter(|instruction| instruction.text.contains(marker))
                .collect();
            assert!(!matching.is_empty(), "missing {marker}");
            assert!(
                matching.iter().all(|instruction| !instruction.pure),
                "unsafe {marker}"
            );
        }
        let division = instructions
            .iter()
            .find(|instruction| instruction.text.contains(" = sdiv "))
            .unwrap();
        assert!(division.pure);
        assert_eq!(division.uses.len(), 2);
    }
}
impl Ty {
    fn llvm(self) -> &'static str {
        match self {
            Self::I64 => "i64",
            Self::Bool => "i1",
        }
    }
    fn from_ast(value: &Type) -> Self {
        match value {
            Type::I64 => Self::I64,
            Type::Bool => Self::Bool,
        }
    }
}
#[derive(Clone)]
struct Signature {
    params: Vec<Ty>,
    result: Ty,
}
#[derive(Clone)]
struct Binding {
    pointer: String,
    pointer_id: usize,
    ty: Ty,
    mutable: bool,
}
struct Value {
    text: String,
    ty: Ty,
    id: Option<usize>,
}

pub fn emit(program: &Program) -> Result<String, String> {
    Ok(emit_structured(program)?.text)
}

pub fn emit_structured(program: &Program) -> Result<ModuleIR, String> {
    let mut signatures = HashMap::new();
    for function in &program.functions {
        if function.name == "print_i64" {
            return Err("print_i64 is a reserved builtin".into());
        }
        if !valid_name(&function.name) {
            return Err(format!("Invalid function name: {}", function.name));
        }
        let mut names = HashSet::new();
        for (name, _) in &function.params {
            if !names.insert(name) {
                return Err(format!("Duplicate parameter {name} in {}", function.name));
            }
        }
        let signature = Signature {
            params: function
                .params
                .iter()
                .map(|(_, ty)| Ty::from_ast(ty))
                .collect(),
            result: Ty::from_ast(&function.return_type),
        };
        if signatures
            .insert(function.name.clone(), signature)
            .is_some()
        {
            return Err(format!("Duplicate function: {}", function.name));
        }
    }
    let main = signatures
        .get("main")
        .ok_or("Program requires a main function")?;
    if !main.params.is_empty() {
        return Err("main must take no parameters".into());
    }
    let preamble = String::from(
        "; Experimental Rust subset compiler: target-neutral LLVM IR\n\
         @.format = private unnamed_addr constant [6 x i8] c\"%lld\\0A\\00\", align 1\n\
         declare i32 @printf(ptr, ...)\n\
         declare void @llvm.trap() cold noreturn nounwind\n\n",
    );
    let mut functions = Vec::new();
    for function in &program.functions {
        functions.push(FunctionEmitter::new(&signatures, function).emit(function)?);
    }
    let mut instructions = vec![InstructionIR {
        text: format!("  %result = call {} @r_main()", main.result.llvm()),
        definition: Some(0),
        uses: vec![],
        pure: false,
        is_phi: false,
    }];
    let printable = if main.result == Ty::Bool {
        instructions.push(InstructionIR {
            text: "  %printable = zext i1 %result to i64".into(),
            definition: Some(1),
            uses: vec![0],
            pure: true,
            is_phi: false,
        });
        ("%printable", 1)
    } else {
        ("%result", 0)
    };
    let printed_id = printable.1 + 1;
    instructions.push(InstructionIR {
        text: format!(
            "  %printed = call i32 (ptr, ...) @printf(ptr @.format, i64 {})",
            printable.0
        ),
        definition: Some(printed_id),
        uses: vec![printable.1],
        pure: false,
        is_phi: false,
    });
    instructions.push(InstructionIR {
        text: "  ret i32 0".into(),
        definition: None,
        uses: vec![],
        pure: false,
        is_phi: false,
    });
    functions.push(FunctionIR {
        name: "main".into(),
        header: "define i32 @main() {\n".into(),
        footer: "}\n".into(),
        value_count: printed_id + 1,
        blocks: vec![BlockIR {
            name: "entry".into(),
            instructions,
            successors: vec![],
        }],
        phi_edges: vec![],
    });
    let mut module = ModuleIR {
        text: String::new(),
        preamble,
        functions,
        postamble: String::new(),
    };
    module.text = module.render();
    Ok(module)
}

fn operand_ids(values: &[&Value]) -> Vec<usize> {
    values.iter().filter_map(|value| value.id).collect()
}

fn valid_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z' | b'A'..=b'Z' | b'_'))
        && bytes.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

struct FunctionEmitter<'a> {
    signatures: &'a HashMap<String, Signature>,
    scopes: Vec<HashMap<String, Binding>>,
    allocas: Vec<InstructionIR>,
    blocks: Vec<BlockIR>,
    successor_labels: Vec<(usize, String)>,
    phi_labels: Vec<(String, String, Vec<usize>)>,
    next_value: usize,
    parameter_count: usize,
    next_label: usize,
    current_label: String,
    terminated: bool,
    result: Ty,
    name: String,
}

impl<'a> FunctionEmitter<'a> {
    fn new(signatures: &'a HashMap<String, Signature>, function: &Function) -> Self {
        Self {
            signatures,
            scopes: vec![HashMap::new()],
            allocas: vec![],
            blocks: vec![BlockIR {
                name: "entry".into(),
                instructions: vec![],
                successors: vec![],
            }],
            successor_labels: vec![],
            phi_labels: vec![],
            next_value: 0,
            parameter_count: function.params.len(),
            next_label: 0,
            current_label: "entry".into(),
            terminated: false,
            result: Ty::from_ast(&function.return_type),
            name: function.name.clone(),
        }
    }
    fn emit(mut self, function: &Function) -> Result<FunctionIR, String> {
        let mut parameters = Vec::new();
        for (index, (name, ty)) in function.params.iter().enumerate() {
            let ty = Ty::from_ast(ty);
            parameters.push(format!("{} %arg{index}", ty.llvm()));
            let (pointer, pointer_id) = self.allocate(ty);
            self.line(
                format!("store {} %arg{index}, ptr {pointer}", ty.llvm()),
                vec![index, pointer_id],
            );
            self.scopes[0].insert(
                name.clone(),
                Binding {
                    pointer,
                    pointer_id,
                    ty,
                    mutable: false,
                },
            );
        }
        self.statements(&function.body, true)?;
        if !self.terminated {
            return Err(format!(
                "Function {} can reach its end without returning",
                self.name
            ));
        }
        let header = format!(
            "define {} @r_{}({}) {{\n",
            self.result.llvm(),
            function.name,
            parameters.join(", ")
        );
        self.allocas.append(&mut self.blocks[0].instructions);
        self.blocks[0].instructions = self.allocas;
        let labels: HashMap<_, _> = self
            .blocks
            .iter()
            .enumerate()
            .map(|(index, block)| (block.name.as_str(), index))
            .collect();
        let mut successors = vec![Vec::new(); self.blocks.len()];
        for (from, label) in &self.successor_labels {
            let to = *labels
                .get(label.as_str())
                .ok_or_else(|| format!("Missing basic block {label}"))?;
            if !successors[*from].contains(&to) {
                successors[*from].push(to);
            }
        }
        let mut phi_edges = Vec::new();
        for (from, to, values) in self.phi_labels {
            let from = *labels
                .get(from.as_str())
                .ok_or_else(|| format!("Missing phi predecessor {from}"))?;
            let to = *labels
                .get(to.as_str())
                .ok_or_else(|| format!("Missing phi target {to}"))?;
            phi_edges.push(PhiEdge { from, to, values });
        }
        for (block, edges) in self.blocks.iter_mut().zip(successors) {
            block.successors = edges;
        }
        Ok(FunctionIR {
            name: format!("r_{}", function.name),
            header,
            footer: "}\n\n".into(),
            value_count: self.parameter_count + self.next_value,
            blocks: self.blocks,
            phi_edges,
        })
    }
    fn temporary(&mut self) -> (String, usize) {
        let name = format!("%v{}", self.next_value);
        let id = self.parameter_count + self.next_value;
        self.next_value += 1;
        (name, id)
    }
    fn label(&mut self) -> String {
        let name = format!("bb{}", self.next_label);
        self.next_label += 1;
        name
    }
    fn line(&mut self, line: String, uses: Vec<usize>) {
        self.blocks
            .last_mut()
            .unwrap()
            .instructions
            .push(InstructionIR {
                text: format!("  {line}"),
                definition: None,
                uses,
                pure: false,
                is_phi: false,
            });
    }
    fn start_block(&mut self, label: &str) {
        self.blocks.push(BlockIR {
            name: label.into(),
            instructions: vec![],
            successors: vec![],
        });
        self.current_label = label.into();
        self.terminated = false;
    }
    fn branch(&mut self, label: &str) {
        self.successor_labels
            .push((self.blocks.len() - 1, label.into()));
        self.line(format!("br label %{label}"), vec![]);
        self.terminated = true;
    }
    fn conditional(&mut self, condition: &Value, yes: &str, no: &str) {
        self.successor_labels
            .push((self.blocks.len() - 1, yes.into()));
        self.successor_labels
            .push((self.blocks.len() - 1, no.into()));
        self.line(
            format!("br i1 {}, label %{yes}, label %{no}", condition.text),
            operand_ids(&[condition]),
        );
        self.terminated = true;
    }
    fn instruction(&mut self, ty: Ty, instruction: String, uses: Vec<usize>, pure: bool) -> Value {
        let (text, id) = self.temporary();
        self.blocks
            .last_mut()
            .unwrap()
            .instructions
            .push(InstructionIR {
                text: format!("  {text} = {instruction}"),
                definition: Some(id),
                uses,
                pure,
                is_phi: false,
            });
        Value {
            text,
            ty,
            id: Some(id),
        }
    }
    fn allocate(&mut self, ty: Ty) -> (String, usize) {
        let (pointer, id) = self.temporary();
        self.allocas.push(InstructionIR {
            text: format!(
                "  {pointer} = alloca {}, align {}",
                ty.llvm(),
                if ty == Ty::I64 { 8 } else { 1 }
            ),
            definition: Some(id),
            uses: vec![],
            pure: false,
            is_phi: false,
        });
        (pointer, id)
    }
    fn require(&self, actual: Ty, expected: Ty, context: &str) -> Result<(), String> {
        if actual == expected {
            Ok(())
        } else {
            Err(format!(
                "Type mismatch in {context}: expected {expected:?}, got {actual:?}"
            ))
        }
    }
    fn lookup(&self, name: &str) -> Result<Binding, String> {
        self.scopes
            .iter()
            .rev()
            .find_map(|scope| scope.get(name).cloned())
            .ok_or_else(|| format!("Unknown variable: {name}"))
    }
    fn statements(&mut self, statements: &[Stmt], function_body: bool) -> Result<(), String> {
        for (index, statement) in statements.iter().enumerate() {
            if self.terminated {
                break;
            }
            if function_body && index + 1 == statements.len() {
                if let Stmt::Expr(expr) = statement {
                    if !matches!(expr, Expr::Call { name, .. } if name == "print_i64") {
                        let value = self.expression(expr)?;
                        self.return_value(value)?;
                        continue;
                    }
                }
            }
            self.statement(statement)?;
        }
        Ok(())
    }
    fn nested(&mut self, statements: &[Stmt]) -> Result<(), String> {
        self.scopes.push(HashMap::new());
        let result = self.statements(statements, false);
        self.scopes.pop();
        result
    }
    fn return_value(&mut self, value: Value) -> Result<(), String> {
        self.require(value.ty, self.result, "return")?;
        self.line(
            format!("ret {} {}", value.ty.llvm(), value.text),
            operand_ids(&[&value]),
        );
        self.terminated = true;
        Ok(())
    }
    fn statement(&mut self, statement: &Stmt) -> Result<(), String> {
        match statement {
            Stmt::Let {
                name,
                ty,
                mutable,
                value,
            } => {
                let value = self.expression(value)?;
                if let Some(annotation) = ty {
                    self.require(value.ty, Ty::from_ast(annotation), "let initializer")?;
                }
                let (pointer, pointer_id) = self.allocate(value.ty);
                let mut uses = operand_ids(&[&value]);
                uses.push(pointer_id);
                self.line(
                    format!("store {} {}, ptr {pointer}", value.ty.llvm(), value.text),
                    uses,
                );
                self.scopes.last_mut().unwrap().insert(
                    name.clone(),
                    Binding {
                        pointer,
                        pointer_id,
                        ty: value.ty,
                        mutable: *mutable,
                    },
                );
            }
            Stmt::Assign { name, value } => {
                let binding = self.lookup(name)?;
                if !binding.mutable {
                    return Err(format!("Cannot assign to immutable variable: {name}"));
                }
                let value = self.expression(value)?;
                self.require(value.ty, binding.ty, "assignment")?;
                self.line(
                    format!(
                        "store {} {}, ptr {}",
                        value.ty.llvm(),
                        value.text,
                        binding.pointer
                    ),
                    {
                        let mut uses = operand_ids(&[&value]);
                        uses.push(binding.pointer_id);
                        uses
                    },
                );
            }
            Stmt::Return(expr) => {
                let value = self.expression(expr)?;
                self.return_value(value)?;
            }
            Stmt::Expr(Expr::Call { name, args }) if name == "print_i64" => {
                if args.len() != 1 {
                    return Err("print_i64 requires one i64 argument".into());
                }
                let value = self.expression(&args[0])?;
                self.require(value.ty, Ty::I64, "print_i64 argument")?;
                self.line(
                    format!(
                        "call i32 (ptr, ...) @printf(ptr @.format, i64 {})",
                        value.text
                    ),
                    operand_ids(&[&value]),
                );
            }
            Stmt::Expr(expr) => {
                self.expression(expr)?;
            }
            Stmt::If {
                condition,
                then_body,
                else_body,
            } => {
                let condition = self.expression(condition)?;
                self.require(condition.ty, Ty::Bool, "if condition")?;
                let yes = self.label();
                let no = self.label();
                let end = self.label();
                self.conditional(&condition, &yes, &no);
                self.start_block(&yes);
                self.nested(then_body)?;
                let yes_falls = !self.terminated;
                if yes_falls {
                    self.branch(&end);
                }
                self.start_block(&no);
                self.nested(else_body)?;
                let no_falls = !self.terminated;
                if no_falls {
                    self.branch(&end);
                }
                if yes_falls || no_falls {
                    self.start_block(&end);
                }
            }
            Stmt::While { condition, body } => {
                let test = self.label();
                let loop_body = self.label();
                let end = self.label();
                self.branch(&test);
                self.start_block(&test);
                let condition = self.expression(condition)?;
                self.require(condition.ty, Ty::Bool, "while condition")?;
                self.conditional(&condition, &loop_body, &end);
                self.start_block(&loop_body);
                self.nested(body)?;
                if !self.terminated {
                    self.branch(&test);
                }
                self.start_block(&end);
            }
        }
        Ok(())
    }
    fn expression(&mut self, expression: &Expr) -> Result<Value, String> {
        match expression {
            Expr::Int(number) => Ok(Value {
                text: number.to_string(),
                ty: Ty::I64,
                id: None,
            }),
            Expr::Bool(value) => Ok(Value {
                text: value.to_string(),
                ty: Ty::Bool,
                id: None,
            }),
            Expr::Var(name) => {
                let binding = self.lookup(name)?;
                Ok(self.instruction(
                    binding.ty,
                    format!("load {}, ptr {}", binding.ty.llvm(), binding.pointer),
                    vec![binding.pointer_id],
                    false,
                ))
            }
            Expr::Call { name, args } => {
                if name == "print_i64" {
                    return Err("print_i64 can only be used as a statement".into());
                }
                let signature = self
                    .signatures
                    .get(name)
                    .cloned()
                    .ok_or_else(|| format!("Unknown function: {name}"))?;
                if args.len() != signature.params.len() {
                    return Err(format!("Wrong argument count for {name}"));
                }
                let mut arguments = Vec::new();
                let mut uses = Vec::new();
                for (expression, expected) in args.iter().zip(signature.params.iter()) {
                    let value = self.expression(expression)?;
                    self.require(value.ty, *expected, "call argument")?;
                    arguments.push(format!("{} {}", value.ty.llvm(), value.text));
                    uses.extend(value.id);
                }
                Ok(self.instruction(
                    signature.result,
                    format!(
                        "call {} @r_{name}({})",
                        signature.result.llvm(),
                        arguments.join(", ")
                    ),
                    uses,
                    false,
                ))
            }
            Expr::Unary { op, value } => {
                let value = self.expression(value)?;
                match op.as_str() {
                    "-" => {
                        self.require(value.ty, Ty::I64, "unary minus")?;
                        Ok(self.instruction(
                            Ty::I64,
                            format!("sub i64 0, {}", value.text),
                            operand_ids(&[&value]),
                            true,
                        ))
                    }
                    "!" => Ok(self.instruction(
                        value.ty,
                        format!(
                            "xor {} {}, {}",
                            value.ty.llvm(),
                            value.text,
                            if value.ty == Ty::Bool { "true" } else { "-1" }
                        ),
                        operand_ids(&[&value]),
                        true,
                    )),
                    _ => Err(format!("Unsupported unary operator: {op}")),
                }
            }
            Expr::Binary { op, left, right } if op == "&&" || op == "||" => {
                self.short_circuit(op, left, right)
            }
            Expr::Binary { op, left, right } => {
                let left = self.expression(left)?;
                let right = self.expression(right)?;
                self.require(right.ty, left.ty, "binary operands")?;
                match op.as_str() {
                    "==" | "!=" => Ok(self.instruction(
                        Ty::Bool,
                        format!(
                            "icmp {} {} {}, {}",
                            if op == "==" { "eq" } else { "ne" },
                            left.ty.llvm(),
                            left.text,
                            right.text
                        ),
                        operand_ids(&[&left, &right]),
                        true,
                    )),
                    "<" | "<=" | ">" | ">=" => {
                        self.require(left.ty, Ty::I64, "comparison")?;
                        let predicate = match op.as_str() {
                            "<" => "slt",
                            "<=" => "sle",
                            ">" => "sgt",
                            _ => "sge",
                        };
                        Ok(self.instruction(
                            Ty::Bool,
                            format!("icmp {predicate} i64 {}, {}", left.text, right.text),
                            operand_ids(&[&left, &right]),
                            true,
                        ))
                    }
                    "&" | "|" | "^" => {
                        let instruction = match op.as_str() {
                            "&" => "and",
                            "|" => "or",
                            _ => "xor",
                        };
                        Ok(self.instruction(
                            left.ty,
                            format!(
                                "{instruction} {} {}, {}",
                                left.ty.llvm(),
                                left.text,
                                right.text
                            ),
                            operand_ids(&[&left, &right]),
                            true,
                        ))
                    }
                    "+" | "-" | "*" | "/" | "%" | "<<" | ">>" => {
                        self.require(left.ty, Ty::I64, "integer arithmetic")?;
                        if op == "/" || op == "%" {
                            self.guard_division(&left, &right);
                        }
                        let instruction = match op.as_str() {
                            "+" => "add",
                            "-" => "sub",
                            "*" => "mul",
                            "/" => "sdiv",
                            "%" => "srem",
                            "<<" => "shl",
                            _ => "ashr",
                        };
                        let right = if op == "<<" || op == ">>" {
                            self.instruction(
                                Ty::I64,
                                format!("and i64 {}, 63", right.text),
                                operand_ids(&[&right]),
                                true,
                            )
                        } else {
                            right
                        };
                        Ok(self.instruction(
                            Ty::I64,
                            format!("{instruction} i64 {}, {}", left.text, right.text),
                            operand_ids(&[&left, &right]),
                            true,
                        ))
                    }
                    _ => Err(format!("Unsupported binary operator: {op}")),
                }
            }
        }
    }
    fn short_circuit(&mut self, op: &str, left: &Expr, right: &Expr) -> Result<Value, String> {
        let left = self.expression(left)?;
        self.require(left.ty, Ty::Bool, "boolean operand")?;
        let left_block = self.current_label.clone();
        let rhs = self.label();
        let end = self.label();
        if op == "&&" {
            self.conditional(&left, &rhs, &end);
        } else {
            self.conditional(&left, &end, &rhs);
        }
        self.start_block(&rhs);
        let right = self.expression(right)?;
        self.require(right.ty, Ty::Bool, "boolean operand")?;
        let right_block = self.current_label.clone();
        self.branch(&end);
        self.start_block(&end);
        let constant = if op == "&&" { "false" } else { "true" };
        // A phi reads its incoming value on the predecessor edge, not in the
        // merge block. The constant incoming value needs no liveness bit.
        self.phi_labels
            .push((right_block.clone(), end, operand_ids(&[&right])));
        let value = self.instruction(
            Ty::Bool,
            format!(
                "phi i1 [{constant}, %{left_block}], [{}, %{right_block}]",
                right.text
            ),
            vec![],
            true,
        );
        self.blocks
            .last_mut()
            .unwrap()
            .instructions
            .last_mut()
            .unwrap()
            .is_phi = true;
        Ok(value)
    }
    fn guard_division(&mut self, left: &Value, right: &Value) {
        let zero = self.instruction(
            Ty::Bool,
            format!("icmp eq i64 {}, 0", right.text),
            operand_ids(&[right]),
            true,
        );
        let minimum = self.instruction(
            Ty::Bool,
            format!("icmp eq i64 {}, -9223372036854775808", left.text),
            operand_ids(&[left]),
            true,
        );
        let negative_one = self.instruction(
            Ty::Bool,
            format!("icmp eq i64 {}, -1", right.text),
            operand_ids(&[right]),
            true,
        );
        let overflow = self.instruction(
            Ty::Bool,
            format!("and i1 {}, {}", minimum.text, negative_one.text),
            operand_ids(&[&minimum, &negative_one]),
            true,
        );
        let invalid = self.instruction(
            Ty::Bool,
            format!("or i1 {}, {}", zero.text, overflow.text),
            operand_ids(&[&zero, &overflow]),
            true,
        );
        let trap = self.label();
        let valid = self.label();
        self.conditional(&invalid, &trap, &valid);
        self.start_block(&trap);
        self.line("call void @llvm.trap()".into(), vec![]);
        self.line("unreachable".into(), vec![]);
        self.terminated = true;
        self.start_block(&valid);
    }
}
