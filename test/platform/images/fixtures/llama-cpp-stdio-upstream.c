// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#include <arpa/inet.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int port_from_args(int argc, char **argv) {
  for (int index = 1; index + 1 < argc; index++) {
    if (strcmp(argv[index], "--port") == 0) {
      char *end = NULL;
      long port = strtol(argv[index + 1], &end, 10);
      if (end != argv[index + 1] && *end == '\0' && port > 0 && port <= 65535) {
        return (int)port;
      }
    }
  }
  return -1;
}

int main(int argc, char **argv) {
  int port = port_from_args(argc, argv);
  if (port < 0) {
    fputs("test upstream requires --port\n", stderr);
    return 2;
  }

  int listener = socket(AF_INET, SOCK_STREAM, 0);
  if (listener < 0) {
    perror("socket");
    return 1;
  }
  int reuse = 1;
  if (setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) != 0) {
    perror("setsockopt");
    close(listener);
    return 1;
  }
  struct sockaddr_in address = {
      .sin_family = AF_INET,
      .sin_port = htons((unsigned short)port),
      .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
  };
  if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0 ||
      listen(listener, 1) != 0) {
    perror("bind/listen");
    close(listener);
    return 1;
  }

  int client = accept(listener, NULL, NULL);
  if (client < 0) {
    perror("accept");
    close(listener);
    return 1;
  }
  char request[4096];
  size_t length = 0;
  while (length + 1 < sizeof(request)) {
    ssize_t received = recv(client, request + length, sizeof(request) - length - 1, 0);
    if (received <= 0) {
      break;
    }
    length += (size_t)received;
    request[length] = '\0';
    if (strstr(request, "\r\n\r\n") != NULL) {
      break;
    }
  }
  const char response[] =
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nOK";
  size_t sent = 0;
  while (sent < sizeof(response) - 1) {
    ssize_t count = send(client, response + sent, sizeof(response) - 1 - sent, 0);
    if (count <= 0) {
      perror("send");
      close(client);
      close(listener);
      return 1;
    }
    sent += (size_t)count;
  }
  // Keep the upstream connection open: stdio forwarding must finish at the
  // complete HTTP response rather than waiting for peer EOF.
  sleep(10);
  close(client);
  close(listener);
  return 0;
}
