FROM busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
COPY fixture.txt /fixture.txt
RUN test "$(cat /fixture.txt)" = 'shared-build-fixture' && cp /fixture.txt /verified.txt
# A read-only package cache reproduces Go module cache cleanup behavior.
RUN mkdir -p /go/pkg/mod/fixture@v0.0.0 && cp /fixture.txt /go/pkg/mod/fixture@v0.0.0/readonly.txt && chmod -R a-w /go/pkg/mod
CMD ["cat", "/verified.txt"]
