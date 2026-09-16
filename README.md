# TechPulse

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)

Personal tech watch. TechPulse collects articles from RSS feeds (Hacker News, Lobsters,
GitHub Trending…), scores them with an LLM against topics you describe in plain language,
and posts a digest every morning to your channels. Discord is supported out of the box;
channels are pluggable.

A single Node.js process written in strict TypeScript, one SQLite database, one container.

## Architecture

```
src/
  main.ts          wires every dependency and starts the app
  config.ts        reads and validates the environment
  env.ts           environment variable parsing, shared with channels
  db.ts            SQLite database and migrations
  scheduler.ts     job scheduling
  commands.ts      channel-agnostic commands and job names
  topics.ts        topics: add, remove, list
  scoring.ts       article scoring by the LLM
  digest.ts        digest building and sending
  logger.ts · http.ts
  sources/         Source contract   + rss
  llm/             LLM contract      + anthropic, openai, gemini
  channels/        Channel contract  + discord (and the channel registry)
tests/
config/            RSS feeds (reloaded on every run)
```

One rule to find your way around: **a folder is a contract and its implementations, a file
is a feature.** The three folders are the three extension points: adding a source, an
LLM provider or a channel does not touch the rest of the code.

The whole architecture reads from `main.ts`, which acts as a hand-written dependency
injection container: each dependency is built once and passed to whoever needs it. No
module fetches its own database or LLM provider, which is what lets tests swap them for
fakes.

The pipeline runs as three scheduled jobs that only communicate through the database:

```
collect ──► raw_items (pending) ──► score ──► raw_items (processed) ──► digest ──► channels
             dedup by URL                    topic + score + summary           score threshold
```

Each article goes through `pending` → `processed` → `sent` or `discarded`, and ends up
`failed` after too many LLM failures. Nothing is deleted: discarded articles stay in the
database as raw material to tune the threshold.

## Getting started

### 1. Configuration

```bash
cp .env.example .env
```

Pick the LLM provider with `LLM_PROVIDER` and fill in `LLM_API_KEY`, then list your output
channels in `CHANNELS` (comma-separated, for instance `CHANNELS=discord`) and fill in their
variables. Only the variables of the selected channels are read. On startup,
TechPulse validates the whole configuration and lists every missing or invalid value at once.

### 2. Channels

A channel publishes the digest and, optionally, receives commands. Several channels can run
at the same time: the digest goes to all of them, and articles are marked as sent as soon as
one channel received it (the failing ones are logged).

#### Discord

**Webhook** (required, for the digest): Channel settings › Integrations › Webhooks › New
Webhook › Copy Webhook URL, into `DISCORD_WEBHOOK_URL`.

