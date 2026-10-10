// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! A strict frontend for the lab's explicit Rust subset.
//!
//! Scalar i64/bool functions, lexical locals, calls, conditionals and loops are
//! supported. This is not a parser for full Rust. Unsupported syntax is rejected
//! with a source location, before the backend receives a typed program.

use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Type {
    I64,
    Bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Program {
    pub functions: Vec<Function>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Function {
    pub name: String,
    pub params: Vec<(String, Type)>,
    pub return_type: Type,
    pub body: Vec<Stmt>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Stmt {
    Let {
        name: String,
        ty: Option<Type>,
        mutable: bool,
        value: Expr,
    },
    Assign {
        name: String,
        value: Expr,
    },
    If {
        condition: Expr,
        then_body: Vec<Stmt>,
        else_body: Vec<Stmt>,
    },
    While {
        condition: Expr,
        body: Vec<Stmt>,
    },
    Return(Expr),
    Expr(Expr),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    Int(i64),
    Bool(bool),
    Var(String),
    Call {
        name: String,
        args: Vec<Expr>,
    },
    Unary {
        op: String,
        value: Box<Expr>,
    },
    Binary {
        op: String,
        left: Box<Expr>,
        right: Box<Expr>,
    },
}

#[derive(Clone, Debug, PartialEq)]
enum Kind {
    Ident(String),
    Number(u64),
    Symbol(String),
    End,
}

#[derive(Clone, Debug)]
struct Token {
    kind: Kind,
    offset: usize,
}

fn location(source: &str, offset: usize, message: &str) -> String {
    let prefix = &source[..offset.min(source.len())];
    let line = prefix.bytes().filter(|&b| b == b'\n').count() + 1;
    let column = prefix.rsplit('\n').next().unwrap_or("").chars().count() + 1;
    format!("line {line}, column {column}: {message}")
}

fn lex(source: &str) -> Result<Vec<Token>, String> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if bytes[i..].starts_with(b"//") {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if bytes[i..].starts_with(b"/*") {
            let start = i;
            i += 2;
            let mut depth = 1;
            while i < bytes.len() && depth > 0 {
                if bytes[i..].starts_with(b"/*") {
                    depth += 1;
                    i += 2;
                } else if bytes[i..].starts_with(b"*/") {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if depth != 0 {
                return Err(location(source, start, "unterminated block comment"));
            }
            continue;
        }
        let start = i;
        let kind = if bytes[i].is_ascii_alphabetic() || bytes[i] == b'_' {
            i += 1;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            Kind::Ident(source[start..i].to_owned())
        } else if bytes[i].is_ascii_digit() {
            i += 1;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'_') {
                i += 1;
            }
            if i < bytes.len() && bytes[i].is_ascii_alphabetic() {
                return Err(location(
                    source,
                    start,
                    "only decimal i64 literals without suffixes are supported",
                ));
            }
            let number = source[start..i]
                .replace('_', "")
                .parse::<u64>()
                .map_err(|_| location(source, start, "integer literal exceeds the i64 range"))?;
            if number > i64::MAX as u64 + 1 {
                return Err(location(
                    source,
                    start,
                    "integer literal exceeds the i64 range",
                ));
            }
            Kind::Number(number)
        } else {
            let two = if i + 1 < bytes.len() {
                &bytes[i..i + 2]
            } else {
                &[]
            };
            let multi = match two {
                b"->" => Some("->"),
                b"==" => Some("=="),
                b"!=" => Some("!="),
                b"<=" => Some("<="),
                b">=" => Some(">="),
                b"&&" => Some("&&"),
                b"||" => Some("||"),
                b"<<" => Some("<<"),
                b">>" => Some(">>"),
                b"+=" => Some("+="),
                b"-=" => Some("-="),
                b"*=" => Some("*="),
                b"/=" => Some("/="),
                b"%=" => Some("%="),
                b"&=" => Some("&="),
                b"|=" => Some("|="),
                b"^=" => Some("^="),
                b"::" => {
                    return Err(location(
                        source,
                        start,
                        "paths and associated methods are outside the supported Rust subset",
                    ))
                }
                _ => None,
            };
            if let Some(symbol) = multi {
                i += 2;
                Kind::Symbol(symbol.to_owned())
            } else if b"(){}:,;=+-*/%!&|^<>".contains(&bytes[i]) {
                i += 1;
                Kind::Symbol((bytes[start] as char).to_string())
            } else {
                return Err(location(source, start,
                    "unsupported syntax; references, strings, attributes, macros, arrays and full Rust types are not supported"));
            }
        };
        tokens.push(Token {
            kind,
            offset: start,
        });
    }
    tokens.push(Token {
        kind: Kind::End,
        offset: source.len(),
    });
    Ok(tokens)
}

struct Parser<'a> {
    source: &'a str,
    tokens: Vec<Token>,
    cursor: usize,
}

impl Parser<'_> {
    fn token(&self) -> &Kind {
        &self.tokens[self.cursor].kind
    }
    fn error(&self, message: &str) -> String {
        location(self.source, self.tokens[self.cursor].offset, message)
    }
    fn is(&self, text: &str) -> bool {
        matches!(self.token(), Kind::Ident(value) | Kind::Symbol(value) if value == text)
    }
    fn take(&mut self, text: &str) -> bool {
        if self.is(text) {
            self.cursor += 1;
            true
        } else {
            false
        }
    }
    fn expect(&mut self, text: &str) -> Result<(), String> {
        if self.take(text) {
            Ok(())
        } else {
            Err(self.error(&format!("expected '{text}'")))
        }
    }
    fn identifier(&mut self) -> Result<String, String> {
        match self.token().clone() {
            Kind::Ident(name) if !is_keyword(&name) && name != "_" => {
                self.cursor += 1;
                Ok(name)
            }
            _ => Err(self.error("expected an identifier")),
        }
    }
    fn ty(&mut self) -> Result<Type, String> {
        if self.take("i64") {
            Ok(Type::I64)
        } else if self.take("bool") {
            Ok(Type::Bool)
        } else {
            Err(self.error("only i64 and bool types are supported"))
        }
    }
    fn program(&mut self) -> Result<Program, String> {
        let mut functions = Vec::new();
        while self.token() != &Kind::End {
            if !self.take("fn") {
                return Err(self
                    .error("expected a function: fn name(...); other Rust items are unsupported"));
            }
            let name = self.identifier()?;
            self.expect("(")?;
            let mut params = Vec::new();
            if !self.take(")") {
                loop {
                    let parameter = self.identifier()?;
                    self.expect(":")?;
                    params.push((parameter, self.ty()?));
                    if self.take(")") {
                        break;
                    }
                    self.expect(",")?;
                    if self.take(")") {
                        break;
                    }
                }
            }
            let explicit_return_type = self.take("->");
            let return_type = if explicit_return_type {
                self.ty()?
            } else if name == "main" {
                Type::I64
            } else {
                return Err(
                    self.error("non-main functions need an explicit -> i64 or -> bool return type")
                );
            };
            let mut body = self.block(true)?;
            if name == "main" && !explicit_return_type && !always_returns(&body) {
                body.push(Stmt::Return(Expr::Int(0)));
            }
            functions.push(Function {
                name,
                params,
                return_type,
                body,
            });
        }
        if functions.is_empty() {
            return Err(self.error("source contains no functions"));
        }
        Ok(Program { functions })
    }
    fn block(&mut self, allow_tail: bool) -> Result<Vec<Stmt>, String> {
        self.expect("{")?;
        let mut body = Vec::new();
        while !self.take("}") {
            if self.token() == &Kind::End {
                return Err(self.error("unterminated block"));
            }
            if self.take("let") {
                let mutable = self.take("mut");
                let name = self.identifier()?;
                let ty = if self.take(":") {
                    Some(self.ty()?)
                } else {
                    None
                };
                self.expect("=")?;
                let value = self.expr(0)?;
                self.expect(";")?;
                body.push(Stmt::Let {
                    name,
                    ty,
                    mutable,
                    value,
                });
            } else if self.take("while") {
                let condition = self.expr(0)?;
                let loop_body = self.block(false)?;
                body.push(Stmt::While {
                    condition,
                    body: loop_body,
                });
            } else if self.take("if") {
                body.push(self.if_statement()?);
            } else if self.take("return") {
                let value = self.expr(0)?;
                self.expect(";")?;
                body.push(Stmt::Return(value));
            } else {
                // Assignment is a statement in this subset, never an expression.
                let assignment = matches!(self.token(), Kind::Ident(_))
                    && matches!(&self.tokens[self.cursor + 1].kind, Kind::Symbol(op)
                        if matches!(op.as_str(), "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "&=" | "|=" | "^="));
                if assignment {
                    let name = self.identifier()?;
                    let op = match self.token().clone() {
                        Kind::Symbol(op) => op,
                        _ => unreachable!(),
                    };
                    self.cursor += 1;
                    let mut value = self.expr(0)?;
                    if op != "=" {
                        value = Expr::Binary {
                            op: op[..1].to_owned(),
                            left: Box::new(Expr::Var(name.clone())),
                            right: Box::new(value),
                        };
                    }
                    self.expect(";")?;
                    body.push(Stmt::Assign { name, value });
                } else {
                    let value = self.expr(0)?;
                    if self.take(";") {
                        body.push(Stmt::Expr(value));
                    } else if allow_tail && self.take("}") {
                        body.push(Stmt::Return(value));
                        return Ok(body);
                    } else {
                        return Err(self.error("expected ';'; implicit tail values are supported only in function bodies"));
                    }
                }
            }
        }
        Ok(body)
    }
    fn if_statement(&mut self) -> Result<Stmt, String> {
        let condition = self.expr(0)?;
        let then_body = self.block(false)?;
        let else_body = if self.take("else") {
            if self.take("if") {
                vec![self.if_statement()?]
            } else {
                self.block(false)?
            }
        } else {
            Vec::new()
        };
        Ok(Stmt::If {
            condition,
            then_body,
            else_body,
        })
    }
    fn expr(&mut self, minimum: u8) -> Result<Expr, String> {
        let mut left = if self.take("-") {
            if let Kind::Number(value) = self.token() {
                if *value == i64::MAX as u64 + 1 {
                    self.cursor += 1;
                    Expr::Int(i64::MIN)
                } else {
                    Expr::Unary {
                        op: "-".to_owned(),
                        value: Box::new(self.expr(10)?),
                    }
                }
            } else {
                Expr::Unary {
                    op: "-".to_owned(),
                    value: Box::new(self.expr(10)?),
                }
            }
        } else if self.take("!") {
            Expr::Unary {
                op: "!".to_owned(),
                value: Box::new(self.expr(10)?),
            }
        } else if self.take("(") {
            let inner = self.expr(0)?;
            self.expect(")")?;
            inner
        } else {
            match self.token().clone() {
                Kind::Number(value) if value <= i64::MAX as u64 => {
                    self.cursor += 1;
                    Expr::Int(value as i64)
                }
                Kind::Number(_) => return Err(self.error("positive integer literal exceeds i64::MAX")),
                Kind::Ident(value) if value == "true" || value == "false" => {
                    self.cursor += 1;
                    Expr::Bool(value == "true")
                }
                Kind::Ident(_) => {
                    let name = self.identifier()?;
                    if self.is("!") { return Err(self.error("macros are outside the supported Rust subset")); }
                    if self.take("(") {
                        let mut args = Vec::new();
                        if !self.take(")") {
                            loop {
                                args.push(self.expr(0)?);
                                if self.take(")") { break; }
                                self.expect(",")?;
                                if self.take(")") { break; }
                            }
                        }
                        Expr::Call { name, args }
                    } else { Expr::Var(name) }
                }
                _ => return Err(self.error("expected a scalar expression; references and other Rust expressions are unsupported")),
            }
        };
        let mut compared = false;
        loop {
            let op = match self.token() {
                Kind::Symbol(op) => op.clone(),
                _ => break,
            };
            let precedence = match op.as_str() {
                "||" => 1,
                "&&" => 2,
                "==" | "!=" | "<" | "<=" | ">" | ">=" => 3,
                "|" => 4,
                "^" => 5,
                "&" => 6,
                "<<" | ">>" => 7,
                "+" | "-" => 8,
                "*" | "/" | "%" => 9,
                _ => break,
            };
            if precedence < minimum {
                break;
            }
            if precedence == 3 && compared {
                return Err(
                    self.error("comparison operators cannot be chained without parentheses")
                );
            }
            if precedence == 3 {
                compared = true;
            }
            self.cursor += 1;
            let right = self.expr(precedence + 1)?;
            left = Expr::Binary {
                op,
                left: Box::new(left),
                right: Box::new(right),
            };
        }
        Ok(left)
    }
}

fn is_keyword(name: &str) -> bool {
    matches!(
        name,
        "fn" | "let"
            | "mut"
            | "while"
            | "if"
            | "else"
            | "return"
            | "true"
            | "false"
            | "break"
            | "continue"
            | "for"
            | "loop"
            | "match"
            | "struct"
            | "enum"
            | "impl"
            | "trait"
            | "use"
            | "pub"
            | "const"
            | "static"
            | "unsafe"
            | "async"
            | "await"
            | "move"
            | "ref"
            | "self"
            | "Self"
            | "as"
            | "crate"
            | "dyn"
            | "extern"
            | "in"
            | "mod"
            | "super"
            | "type"
            | "where"
            | "abstract"
            | "become"
            | "box"
            | "do"
            | "final"
            | "gen"
            | "macro"
            | "override"
            | "priv"
            | "try"
            | "typeof"
            | "unsized"
            | "virtual"
            | "yield"
    )
}

fn always_returns(body: &[Stmt]) -> bool {
    body.iter().any(|statement| match statement {
        Stmt::Return(_) => true,
        Stmt::If {
            then_body,
            else_body,
            ..
        } => !else_body.is_empty() && always_returns(then_body) && always_returns(else_body),
        _ => false,
    })
}

#[derive(Clone, Copy)]
struct Binding {
    ty: Type,
    mutable: bool,
}
type Signatures = HashMap<String, (Vec<Type>, Type)>;

struct Checker<'a> {
    signatures: &'a Signatures,
    scopes: Vec<HashMap<String, Binding>>,
    declared: HashSet<String>,
    return_type: Type,
    function: &'a str,
}

impl Checker<'_> {
    fn error(&self, message: impl AsRef<str>) -> String {
        format!("function '{}': {}", self.function, message.as_ref())
    }
    fn lookup(&self, name: &str) -> Result<Binding, String> {
        self.scopes
            .iter()
            .rev()
            .find_map(|scope| scope.get(name).copied())
            .ok_or_else(|| self.error(format!("unknown or out-of-scope local '{name}'")))
    }
    fn expression(&self, expr: &Expr) -> Result<Type, String> {
        match expr {
            Expr::Int(_) => Ok(Type::I64),
            Expr::Bool(_) => Ok(Type::Bool),
            Expr::Var(name) => Ok(self.lookup(name)?.ty),
            Expr::Call { name, args } => {
                if self.scopes.iter().any(|scope| scope.contains_key(name)) {
                    return Err(self.error(format!(
                        "scalar local '{name}' shadows the function and cannot be called"
                    )));
                }
                if name == "print_i64" {
                    return Err(
                        self.error("print_i64 has no value and is only supported as a statement")
                    );
                }
                let (parameters, result) = self
                    .signatures
                    .get(name)
                    .ok_or_else(|| self.error(format!("unknown function '{name}'")))?;
                if args.len() != parameters.len() {
                    return Err(self.error(format!(
                        "function '{name}' expects {} arguments, got {}",
                        parameters.len(),
                        args.len()
                    )));
                }
                for (argument, expected) in args.iter().zip(parameters) {
                    let actual = self.expression(argument)?;
                    if actual != *expected {
                        return Err(self.error(format!(
                            "argument to '{name}' has type {actual:?}, expected {expected:?}"
                        )));
                    }
                }
                Ok(*result)
            }
            Expr::Unary { op, value } => {
                let ty = self.expression(value)?;
                match (op.as_str(), ty) {
                    ("-", Type::I64) => Ok(Type::I64),
                    ("!", Type::Bool) => Ok(Type::Bool),
                    ("!", Type::I64) => Ok(Type::I64),
                    _ => Err(self.error(format!("unary '{op}' is invalid for {ty:?}"))),
                }
            }
            Expr::Binary { op, left, right } => {
                let lhs = self.expression(left)?;
                let rhs = self.expression(right)?;
                match op.as_str() {
                    "&&" | "||" if lhs == Type::Bool && rhs == Type::Bool => Ok(Type::Bool),
                    "==" | "!=" if lhs == rhs => Ok(Type::Bool),
                    "<" | "<=" | ">" | ">=" if lhs == Type::I64 && rhs == Type::I64 => {
                        Ok(Type::Bool)
                    }
                    "&" | "|" | "^" if lhs == rhs => Ok(lhs),
                    "+" | "-" | "*" | "/" | "%" | "<<" | ">>"
                        if lhs == Type::I64 && rhs == Type::I64 =>
                    {
                        Ok(Type::I64)
                    }
                    _ => Err(self.error(format!(
                        "operator '{op}' is invalid for {lhs:?} and {rhs:?}"
                    ))),
                }
            }
        }
    }
    fn body(&mut self, body: &[Stmt]) -> Result<(), String> {
        self.scopes.push(HashMap::new());
        for statement in body {
            match statement {
                Stmt::Let {
                    name,
                    ty,
                    mutable,
                    value,
                } => {
                    let actual = self.expression(value)?;
                    if let Some(expected) = ty {
                        if actual != *expected {
                            return Err(self.error(format!(
                                "local '{name}' has type {actual:?}, annotated {expected:?}"
                            )));
                        }
                    }
                    // Reusing spelling needs binder IDs in the backend; reject
                    // shadowing until that representation is implemented.
                    if !self.declared.insert(name.clone()) {
                        return Err(self.error(format!(
                            "local shadowing/redeclaration of '{name}' is not supported"
                        )));
                    }
                    self.scopes.last_mut().unwrap().insert(
                        name.clone(),
                        Binding {
                            ty: actual,
                            mutable: *mutable,
                        },
                    );
                }
                Stmt::Assign { name, value } => {
                    let binding = self.lookup(name)?;
                    if !binding.mutable {
                        return Err(self.error(format!(
                            "cannot assign to immutable local '{name}'; use let mut"
                        )));
                    }
                    if self.expression(value)? != binding.ty {
                        return Err(self.error(format!("assignment changes the type of '{name}'")));
                    }
                }
                Stmt::If {
                    condition,
                    then_body,
                    else_body,
                } => {
                    if self.expression(condition)? != Type::Bool {
                        return Err(self.error("if condition must be bool"));
                    }
                    self.body(then_body)?;
                    self.body(else_body)?;
                }
                Stmt::While { condition, body } => {
                    if self.expression(condition)? != Type::Bool {
                        return Err(self.error("while condition must be bool"));
                    }
                    self.body(body)?;
                }
                Stmt::Return(value) => {
                    if self.expression(value)? != self.return_type {
                        return Err(self.error("return value has the wrong type"));
                    }
                }
                Stmt::Expr(Expr::Call { name, args }) if name == "print_i64" => {
                    if self.scopes.iter().any(|scope| scope.contains_key(name)) {
                        return Err(self.error("scalar local 'print_i64' cannot be called"));
                    }
                    if args.len() != 1 || self.expression(&args[0])? != Type::I64 {
                        return Err(self.error("print_i64 expects one i64 argument"));
                    }
                }
                Stmt::Expr(expr) => {
                    self.expression(expr)?;
                }
            }
        }
        self.scopes.pop();
        Ok(())
    }
}

fn validate(program: &Program) -> Result<(), String> {
    let mut signatures = Signatures::new();
    for function in &program.functions {
        if function.name == "print_i64" {
            return Err("print_i64 is a reserved host builtin".to_owned());
        }
        if signatures
            .insert(
                function.name.clone(),
                (
                    function.params.iter().map(|(_, ty)| *ty).collect(),
                    function.return_type,
                ),
            )
            .is_some()
        {
            return Err(format!("duplicate function '{}'", function.name));
        }
        if function.name == "main" && !function.params.is_empty() {
            return Err("the experimental main entry must have no parameters".to_owned());
        }
    }
    for function in &program.functions {
        let mut parameters = HashMap::new();
        for (name, ty) in &function.params {
            if parameters
                .insert(
                    name.clone(),
                    Binding {
                        ty: *ty,
                        mutable: false,
                    },
                )
                .is_some()
            {
                return Err(format!(
                    "function '{}': duplicate parameter '{name}'",
                    function.name
                ));
            }
        }
        let mut checker = Checker {
            signatures: &signatures,
            declared: parameters.keys().cloned().collect(),
            scopes: vec![parameters],
            return_type: function.return_type,
            function: &function.name,
        };
        checker.body(&function.body)?;
        if !always_returns(&function.body) {
            return Err(format!(
                "function '{}': every path must return {:?}",
                function.name, function.return_type
            ));
        }
    }
    Ok(())
}

pub fn parse(source: &str) -> Result<Program, String> {
    let tokens = lex(source)?;
    let program = Parser {
        source,
        tokens,
        cursor: 0,
    }
    .program()?;
    validate(&program)?;
    Ok(program)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_functions_loops_calls_compound_assignments_and_tail_values() {
        let source = r#"
            fn sum(n: i64) -> i64 {
                let mut i = 0;
                let mut result: i64 = 0;
                while i < n { result += i; i += 1; }
                result
            }
            fn positive(n: i64) -> bool { return n > 0; }
            fn main() -> i64 {
                let answer = sum(10);
                if positive(answer) && answer == 45 { print_i64(answer); }
                else { print_i64(-1); }
                return 0;
            }
        "#;
        let program = parse(source).unwrap();
        assert_eq!(program.functions.len(), 3);
        assert!(
            matches!(program.functions[0].body.last(), Some(Stmt::Return(Expr::Var(name))) if name == "result")
        );
        assert!(matches!(program.functions[0].body[2], Stmt::While { .. }));
    }

    #[test]
    fn pratt_precedence_and_short_circuit_ast_are_preserved() {
        let program = parse("fn f() -> bool { 1 + 2 * 3 == 7 || false && true }").unwrap();
        let Stmt::Return(Expr::Binary { op, left, right }) = &program.functions[0].body[0] else {
            panic!()
        };
        assert_eq!(op, "||");
        assert!(matches!(&**right, Expr::Binary { op, .. } if op == "&&"));
        let Expr::Binary { left: addition, .. } = &**left else {
            panic!()
        };
        assert!(matches!(&**addition, Expr::Binary { op, right, .. }
            if op == "+" && matches!(&**right, Expr::Binary { op, .. } if op == "*")));
    }

    #[test]
    fn integer_bounds_and_nested_comments() {
        let program =
            parse("/* outer /* nested */ */ fn f() -> i64 { -9223372036854775808 }").unwrap();
        assert!(matches!(
            program.functions[0].body[0],
            Stmt::Return(Expr::Int(i64::MIN))
        ));
        assert!(parse("fn f() -> i64 { 9223372036854775808 }").is_err());
        assert!(parse("fn f() -> i64 { 18446744073709551616 }").is_err());
        assert!(parse("/* open").unwrap_err().contains("unterminated"));
    }

    #[test]
    fn main_without_return_annotation_uses_host_wrapper_zero() {
        let program = parse("fn main() { print_i64(42); }").unwrap();
        assert!(matches!(
            program.functions[0].body.last(),
            Some(Stmt::Return(Expr::Int(0)))
        ));
    }

    #[test]
    fn validates_mutability_types_scope_calls_and_return_paths() {
        for source in [
            "fn main() { let x = 1; x = 2; }",
            "fn main() { let mut x = 1; x = true; }",
            "fn main() { let x: bool = 1; }",
            "fn main() { while 1 { print_i64(0); } }",
            "fn main() { if true { let x = 1; } print_i64(x); }",
            "fn main() { print_i64(true); }",
            "fn main() { let x = print_i64(1); }",
            "fn main() { missing(1); }",
            "fn f(x: bool) -> i64 { 1 } fn main() { f(2); }",
            "fn f(x: i64) -> i64 { x } fn main() { f(); }",
            "fn f() -> i64 { 1 } fn main() { let f = 1; f(); }",
            "fn main() { let print_i64 = 1; print_i64(2); }",
            "fn f(x: bool) -> i64 { if x { return 1; } }",
            "fn main() { let x = 1; let x = 2; }",
            "fn f(x: i64, x: i64) -> i64 { x }",
            "fn f() -> i64 { 1 } fn f() -> i64 { 2 }",
            "fn main() -> i64 { print_i64(42); }",
        ] {
            assert!(
                parse(source).is_err(),
                "accepted invalid subset source: {source}"
            );
        }
        parse("fn f(x: bool) -> i64 { if x { return 1; } else { return 2; } }").unwrap();
        parse("fn main() -> bool { true }").unwrap();
    }

    #[test]
    fn rejects_features_instead_of_claiming_full_rust() {
        for source in [
            "fn main() { println!(1); }",
            "fn f(x: &i64) -> i64 { 0 }",
            "fn f() -> i32 { 1 }",
            "fn main() { let x = &1; }",
            "fn main() { let x = [1, 2]; }",
            "fn main() { let x = 1u64; }",
            "fn main() { let x = 0xff; }",
            "fn main() { let x = 1.wrapping_add(2); }",
            "fn main() { let x = 1 < 2 < 3; }",
            "fn main() { break; }",
            "struct Thing { x: i64 }",
            "fn type() -> i64 { 1 }",
        ] {
            assert!(
                parse(source).is_err(),
                "accepted unsupported Rust: {source}"
            );
        }
    }
}
