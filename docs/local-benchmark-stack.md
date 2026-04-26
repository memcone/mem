# Local Benchmark Stack

Use this stack when you want to run `mem` and BEAM locally without spending Neon compute.

It gives you:

- local Postgres with `pgvector`
- local Redis for cache and metrics
- the same `mem` backend code path you use in production

The only paid part left is the model traffic:

- OpenAI embeddings
- OpenAI extraction
- OpenAI answer generation
- OpenAI judging

---

## Why use this

BEAM runs write thousands of memories.

If `mem` points at Neon, those writes and retrievals consume Neon compute time.

If `mem` points at this local stack, Neon cost drops to zero for backend storage and cache work.

---

## 1. Start local Postgres + Redis

From `/Users/can/Desktop/mem`:

```bash
pnpm infra:up
```

This starts:

- Postgres on `127.0.0.1:54329`
- Redis on `127.0.0.1:6380`

To stop them:

```bash
pnpm infra:down
```

To wipe local data completely:

```bash
pnpm infra:reset
```

---

## 2. Create a local benchmark env file

Use `.env.benchmark.example` as the starting point.

Example:

```bash
cp .env.benchmark.example .env.benchmark.local
```

Then put your real OpenAI key in:

```bash
OPENAI_API_KEY=...
```

Local database values should stay:

```bash
DATABASE_URL=postgresql://mem_local:mem_local@127.0.0.1:54329/mem_local
REDIS_URL=redis://127.0.0.1:6380
PORT=3000
```

---

## 3. Run the backend against local infra

From `/Users/can/Desktop/mem`:

```bash
eval "$(python3 - <<'PY'
import shlex
from pathlib import Path
for line in Path('.env.benchmark.local').read_text().splitlines():
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    k, v = line.split('=', 1)
    print(f'export {k}={shlex.quote(v)}')
PY
)"; pnpm dev
```

This avoids the shell parse issues from raw `.env` sourcing.

The API should come up on:

```bash
http://127.0.0.1:3000
```

Health check:

```bash
curl http://127.0.0.1:3000/health
```

---

## 4. Point BEAM at local mem

From `/Users/can/Desktop/memcone`, keep the benchmark runner using:

```bash
--memcone-base-url http://127.0.0.1:3000
```

That way:

- `remember` writes go to local Postgres
- `context` reads go to local Postgres/Redis
- cache/metrics stay local

Neon is not involved.

---

## 5. What still costs money

Local infra removes backend storage cost, but not model cost.

You still pay for:

- embeddings from `text-embedding-3-small`
- extraction via `gpt-4o-mini`
- contradiction checks via `gpt-4o-mini`
- answer generation in the benchmark
- rubric judging in the benchmark

So this setup cuts Neon spend, not OpenAI spend.

---

## 6. Recommended BEAM workflow

1. `pnpm infra:up`
2. run `mem` with `.env.benchmark.local`
3. run BEAM from `/Users/can/Desktop/memcone`
4. inspect scores
5. `pnpm infra:reset` if you want a clean local memory state

That gives you:

- cheap iteration
- clean resets
- no production DB pollution
