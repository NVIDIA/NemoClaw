-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
-- SPDX-License-Identifier: Apache-2.0
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
-- http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.

-- PDF/LaTeX fixes for pandoc: wrapped table columns + breakable long paths in \texttt.
-- listings + pdflatex choke on Unicode in code blocks; normalize before LaTeX.

function CodeBlock(block)
  block.text = block.text
    :gsub("\u{2019}", "'")
    :gsub("\u{2018}", "'")
    :gsub("\u{201c}", '"')
    :gsub("\u{201d}", '"')
    :gsub("\u{2014}", "--")
    :gsub("\u{2013}", "-")
    :gsub("\u{00d7}", " x ")
    :gsub("\u{00a0}", " ")
    :gsub("\u{2192}", "->") -- Unicode arrow (listings + pdflatex)
  return block
end

function Table(tbl)
  local specs = tbl.colspecs
  if not specs or #specs == 0 then
    return tbl
  end
  local n = #specs
  local w = 1.0 / n
  for i, spec in ipairs(specs) do
    local align = spec[1]
    -- Second field: fraction of \linewidth (pandoc LaTeX writer)
    tbl.colspecs[i] = { align, w }
  end
  return tbl
end

-- Long path-like inline code does not wrap in LaTeX \texttt; add \allowbreak after each /.
-- (Inline Code has no .format; do not gate on el.format — nil ~= "" is true in Lua and would skip all.)
function Code(el)
  local t = el.text
  if not t:find("/", 1, true) then
    return nil
  end
  if #t < 32 and not t:match("/home/") and not t:match("%.sh") then
    return nil
  end
  local out = t
    :gsub("\\", "\\textbackslash{}")
    :gsub("_", "\\_")
    :gsub("{", "\\{")
    :gsub("}", "\\}")
    :gsub("%$", "\\$")
    :gsub("#", "\\#")
    :gsub("%^", "\\textasciicircum{}")
    :gsub("&", "\\&")
    :gsub("%%", "\\%")
  out = out:gsub("/", "/\\allowbreak ")
  return pandoc.RawInline("latex", "\\texttt{" .. out .. "}")
end
