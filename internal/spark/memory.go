// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package spark

import (
	"bufio"
	"errors"
	"io"
	"strconv"
	"strings"
)

func ReadMemory(r io.Reader) (Capacity, error) {
	var c Capacity
	values := map[string]*int64{"MemTotal:": &c.Total, "MemAvailable:": &c.Available, "MemFree:": &c.Free}
	s := bufio.NewScanner(r)
	seen := map[string]bool{}
	for s.Scan() {
		f := strings.Fields(s.Text())
		if len(f) == 0 {
			continue
		}
		if v, ok := values[f[0]]; ok {
			if len(f) != 3 || f[2] != "kB" || seen[f[0]] {
				return c, errors.New("incomplete host memory observation")
			}
			n, err := strconv.ParseInt(f[1], 10, 64)
			if err != nil || n < 0 || n > 1<<40 {
				return c, errors.New("invalid host memory observation")
			}
			*v = n * 1024
			seen[f[0]] = true
		}
	}
	if s.Err() != nil || len(seen) != 3 || c.Total == 0 || c.Available > c.Total || c.Free > c.Available {
		return c, errors.New("host memory observation failed")
	}
	return c, nil
}