**Bot** (optional, to manage topics from Discord), on the
[Discord developer portal](https://discord.com/developers/applications):

1. New Application, then the **Bot** tab › Reset Token to get `DISCORD_BOT_TOKEN`;
2. **OAuth2 › URL Generator** tab: check both the `bot` **and** `applications.commands`
   scopes, then open the generated URL to invite the bot to your server.

No privileged intent is needed: slash commands do not read channel messages.

**Your user ID**, for `DISCORD_ALLOWED_USER_IDS`: Discord settings › Advanced › Developer
Mode, then right-click your username › Copy User ID. This list is mandatory as soon as a bot
is configured. Without it, anyone on the server could add topics and spend your API quota.

Without a bot, the digest is still sent. Only the commands are disabled.

The digest contains one Discord embed per topic, colored by the best score of the group
(green for 9-10, blue for 7-8, grey below). Each article is a link prefixed with
its score. Exceeding the Discord API limits (10 embeds and 6000 characters per message, 4096
per description) makes the **whole** message fail, so rendering spreads the digest over
several messages without ever splitting an article.

### 3. Launch

```bash
docker compose up -d --build
```

On startup, TechPulse collects, then scores articles. The digest waits for its schedule.
Then add a first topic, for instance from Discord:

```
/topic add phrase: I want to follow everything related to finance
```

The LLM deduces a short label and a detailed description, and shows them to you. The topic
is active immediately.

## Usage

Every channel that accepts commands exposes the same four actions, each with its own syntax.
On Discord, they are slash commands:

| Discord command | Effect |
| --- | --- |
| `/topic add phrase:` | follows a new topic described in one sentence |
| `/topic remove label:` | disables a topic; already classified articles keep it |
| `/topic list` | lists topics, active and inactive |
| `/run job:` | runs collection, scoring or the digest right away |

On Discord, commands are restricted to server administrators whose ID is allowed. Running
the digest job is useful on the first deployment, to see a digest without waiting for the
next morning. If the job is already running, the command says so instead of starting it
twice.

To follow what is happening:

```bash
docker compose logs -f techpulse
```

## Configuration

Files in `config/` are reloaded on every run: editing them requires neither a restart nor
an image rebuild. A typo produces a message naming the file and the faulty field.

### RSS feeds

Every source is an RSS or Atom feed, listed in `config/feeds.json`. Adding a source means
adding one line:

```json
[{ "name": "Lobsters", "url": "https://lobste.rs/rss" }]
```

The default list favors a few reliable, general-purpose feeds covering the main areas:
curated news (Hacker News, Lobsters, Ars Technica, The Register, Korben), Linux and open
source (LWN), engineering (InfoQ, The Pragmatic Engineer, Martin Fowler), AI (Simon
Willison), infrastructure (Cloudflare), security (Krebs, Schneier) and new repositories
(GitHub Trending). Add niche feeds (a framework blog, a subreddit) to match your topics.

Sites without a native feed are covered by RSS bridges:

| Site | Feed |
| --- | --- |
| Hacker News | `https://hnrss.org/frontpage?points=100` (the `points` filter keeps popular stories only) |
| GitHub Trending | `https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml` (also per language) |
| Reddit | `https://www.reddit.com/r/<subreddit>/top/.rss?t=day` |

Scoring only sees the title, the source and an excerpt, never the full article. TechPulse
keeps the longest text a feed provides (`content:encoded`, description or Atom summary),
converts it to plain text with [htmlparser2](https://github.com/fb55/htmlparser2), drops
lines that are only a URL and the WordPress footer (`The post … appeared first on …`), and
caps it at 1500 characters (`src/sources/excerpt.ts`). When a new article's excerpt is still
shorter than 200 characters, TechPulse fetches the article page once and prepends its meta
description, `og:description` first (`src/sources/enrich.ts`). Articles already collected
are never fetched again.

Feeds are fetched eight at a time and saved as soon as collection ends. A dead or blocked
feed is skipped with a warning without affecting the others, and picked up again on the
next run. Reddit allows anonymous clients about one request per minute: with several
subreddits, most of them get rate-limited on every run, so keep only one or two.

Some sites (Phoronix, for example) answer 403 to clients that do not identify as a browser.
TechPulse identifies itself honestly and does not try to bypass these filters.

### Digest

| Variable | Default | Effect |
| --- | --- | --- |
| `DIGEST_SCORE_THRESHOLD` | `6` | minimum score out of 10 to enter the digest |
| `DIGEST_MAX_ITEMS` | `25` | maximum articles per digest; the overflow is postponed |
| `DIGEST_LANGUAGE` | `English` | language of the summaries and topics written by the LLM |

Code, prompts and bot messages are in English; only the LLM output follows
`DIGEST_LANGUAGE`.

Scored articles without a topic are grouped under `Unclassified`. Each channel decides how
to render the digest.

### Tuning

| Variable | Default | Effect |
| --- | --- | --- |
| `MAX_ITEM_AGE_DAYS` | `7` | articles published earlier are ignored at collection |
| `AI_BATCH_SIZE` | `8` | articles per LLM call: larger is cheaper, but risks truncated output |
| `AI_MAX_ATTEMPTS` | `3` | attempts before an article is marked `failed` |
| `AI_MAX_ITEMS_PER_RUN` | `60` | articles scored per run, to cap the cost of a backlog |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |
| `DB_PATH` | `./data/techpulse.db` | SQLite database file |
| `FEEDS_FILE` | `./config/feeds.json` | RSS feed list |

## LLM provider

Every provider is configured with the same four variables: `LLM_PROVIDER`, `LLM_API_KEY`,
`LLM_TOPIC_MODEL` and `LLM_SCORING_MODEL`. The two model variables are optional: left empty,
each provider uses its own defaults. When switching providers, change the key and update or
clear the model variables, otherwise a Claude model name would be sent to OpenAI (the error
message then points at these two variables).

Each provider uses two models. The **topic** model is only called when a topic is created,
but its description drives all the scoring. The **scoring** model runs on every article,
every day: it drives the bill.

| `LLM_PROVIDER` | Default models (both) | Cheaper `LLM_SCORING_MODEL` |
| --- | --- | --- |
| `anthropic` | `claude-opus-5` | `claude-sonnet-5`, `claude-haiku-4-5` |
| `openai` | `gpt-5.5` | `gpt-5.4-mini` |
| `gemini` | `gemini-pro-latest` | `gemini-flash-latest` |

They all expose the same method: `completeJson` takes a Zod schema and returns a validated
object whose type is inferred from the schema. Each provider translates it its own way:

| | Anthropic | OpenAI | Gemini |
| --- | --- | --- | --- |
| API | Messages | Responses | `generateContent` |
| Structured output | `output_config.format` | `text.format`, strict mode | `responseJsonSchema` + local Zod validation |
| Effort `low`→`max` | `output_config.effort` | `reasoning.effort` | `thinkingLevel`, capped at `HIGH` |

Two constraints follow. With OpenAI, models must be reasoning models (gpt-5 family). With
Gemini, `thinkingLevel` requires Gemini 3 or newer.

### When the LLM fails

An article gets `AI_MAX_ATTEMPTS` attempts (3 by default) before leaving the queue. Only failures caused by the batch
content cost an attempt:

| Failure | Effect |
| --- | --- |
| Model refusal, truncated output, unusable JSON, missing verdict | one attempt charged, move on to the next batch |
| Rate limit, server error, network | scoring stops, no article penalized |
| Rejected key, unknown model | scoring stops, no article penalized |

Without this distinction, a mistyped key or a few hours of outage would burn the attempts of
the whole backlog in three runs.

## Scheduling

| Variable | Default | Job |
| --- | --- | --- |
| `CRON_COLLECT` | `0 */2 * * *` | source collection |
| `CRON_SCORE` | `20 */2 * * *` | LLM scoring |
| `CRON_DIGEST` | `0 8 * * *` | digest sending |
| `TZ` | system time zone (`Europe/Paris` in `.env.example`) | time zone of the expressions |

A job never runs twice in parallel, whether started by the schedule or by a command. On
startup, collection then scoring run one after the other; the digest waits for its schedule.

## Development

```bash
npm run setup        # clean install from the lockfile, then builds the native SQLite module
npm run check        # lint, dependency audit, build and tests (what CI runs)
npm test             # build, then run the tests
npm run lint         # Biome: lint, formatting and import order
npm run lint:fix     # apply automatic fixes
npm run format       # format the code
npm run typecheck    # type-check without emitting
npm run audit:deps   # registry signature and vulnerability checks
npm run build        # compile to dist/
npm start            # run the app locally (reads .env)
```

TypeScript runs in `strict` mode with `noUncheckedIndexedAccess`. Lint and formatting use
[Biome](https://biomejs.dev) (typescript-eslint does not support TypeScript 7 yet). The
Docker image only contains the compiled JavaScript: TypeScript and the tests only exist at
build time.

Tests use the Node built-in runner (`node:test`) and run in a few seconds, with no network
and no API key. Thanks to dependency injection, each module is tested against an in-memory
SQLite database, a fake LLM provider, a fake channel or recorded feeds. Only the LLM and
webhook adapters are tested against a local HTTP server: their job is precisely the real
request each SDK sends.

GitHub Actions (`.github/workflows/ci.yml`) runs the lint, the dependency audit, the tests
and the Docker build on every push and pull request.

## Supply chain security

A malicious npm release usually strikes in its first hours, through an install script. The
project stacks several defenses against it:

| Defense | Where | Protects against |
| --- | --- | --- |
| `ignore-scripts=true` | `.npmrc` | install scripts running arbitrary code on `npm install` |
| Native build allowlist | `npm run rebuild:native` | only `better-sqlite3` is allowed to run its install script |
| `min-release-age=7` | `.npmrc` | versions published less than 7 days ago, before the community spots them |
| Exact versions + lockfile | `package.json`, `save-exact=true` | silent upgrades through `^` ranges |
| `npm ci` everywhere | CI, Dockerfile | installs that drift from the lockfile |
| `npm audit signatures` | `npm run audit:deps` | tarballs not signed by the npm registry |
| `npm audit` | `npm run audit:deps` | known vulnerabilities (fails from `high`) |
| Read-only CI token, no persisted credentials | CI | a compromised step pushing to the repository |
| Dependabot with a 7-day cooldown, grouped | `.github/dependabot.yml` | outdated dependencies, without jumping on fresh releases |
| Non-root container user | `Dockerfile` | a compromised dependency taking over the container |

If a new dependency really needs its install script (a native module), review the script,
then add the package to `rebuild:native` and to the `Dockerfile`.

## Extending

**A source**: most sources need no code, just a line in `config/feeds.json`. For a site
with no feed at all, create `src/sources/mastodon.ts`, returning a `Source` whose `collect()`
returns articles without touching the database, and register it in `loadSources`
(`src/sources/index.ts`).

**An LLM provider**: create `src/llm/mistral.ts`, implementing `LlmProvider` with its default
models, its schema and effort translation, and the classification of its errors into
`config`, `transient` or `content`. Add its name to `PROVIDER_NAMES` (`src/llm/provider.ts`):
the compiler then points at the table to fill in `src/llm/index.ts`. No new environment
variable is needed. Finally, add its wire format to `tests/llm-providers.test.ts`.

**A channel**: create `src/channels/telegram.ts`, exporting a `ChannelDefinition` with two
functions: `readSettings` reads its own environment variables (`TELEGRAM_BOT_TOKEN`…) and
reports what is missing, and `create` returns a `Channel` (`send`, optional `listen`,
`close`). Register it in `CHANNEL_DEFINITIONS` (`src/channels/index.ts`): it becomes a valid
value for `CHANNELS`, and its settings are typed from the definition. The channel receives a
neutral digest, turns its own commands into neutral `Command` values, and renders neutral
`CommandReply` sections in its own markup. Nothing else changes: topics, scoring, jobs and
configuration stay untouched.

## Troubleshooting

**The container stops right away**: read `docker compose logs techpulse`. An incomplete
configuration is listed line by line.

**Slash commands do not show up**: the bot must be invited with the `applications.commands`
scope. Reinvite it with a generated URL that checks this scope; commands register as soon as
the bot connects.

**"You are not allowed to control TechPulse."**: your user ID is not in
`DISCORD_ALLOWED_USER_IDS`.

**Permission denied on `data/`**: the container runs as the non-root user with uid 1000. On
the server: `sudo chown -R 1000:1000 ./data`.

**`better-sqlite3` fails to load after `npm install`**: install scripts are disabled, run
`npm run rebuild:native`.

**The digest is empty**: no article reaches the threshold (lower `DIGEST_SCORE_THRESHOLD` or
describe your topics more precisely), or no topic is active (`/topic list` on Discord).

## Roadmap

- Tune scoring against real model outputs.
- Cache the system prompt: the topics are identical from one batch to the next,
  and caching them would cut the bill.
