/* SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. */
/* SPDX-License-Identifier: Apache-2.0 */

#include "gzguts.h"
#include <stdint.h>
#include <stdio.h>

/* Inspect the invariant before attempting another write, so the unpatched
 * negative control fails without deliberately corrupting memory. */
static int check_write_error(const char *mode) {
    unsigned char input[131072];
    uint32_t random = 1;
    unsigned i;
    int error;
    gzFile file;
    gz_statep state;
    for (i = 0; i < sizeof(input); i++) {
        random ^= random << 13;
        random ^= random >> 17;
        random ^= random << 5;
        input[i] = (unsigned char)random;
    }
    file = gzopen("/dev/full", mode);
    if (file == NULL)
        return 1;
    if (gzwrite(file, input, sizeof(input)) != 0)
        return 2;
    (void)gzerror(file, &error);
    if (error != Z_ERRNO)
        return 3;
    state = (gz_statep)file;
    if (state->strm.avail_in != 0 || state->strm.next_in != state->in) {
        fprintf(stderr, "failed write retained caller input (%s)\n", mode);
        (void)gzclose(file);
        return 4;
    }
    gzclearerr(file);
    if (gzwrite(file, "safe", 4) != 4 || gzputc(file, '!') != '!')
        return 5;
    /* /dev/full still fails when the buffered output is flushed. */
    if (gzclose(file) != Z_ERRNO)
        return 6;
    return 0;
}

int main(void) {
    int result = check_write_error("w");
    return result ? result : check_write_error("wT");
}
