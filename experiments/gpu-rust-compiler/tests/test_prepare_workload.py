# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import importlib.util
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'prepare_workload.py'
SPEC = importlib.util.spec_from_file_location('prepare_workload', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def function(ir):
    return MODULE.parse_llvm_ir(ir)['functions'][0]


def live_in(fn):
    """Independent set worklist oracle, preserving edge uses explicitly."""
    incoming = [set() for _ in fn['blocks']]
    pending = list(range(len(incoming)))
    predecessors = [[] for _ in incoming]
    for i, block in enumerate(fn['blocks']):
        for succ in block['successors']:
            predecessors[succ].append(i)
    edges = {}
    for edge in fn['phi_edge_uses']:
        edges[(edge['from'], edge['to'])] = set(edge['values'])
    while pending:
        i = pending.pop()
        block = fn['blocks'][i]
        out = set()
        for succ in block['successors']:
            out |= incoming[succ] | edges.get((i, succ), set())
        new = set(block['use']) | (out - set(block['def']))
        if new != incoming[i]:
            incoming[i] = new
            pending.extend(predecessors[i])
    return incoming


class ExtractionTests(unittest.TestCase):
    def test_implicit_entry_and_return_use(self):
        fn = function('''
define i32 @increment(i32 %0) {
  %2 = add i32 %0, 1
  ret i32 %2
}
''')
        self.assertEqual(fn['blocks'], [{'name': '1', 'successors': [], 'use': [0], 'def': [1]}])
        self.assertEqual(live_in(fn), [{0}])

    def test_phi_is_edge_use_and_predecessor_definition_kills_it(self):
        fn = function('''
define i32 @diamond(i1 %c, i32 %x, i32 %y) {
entry:
  br i1 %c, label %left, label %right
left:
  %a = add i32 %x, 1
  br label %join
right:
  %b = add i32 %y, 2
  br label %join
join:
  %p = phi i32 [ %a, %left ], [ %b, %right ]
  ret i32 %p
}
''')
        self.assertEqual(fn['phi_edge_uses'], [
            {'from': 1, 'to': 3, 'values': [3]}, {'from': 2, 'to': 3, 'values': [4]}])
        self.assertEqual(fn['blocks'][3]['use'], [])
        self.assertEqual(live_in(fn), [{0, 1, 2}, {1}, {2}, set()])
        folded = MODULE.fold_phi_edge_uses(fn)
        self.assertEqual(folded['blocks'][1]['use'], [1])
        self.assertEqual(folded['blocks'][2]['use'], [2])
        folded['phi_edge_uses'] = []
        self.assertEqual(live_in(folded), live_in(fn))

    def test_loop_phi_and_backedge(self):
        fn = function('''
define i32 @loop(i32 %n) {
entry:
  br label %loop
loop:
  %i = phi i32 [ 0, %entry ], [ %next, %loop ]
  %next = add i32 %i, 1
  %more = icmp slt i32 %next, %n
  br i1 %more, label %loop, label %exit
exit:
  ret i32 %next
}
''')
        self.assertEqual(fn['blocks'][1]['successors'], [1, 2])
        self.assertEqual(live_in(fn), [{0}, {0}, {2}])
        self.assertEqual(fn['phi_edge_uses'][-1], {'from': 1, 'to': 1, 'values': [2]})

    def test_array_type_phi_and_nested_constant(self):
        fn = function('''
define [2 x i32] @array_phi(i1 %c, [2 x i32] %arr) {
entry:
  br i1 %c, label %left, label %right
left:
  br label %join
right:
  br label %join
join:
  %p = phi [2 x i32] [ %arr, %left ], [ [i32 1, i32 2], %right ]
  ret [2 x i32] %p
}
''')
        self.assertEqual(fn['phi_edge_uses'], [
            {'from': 1, 'to': 3, 'values': [1]}, {'from': 2, 'to': 3, 'values': []}])
        self.assertEqual(live_in(fn), [{0, 1}, {1}, set(), set()])

    def test_quoted_names_escaped_semicolon_and_multiline_switch(self):
        fn = function('''
define i32 @"strange;function"(i32 %"x y") {
"first block":
  switch i32 %"x y", label %"default\\20block" [
    i32 1, label %"one;block"
  ]
"one;block":
  ret i32 %"x y"
"default block":
  ret i32 0
}
''')
        self.assertEqual(fn['name'], 'strange;function')
        self.assertEqual(fn['blocks'][0]['successors'], [2, 1])
        self.assertEqual(fn['blocks'][0]['use'], [0])

    def test_multiline_invoke_phi_return_value(self):
        fn = function('''
declare i32 @callee(i32)
define i32 @caller(i32 %x) personality ptr @personality {
entry:
  %r = invoke i32 @callee(i32 %x)
     to label %normal unwind label %unwind
normal:
  %p = phi i32 [ %r, %entry ]
  ret i32 %p
unwind:
  %error = landingpad { ptr, i32 }
     cleanup
  resume { ptr, i32 } %error
}
''')
        self.assertEqual(fn['blocks'][0]['successors'], [1, 2])
        self.assertEqual(live_in(fn), [{0}, set(), set()])

    def test_named_types_and_debug_records_are_not_runtime_uses(self):
        fn = function('''
%Thing = type { i32 }
define ptr @address(ptr %base, i32 %unused) {
entry:
  #dbg_value(i32 %unused, !1, !DIExpression(), !2)
  %field = getelementptr %Thing, ptr %base, i32 0, i32 0
  ret ptr %field
}
''')
        self.assertEqual(fn['blocks'][0]['use'], [0])

    def test_fail_closed(self):
        cases = [
            'define void @f() {\nentry:\n newop i32 1\n ret void\n}',
            'define void @f() {\nentry:\n br label %missing\n}',
            'define i32 @f() {\nentry:\n ret i32 %unknown\n}',
            'define void @f() {\nentry:\n call void @g()\n}',
            'define i32 @f() {\nentry:\n ret i32 0\nother:\n %p = phi i32 [ 1, %entry ]\n ret i32 %p\n}',
        ]
        for ir in cases:
            with self.subTest(ir=ir), self.assertRaises(MODULE.IRParseError):
                function(ir)

    @unittest.skipUnless(shutil.which('rustc'), 'rustc unavailable')
    def test_real_rustc_ir(self):
        source = '''
#[unsafe(no_mangle)]
pub fn branch_loop(xs: &[u32], threshold: u32) -> u32 {
    let mut sum = 0u32;
    for &x in xs {
        if x > threshold { sum = sum.wrapping_add(x); }
        else { sum ^= x.rotate_left(3); }
    }
    sum
}
'''
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'fixture.rs').write_text(source)
            for level in ['0', '2']:
                ir = root / f'fixture_{level}.ll'
                subprocess.run(['rustc', '--edition=2024', '--crate-type=lib', '--emit=llvm-ir',
                                '-C', f'opt-level={level}', '-o', str(ir), str(root / 'fixture.rs')],
                               check=True, capture_output=True, text=True)
                workload = MODULE.parse_llvm_ir(ir.read_text())
                self.assertTrue(workload['functions'])
                self.assertGreater(sum(len(f['blocks']) for f in workload['functions']), 1)
                for fn in workload['functions']:
                    folded = MODULE.fold_phi_edge_uses(fn)
                    folded['phi_edge_uses'] = []
                    self.assertEqual(live_in(folded), live_in(fn))


if __name__ == '__main__':
    unittest.main()
