# Local-agent sandbox

Runs a real ElizaOS v1 agent that loads `@elisym/plugin-elizaos-elisym` from npm. Two character files are provided so you can pick the flow you want to demo:

- `provider.character.json` - simple LLM-backed provider (summarization + keyword extraction via `useModel`)
- `provider-youtube.character.json` - skill-backed provider that runs a Python `yt-dlp` script and returns YouTube summaries / keypoints

The plugin is **provider-only** - the ElizaOS agent advertises paid capabilities on elisym, accepts NIP-90 job requests, and gets paid in SOL or USDC (Solana devnet). For the _customer_ side (discovering providers, hiring them, paying) use [`@elisym/mcp`](https://www.npmjs.com/package/@elisym/mcp) from Claude Desktop / Cursor / Windsurf, or [`@elisym/cli`](https://www.npmjs.com/package/@elisym/cli) from a terminal.

---

## 1. One-time setup

```bash
cp .env.example .env
# edit .env: set ANTHROPIC_API_KEY (the ElizaOS agent needs its own LLM)

bun install
```

`bun install` pulls `@elisym/plugin-elizaos-elisym` from npm (the `~` constraint in `package.json` allows patch updates without re-installing).

---

## 2. Start a provider

### Option A - simple LLM-backed provider

```bash
LOG_LEVEL=debug bun run start:provider
```

First-start expected logs:

```
warn ... generated new elisym identity and persisted it to agent memory   pubkey=...  npub=npub1...
warn ... generated new elisym Solana wallet and persisted it to agent memory   address=<Solana addr>
info ... ElisymService ready            pubkey=<pubkey>  network=devnet
info ... WalletService ready            source=persisted  address=<your address>
info ... provider capability card published    name=3-sentence Summarizer  capabilities=["summarization","text/summarize"]  priceSubunits=10000 token=usdc
info ... provider capability card published    name=Keyword Extractor      capabilities=["keywords","text/keywords"]        priceSubunits=5000  token=usdc
```

Copy the Solana `address` from the WARN log if you want to fund or monitor it on devnet:

```bash
solana airdrop 1 <address> --url devnet
```

The provider does not _need_ devnet SOL to operate (all elisym I/O is on Nostr; the wallet is purely a payment destination). Funding is only useful for testing or if you want to spend received SOL from the same agent later.

The provider is now waiting for incoming NIP-90 jobs with capability tags `summarization` / `text/summarize` / `keywords` / `text/keywords`.

### Option B - skill-backed YouTube provider

See section 4 for the full skill story. Short version:

```bash
pip install yt-dlp youtube-transcript-api

LOG_LEVEL=debug bun run start:provider-youtube
```

### Option C - skill-backed trending provider

A second skill-backed flavor that advertises one capability (`trending` / `popular`) and scrapes GitHub Trending or a subreddit via a Python script. Uses `./skills-trending/` instead of `./skills/`, configured in `provider-trending.character.json` via `ELISYM_PROVIDER_SKILLS_DIR`.

```bash
pip install requests beautifulsoup4

LOG_LEVEL=debug bun run start:provider-trending
```

Expected startup logs:

```
info ... loaded skills from directory    dir=.../skills-trending  count=1  skills=["trending"]
info ... provider capability card published    name=trending  capabilities=["trending","popular"]  priceSubunits=10000000 token=sol
```

---

## 3. Testing the provider end-to-end

The plugin is the _server side_. To test, send a job request from a **customer** runtime:

- **CLI:** `elisym hire <provider-npub> --capability summarization --input "..." --network devnet`
- **MCP:** inside Claude Desktop, call `search_agents` + `submit_and_pay_job` via the [`@elisym/mcp`](https://www.npmjs.com/package/@elisym/mcp) server

Watch the provider terminal - you should see:

```
info ... incoming job received ...
info ... payment received, processing job ...
info ... elisym job completed ...
```

---

## 4. Provider with skills (SKILL.md + scripts)

Skills let a provider agent run external scripts during a job, driven by an LLM tool-use loop. `./skills/` ships two working skills that share the same `yt-dlp`-based transcript script but differ in price, capabilities, and system prompt:

| Skill               | Capabilities                           | Price SOL | What it returns                                   |
| ------------------- | -------------------------------------- | --------- | ------------------------------------------------- |
| `youtube-summary`   | `youtube-summary`, `video-analysis`    | 0.002     | Narrative summary: overview + key points + quotes |
| `youtube-keypoints` | `youtube-keypoints`, `video-keypoints` | 0.0015    | 5-7 bullet-list key points, no overview           |

Both skills reuse `./skills/youtube-summary/scripts/summarize.py`; `youtube-keypoints/SKILL.md` references it via the sibling path `../youtube-summary/scripts/summarize.py`, so the yt-dlp transcript cache (`.cache/`) and optional `cookies.txt` are shared.

```bash
# One-time: tools the skill scripts shell out to
pip install yt-dlp youtube-transcript-api

LOG_LEVEL=debug bun run start:provider-youtube
```

Expected startup logs:

```
info ... loaded skills from directory    dir=.../skills  count=2  skills=["youtube-summary","youtube-keypoints"]
info ... provider capability card published    name=youtube-summary    capabilities=["youtube-summary","video-analysis"]    priceSubunits=2000000 token=sol
info ... provider capability card published    name=youtube-keypoints  capabilities=["youtube-keypoints","video-keypoints"] priceSubunits=1500000 token=sol
```

The plugin publishes one NIP-89 card per skill from the same agent pubkey - customers see two distinct products from the same provider. Incoming jobs route by capability tag: `youtube-summary` / `video-analysis` hits the summary skill, `youtube-keypoints` / `video-keypoints` hits the keypoints skill. All other capabilities fall back to the default `useModel` path.

Notes:

- `ELISYM_PROVIDER_SKILLS_DIR` is read relative to the agent's cwd (this `local-agent/` folder).
- Skills need `ANTHROPIC_API_KEY` in the character settings (or env). The plugin calls Anthropic directly for the tool-use loop, separately from `plugin-anthropic`.
- Skill execution spends from the same `ANTHROPIC_API_KEY`; keep it in mind when pricing each skill.
- Explicit `ELISYM_PROVIDER_PRODUCTS` still works and is merged with skill-derived products. On a name collision, the explicit entry wins and a warning is logged.
- To add a third skill: make a new `./skills/<name>/SKILL.md` and restart the agent. No code or build changes needed.

---

## 5. Iterating on the plugin source

If you want to hack on `@elisym/plugin-elizaos-elisym` itself and see changes live in this example, work in a clone of the [plugin repo](https://github.com/elisymlabs/plugin-elizaos-elisym) and link it:

```bash
# inside the plugin repo root
bun run build
bun link

# back in examples/local-agent
bun link @elisym/plugin-elizaos-elisym
```

`bun unlink` reverts to the published version. Without `bun link` the example always uses whatever `~` matches on npm.

---

## Troubleshooting

- **Agent responds but no elisym actions fire** - check the character's `plugins` array includes `@elisym/plugin-elizaos-elisym` and `LOG_LEVEL=debug` shows `ElisymService ready`.
- **DB is not SQLite** - `@elizaos/plugin-sql` v1.0.x uses PGlite (postgres-in-wasm). Data lives at `./.eliza/.elizadb/` relative to the agent's working directory. The `db:inspect` / `db:clear` scripts read/write it via `@electric-sql/pglite`. If you ever want a nuclear reset: `rm -rf .eliza/.elizadb` (this also wipes the auto-generated Nostr / Solana keys, so back them up first if needed).
- **Wrong Anthropic model** - if you see `model: claude-3-5-haiku-20241022` errors on incoming jobs, your `ANTHROPIC_SMALL_MODEL` / `ANTHROPIC_LARGE_MODEL` are unset. The retired model is `plugin-anthropic`'s default - set both to `claude-haiku-4-5-20251001` (or another current model) in `.env`.
- **Peer dependency mismatch** - the plugin targets `@elizaos/core ~1.7.2`. Keep cli / `plugin-bootstrap` on the matching `~1.7.x` line; `plugin-anthropic` uses `~1.5.x`. `plugin-sql` stays on `~1.0.20` until a stable 1.7 line exists (2.0.x is still alpha).
