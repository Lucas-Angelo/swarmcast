# @swarmcast/shared

TypeScript sources consumed directly by the other workspaces, with no build output (`exports: ./src/index.ts`).

- `src/constants.ts`: default ports (1935/8080/8081/8888), 2 s segments, 10-min session/ticket TTL, STUN server, message size limits, hash-failure threshold, cookie names.
- `src/schemas.ts`: zod schemas and types for the join request (nickname rules), viewer config, control-channel messages, integrity manifest, admin state and settings.
- `src/capacity.ts`: `estimateCapacity()`, which estimates how many viewers the upload can serve directly and with P2P.

Typecheck: `npm run typecheck -w @swarmcast/shared`. Tests live in `apps/server/test/unit/shared.test.ts`.
