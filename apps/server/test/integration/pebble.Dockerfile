# Pebble, Let's Encrypt's ACME test CA, for acme-pebble.test.ts: built from a pinned commit of
# github.com/letsencrypt/pebble, because v2.10.1, its newest release (ghcr.io/letsencrypt/pebble),
# can stop answering an order for good. Its Order() handler (POST-as-GET of an order) read-locks
# the order and then read-locks it again in orderForDisplay(); when a writer queues on the order
# in between, such as the CA storing the certificate right after a finalize, the second read lock
# waits for the writer and the writer for the first read lock (letsencrypt/pebble#554). Our ACME
# client polls the order right after finalizing it, so now and then that poll was never answered.
# Commit 1fcb30c (main, 2026-09-28) has the fixes, #553 and #555. Go back to the release image
# once a release has them.
#
# The test builds it with `docker build - < pebble.Dockerfile` (no context): BuildKit fetches the
# source at that commit. The Go image is pinned by digest; Pebble vendors its Go modules.
FROM golang:1.25.14-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS build
ADD https://github.com/letsencrypt/pebble.git#1fcb30cabf594e047cb92432b9392bc3dfa469f7 /src
WORKDIR /src
RUN CGO_ENABLED=0 go build -mod=vendor -trimpath -o /pebble ./cmd/pebble

# As the release image: the binary and Pebble's test/ folder (configs, certificates) on scratch.
FROM scratch
COPY --from=build /pebble /pebble
COPY --from=build /src/test /test
ENTRYPOINT ["/pebble"]
