# remote-cc

A Telegram bot that proxies [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) sessions, letting you interact with Claude Code remotely from any Telegram client.

Each session runs as a forum topic in a Telegram group. Messages you send in the topic are forwarded to Claude Code, and responses stream back in real time — including tool usage cards showing what Claude is doing.

## Features

- **Streaming responses** — Claude's output streams into Telegram messages, updated live
- **Session persistence** — sessions survive bot restarts; `--resume` picks up where you left off
- **Multi-session** — run multiple sessions in parallel across different repos

## Prerequisites

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- A Telegram group with **Topics enabled** and the bot added as an admin

## Quick Start

```bash
git clone <repo-url>
cd remote-cc
node setup.js
```

The setup script will install dependencies, walk you through `.env` configuration, build the project, and set up PM2 with auto-start.

## Manual Setup

1. **Clone and install**

   ```bash
   git clone <repo-url>
   cd remote-cc
   npm install
   ```

2. **Configure environment**

   ```bash
   cp .env.example .env
   ```

   Edit `.env` with your values:

   ```env
   BOT_TOKEN=your-telegram-bot-token
   ALLOWED_USER_IDS=123456789,987654321
   ALLOWED_CHAT_IDS=-1001234567890
   ALLOWED_PATHS=/home/user/projects,/home/user/work
   ```

   | Variable | Required | Description |
   |---|---|---|
   | `BOT_TOKEN` | Yes | Telegram bot token from BotFather |
   | `ALLOWED_USER_IDS` | Yes | Comma-separated Telegram user IDs allowed to use the bot |
   | `ALLOWED_CHAT_IDS` | No | Comma-separated group chat IDs (if empty, only user ID check applies) |
   | `ALLOWED_PATHS` | No | Comma-separated parent directories for project repos |
   | `DATA_DIR` | No | Session data directory (default: `./data`) |
   | `MAX_TURNS_PER_MESSAGE` | No | Limit Claude's agentic turns per message |
   | `MAX_BUDGET_PER_MESSAGE` | No | Limit Claude's cost per message (USD) |

3. **Build and run**

   ```bash
   npm run build
   npm start
   ```

   Or for development:

   ```bash
   npm run dev
   ```

4. **Run with PM2** (recommended for production)

   ```bash
   npm install -g pm2
   pm2 start dist/index.js --name remote-cc
   pm2 save
   ```

   To auto-start on Windows boot:

   ```bash
   npm install -g pm2-windows-startup
   pm2-startup install
   pm2 save
   ```

## Usage

1. Add the bot to a Telegram group with Topics enabled
2. Make the bot an admin with "Manage Topics" permission
3. Use `/new <repo-name> [session-name]` to create a session — a new topic is created
4. Send messages in the topic to chat with Claude Code
5. Use `/restart` from Telegram to restart the bot after code changes

### Commands

| Command | Description |
|---|---|
| `/new <name\|path> [session-name]` | Start a new Claude session |
| `/reset` | Reset session in current topic |
| `/delete` | Delete session and close topic |
| `/sessions` | List all sessions |
| `/usage` | Show token usage |
| `/verbosity <1\|2>` | Set tool verbosity (1=hide, 2=show) |
| `/repos` | List available project paths |
| `/restart` | Restart the bot (PM2 auto-restarts) |
| `/help` | Show help message |

## Notes

- Only tested on Windows. Should work on macOS/Linux but may need adjustments.
