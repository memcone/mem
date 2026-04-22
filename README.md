# mem

Tiny, transparent memory engine for AI apps.

`mem` gives you three explicit primitives:

- `remember` to store durable context
- `recall` to search memory directly
- `context` to build a bounded prompt-ready memory block

It is designed for people who want a memory layer they can actually read, debug, and self-host.

## Why

Most AI apps start by stuffing more transcript into the context window.
That works in demos, then gets slower, more expensive, and harder to debug as conversations grow.

`mem` takes the opposite approach:

- store compact durable memory instead of replaying whole chat logs
- make retrieval observable
- keep the primitive small enough to understand

## What It Includes

- TypeScript memory engine
- Postgres-backed storage
- Redis-backed cache and usage metrics
- Deterministic retrieval traces
- Tests for memory writes, retrieval, cache behavior, and replay fixtures

## API Shape

```ts
import { createMem } from "mem"

const mem = createMem({
  db: process.env.DATABASE_URL!,
  llm: {
    provider: "openai",
    apiKey: process.env.OPENAI_API_KEY!,
  },
  redis: process.env.REDIS_URL,
})

await mem.remember("user-123", "The user prefers short answers.")

const recall = await mem.recall("user-123", "response style")
const ctx = await mem.context("user-123", "reply to the user")
```

## Install

```bash
pnpm install
```

## Run

Start the local API server:

```bash
pnpm dev
```

Build:

```bash
pnpm build
```

Test:

```bash
pnpm test
```

## Design Goals

- Small public surface area
- Explicit primitives over hidden magic
- Observable memory state
- Debuggable retrieval decisions
- Token-efficient context packing

## Project Layout

- `src/` core engine, store, cache, metrics, server
- `tests/` unit and integration tests
- `replay/` deterministic replay fixtures for memory behavior
- `simulations/` small simulation helpers

## Status

`mem` is under active development. The code is intentionally kept compact and readable, and the public API may still evolve.

## License

MIT
