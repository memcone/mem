# mem

<div align="center">

Backend memory engine for [Memcone](https://memcone.com).

<h3>

[Homepage](https://memcone.com) | [Docs](https://memcone.com/docs) | [API Reference](https://memcone.com/docs/reference/context) | [MCP](https://memcone.com/docs/mcp) | [CLI](https://www.npmjs.com/package/@memcone/cli)

</h3>

[![GitHub Repo stars](https://img.shields.io/github/stars/memcone/mem?style=flat-square)](https://github.com/memcone/mem/stargazers)
[![npm version](https://img.shields.io/npm/v/@memcone/cli?style=flat-square)](https://www.npmjs.com/package/@memcone/cli)

</div>

---

`mem` is the backend engine behind Memcone's memory API.

It powers the three primitives Memcone exposes publicly:

- `POST /v1/remember`
- `POST /v1/recall`
- `POST /v1/context`

If you use Memcone from the hosted product, this is the service doing the memory work behind `https://api.memcone.com`.

---

## What This Repo Is

This repository contains the production backend for Memcone's memory layer:

- the memory engine in [`src/engine.ts`](./src/engine.ts)
- the HTTP server in [`src/server.ts`](./src/server.ts)
- the Postgres store in [`src/store.ts`](./src/store.ts)
- Redis-backed cache and usage metrics
- replay fixtures and backend tests

This repository does **not** contain the full Memcone product surface.

The hosted dashboard, docs site, marketing pages, MCP guides, and the CLI package live in the main Memcone app and website:

- [Memcone homepage](https://memcone.com)
- [Documentation](https://memcone.com/docs)
- [MCP docs](https://memcone.com/docs/mcp)
- [CLI docs](https://memcone.com/docs/cli)
- [Dashboard](https://memcone.com/dashboard)

---

## What Memcone Exposes

Memcone is persistent memory for AI apps.

The public API stays intentionally small:

### `remember`

Store a new event, preference, message, or structured interaction.

```json
{
  "scopeId": "user_123",
  "event": "User prefers TypeScript over JavaScript."
}
```

### `recall`

Search a scope directly when you want raw retrieval results.

```json
{
  "scopeId": "user_123",
  "query": "what language does this user prefer?"
}
```

### `context`

Get a compressed memory block ready to inject into an LLM prompt.

```json
{
  "scopeId": "user_123",
  "task": "help the user debug their build error"
}
```

---

## What This Backend Actually Does

The current engine includes:

- extraction from `remember` inputs
- typed memories and current-state handling
- contradiction handling and supersession
- scratchpad updates for active state
- semantic retrieval
- entity-aware retrieval boosts
- bounded context packing
- Redis-backed fast cache for `context`
- retrieval traces and usage metrics

This is real production code, not a toy implementation or a benchmark-only rewrite.

---

## How It Fits Into Memcone

There are two main ways people use Memcone:

### API

For AI products and chat backends, call the REST endpoints directly:

- `POST /v1/context` before your LLM call
- `POST /v1/remember` after the interaction
- `POST /v1/recall` when you want direct search results

### CLI + MCP

For editors and coding agents, use the CLI and MCP path:

- `npx @memcone/cli init`
- `npx @memcone/cli link`
- add the Memcone MCP server to Cursor, VS Code, Claude Code, Codex, or Windsurf

That flow is documented here:

- [CLI docs](https://memcone.com/docs/cli)
- [MCP docs](https://memcone.com/docs/mcp)

This backend repo is the memory engine layer, not the CLI package itself.

---

## API Example

This is the real usage pattern Memcone documents publicly:

```ts
const headers = {
  Authorization: `Bearer ${process.env.MEMCONE_API_KEY}`,
  "Content-Type": "application/json",
}

const { result: memory } = await fetch("https://api.memcone.com/v1/context", {
  method: "POST",
  headers,
  body: JSON.stringify({
    scopeId: userId,
    task: "help the user with their current coding task",
  }),
}).then((r) => r.json())

await fetch("https://api.memcone.com/v1/remember", {
  method: "POST",
  headers,
  body: JSON.stringify({
    scopeId: userId,
    event: userMessage,
  }),
})
```

See the public reference for the full contracts:

- [remember](https://memcone.com/docs/reference/remember)
- [recall](https://memcone.com/docs/reference/recall)
- [context](https://memcone.com/docs/reference/context)

---

## Current Constraints

This repository is public and should be read honestly.

Current constraints include:

- LLM integration is currently OpenAI-only
- embeddings are currently fixed to 1536 dimensions
- the bundled API server expects Memcone-style product tables such as API keys in Postgres
- Redis is optional for the engine, but required for cache and usage metrics behavior
- the public API surface is stable enough to use, but the internal backend abstractions are still being cleaned up

So the right mental model is:

- this is the real backend behind Memcone
- it is readable and production-used
- it is not yet a polished standalone framework for every storage or model provider

---

## Local Development

Install dependencies:

```bash
pnpm install
```

Build:

```bash
pnpm build
```

Run tests:

```bash
pnpm test
```

Run focused backend suites:

```bash
pnpm vitest run tests/engine.test.ts tests/cache.test.ts tests/engine-remember-cache.test.ts tests/engine-context-cache.test.ts
```

Run the API server locally:

```bash
pnpm dev
```

Environment variables used by local development:

- `DATABASE_URL`
- `OPENAI_API_KEY`
- optional `REDIS_URL`

### Local benchmark infra

If you want to run BEAM locally without spending Neon compute, use the local Docker stack:

```bash
pnpm infra:up
```

This starts:

- local Postgres + `pgvector` on `127.0.0.1:54329`
- local Redis on `127.0.0.1:6380`

Then run `mem` with a local benchmark env file and point the benchmark runner at `http://127.0.0.1:3000`.

See [docs/local-benchmark-stack.md](./docs/local-benchmark-stack.md).

---

## Repo Layout

- `src/` core backend implementation
- `tests/` backend tests
- `replay/` deterministic replay helpers
- `simulations/` small simulation utilities

---

## Transparency

Memcone is opening this repository because the memory layer should be inspectable.

This repo shows the real backend logic behind the public API: how memory is extracted, stored, retrieved, cached, and metered. Some parts are still product-coupled, and that coupling is being reduced over time rather than hidden.

---

## License

MIT
