/* SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. */
/* SPDX-License-Identifier: Apache-2.0 */

/* Exercise the actual library response path using a buffered server packet.
 * The request is already sent, so no SSH server or transport mock is needed. */
#include "libssh2_priv.h"
#include "libssh2_sftp.h"
#include "sftp.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void *packet_allocation;
static void *payload_allocation;
static int packet_freed;
static int payload_freed;

static void tracked_free(void *pointer, void **abstract)
{
    (void)abstract;
    if(pointer == packet_allocation)
        packet_freed++;
    if(pointer == payload_allocation)
        payload_freed++;
    free(pointer);
}

static int check_response(LIBSSH2_SESSION *session, const char *label,
                          const unsigned char *bytes, size_t length,
                          uint32_t request_id, int expected,
                          unsigned long expected_status,
                          const char *expected_target, unsigned int capacity)
{
    LIBSSH2_CHANNEL channel;
    LIBSSH2_SFTP sftp;
    LIBSSH2_SFTP_PACKET *packet;
    char target[32];
    int result;
    int failed;

    memset(&channel, 0, sizeof(channel));
    memset(&sftp, 0, sizeof(sftp));
    memset(target, 0x5a, sizeof(target));
    channel.session = session;
    sftp.channel = &channel;
    sftp.version = 3;
    sftp.symlink_state = libssh2_NB_state_sent;
    sftp.symlink_request_id = request_id;
    _libssh2_list_init(&sftp.packets);
    packet = LIBSSH2_ALLOC(session, sizeof(*packet));
    if(!packet)
        return 1;
    memset(packet, 0, sizeof(*packet));
    packet->data = LIBSSH2_ALLOC(session, length);
    if(!packet->data) {
        LIBSSH2_FREE(session, packet);
        return 1;
    }
    memcpy(packet->data, bytes, length);
    packet->data_len = length;
    packet->request_id = request_id;
    packet_allocation = packet;
    payload_allocation = packet->data;
    packet_freed = payload_freed = 0;
    _libssh2_list_add(&sftp.packets, &packet->node);
    result = libssh2_sftp_symlink_ex(&sftp, "x", 1, target, capacity,
                                    LIBSSH2_SFTP_READLINK);
    failed = result != expected ||
        libssh2_sftp_last_error(&sftp) != expected_status ||
        packet_freed != 1 || payload_freed != 1 ||
        _libssh2_list_first(&sftp.packets) != NULL;
    if(expected_target && strcmp(target, expected_target) != 0)
        failed = 1;
    if(!expected_target && target[0] != 0x5a)
        failed = 1;
    fprintf(stderr, "%s: %s (result=%d status=%lu frees=%d/%d)\n",
            failed ? "FAIL" : "PASS", label, result,
            libssh2_sftp_last_error(&sftp), packet_freed, payload_freed);
    packet_allocation = payload_allocation = NULL;
    return failed;
}

int main(void)
{
    /* Request IDs intentionally disagree with the status to expose field
     * confusion: successful request42, denied request0. */
    const unsigned char ok[] = {101, 0, 0, 0, 42, 0, 0, 0, 0};
    const unsigned char denied[] = {101, 0, 0, 0, 0, 0, 0, 0, 3};
    const unsigned char name[] = {
        104, 0, 0, 0, 42, 0, 0, 0, 1, 0, 0, 0, 6,
        't', 'a', 'r', 'g', 'e', 't'
    };
    const unsigned char empty_name[] = {104, 0, 0, 0, 42, 0, 0, 0, 0};
    LIBSSH2_SESSION *session;
    int failed = 0;
    size_t length;

    if(libssh2_init(LIBSSH2_INIT_NO_CRYPTO))
        return 1;
    session = libssh2_session_init_ex(NULL, tracked_free, NULL, NULL);
    if(!session)
        return 1;
    session->socket_state = LIBSSH2_SOCKET_CONNECTED;
    libssh2_session_set_blocking(session, 0);
    failed |= check_response(session, "STATUS success with nonzero request ID",
                             ok, sizeof(ok), 42, 0, 0, NULL, 32);
    failed |= check_response(session, "STATUS denial with zero request ID",
                             denied, sizeof(denied), 0,
                             LIBSSH2_ERROR_SFTP_PROTOCOL, 3, NULL, 32);
    for(length = 5; length < sizeof(ok); length++)
        failed |= check_response(session, "truncated STATUS",
                                 ok, length, 42,
                                 LIBSSH2_ERROR_SFTP_PROTOCOL, 0, NULL, 32);
    failed |= check_response(session, "NAME target",
                             name, sizeof(name), 42, 6, 0, "target", 32);
    failed |= check_response(session, "NAME zero entries",
                             empty_name, sizeof(empty_name), 42,
                             LIBSSH2_ERROR_SFTP_PROTOCOL, 0, NULL, 32);
    failed |= check_response(session, "NAME truncated target",
                             name, sizeof(name) - 1, 42,
                             LIBSSH2_ERROR_SFTP_PROTOCOL, 0, NULL, 32);
    failed |= check_response(session, "NAME target buffer lacks terminator",
                             name, sizeof(name), 42,
                             LIBSSH2_ERROR_BUFFER_TOO_SMALL, 0, NULL, 6);
    libssh2_session_free(session);
    libssh2_exit();
    return failed ? 1 : 0;
}
