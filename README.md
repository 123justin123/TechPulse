<p align="center">
  <img src="docs/logo.png" alt="TechPulse" width="420">
</p>

<p align="center">
  <a href="../../actions/workflows/ci.yml"><img src="../../actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

Personal tech watch. TechPulse collects articles from RSS feeds, scores them with an LLM
against topics you describe in plain language, and posts a daily digest to your messaging
channels. Discord is supported today; channels are pluggable (Slack, Telegram, email…).

Node.js, strict TypeScript, SQLite, one container.

## How it works

```
collect ──► score ──► digest ──► channels
  RSS        LLM      best articles by topic   Discord, …
```

Three scheduled jobs share a SQLite database:

1. **collect** fetches the RSS feeds, deduplicates articles by URL and stores a short excerpt.
2. **score** asks the LLM to match each article to a topic, score it from 0 to 10 and summarize it.
3. **digest** sends the articles above the threshold, grouped by topic.

## Quick start

```bash
cp .env.example .env
docker compose up -d --build
```

Fill in `.env` first:

| Variable | Value |
| --- | --- |
| `LLM_PROVIDER` | `anthropic`, `openai` or `gemini` |
| `LLM_API_KEY` | API key of that provider |
| `CHANNELS` | `discord` |
| `DISCORD_WEBHOOK_URL` | Channel settings › Integrations › Webhooks › New Webhook › Copy URL |
| `DISCORD_BOT_TOKEN` | optional, to use the commands (see below) |
| `DISCORD_ALLOWED_USER_IDS` | your Discord user ID, required with a bot |

Invalid or missing values are all listed at startup: `docker compose logs techpulse`.

### Discord bot (optional)

Without a bot, the digest is still sent; only the commands are disabled.

1. On the [Discord developer portal](https://discord.com/developers/applications): New Application › **Bot** › Reset Token.
2. **OAuth2 › URL Generator**: check `bot` and `applications.commands`, open the URL and invite the bot.
3. Your user ID: Discord settings › Advanced › Developer Mode, then right-click your name › Copy User ID.

## Usage

Each channel exposes the same commands in its own syntax. On Discord, they are slash commands:

| Command | Effect |
| --- | --- |
| `/topic add phrase:` | follow a topic described in one sentence |
| `/topic remove label:` | stop following a topic |
| `/topic list` | list topics |
| `/run job:` | run collect, score or digest now |

Example: `/topic add phrase: Security news: vulnerabilities, attacks and data breaches`.
The LLM turns the sentence into a label and a precise definition used for scoring.

## Configuration

### Feeds

Sources are RSS or Atom feeds in `config/feeds.json`, reloaded on every run:

```json
[{ "name": "Lobsters", "url": "https://lobste.rs/rss" }]
```

Sites without a feed can go through a bridge: `https://hnrss.org/frontpage?points=100` for
Hacker News, `https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml` for GitHub
Trending, `https://www.reddit.com/r/<subreddit>/top/.rss?t=day` for Reddit (keep one or two:
Reddit rate-limits anonymous clients).

### LLM

| `LLM_PROVIDER` | Default model | Cheaper scoring model |
| --- | --- | --- |
| `anthropic` | `claude-opus-5` | `claude-sonnet-5` |
| `openai` | `gpt-5.5` | `gpt-5.4-mini` |
| `gemini` | `gemini-pro-latest` | `gemini-flash-latest`, `gemini-flash-lite-latest` |

`LLM_TOPIC_MODEL` is used when a topic is created, `LLM_SCORING_MODEL` for every article:
the scoring model drives the bill. Both are optional. When switching providers, update or
clear them. On Gemini's free tier, only Flash models are available.

### Other settings

| Variable | Default | Effect |
| --- | --- | --- |
| `DIGEST_LANGUAGE` | `English` | language of summaries and topics |
| `DIGEST_SCORE_THRESHOLD` | `6` | minimum score to enter the digest |
| `DIGEST_MAX_ITEMS` | `25` | articles per digest |
| `CRON_COLLECT` / `CRON_SCORE` / `CRON_DIGEST` | every 2 h / every 2 h / 8:00 | schedules, in `TZ` |
| `MAX_ITEM_AGE_DAYS` | `7` | ignore older articles |
| `AI_MAX_ITEMS_PER_RUN` | `60` | articles scored per run |

All variables are documented in `.env.example`.

## Architecture

```
src/
  main.ts        builds every dependency and starts the jobs
  config.ts      reads and validates the environment
  scheduler.ts   cron jobs
  topics.ts      topic management
  scoring.ts     LLM scoring
  digest.ts      digest building
  commands.ts    channel-agnostic commands
  sources/       RSS collection, excerpt cleaning
  llm/           Anthropic, OpenAI, Gemini behind one interface
  channels/      Discord (more to come) behind one interface
```

Dependencies are built once in `main.ts` and passed down, so every module is tested with
fakes. `llm/` and `channels/` each expose one interface: adding Mistral or Telegram means
one new file registered in that folder's `index.ts`.

LLM failures are classified: an unusable answer costs the batch an attempt, while an outage
or a wrong API key stops scoring without penalizing any article.

## Development

```bash
npm run setup    # install from the lockfile and build the native SQLite module
npm run check    # lint, dependency audit and tests, as in CI
npm start        # run locally with .env
```

Tests run with `node:test`, without network or API key. Lint and formatting use Biome.

npm install scripts are disabled and new releases are only installed after 7 days
(`.npmrc`). Only `better-sqlite3` is rebuilt, through `npm run rebuild:native`.

## Troubleshooting

- **Slash commands missing**: invite the bot with the `applications.commands` scope.
- **"You are not allowed to control TechPulse."**: add your ID to `DISCORD_ALLOWED_USER_IDS`.
- **Permission denied on `data/`**: `sudo chown -R 1000:1000 ./data` (the container runs as uid 1000).
- **Empty digest**: no active topic, or lower `DIGEST_SCORE_THRESHOLD`.
- **`Gemini rate limit reached: ... limit: 0`**: the model is not in the free tier, use a Flash model.
