FROM alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) test "$(uname -m)" = x86_64 ;; \
      arm64) test "$(uname -m)" = aarch64 ;; \
      *) exit 1 ;; \
    esac \
    && /bin/sh -c 'printf multiarch > /fixture' \
    && test "$(cat /fixture)" = multiarch
