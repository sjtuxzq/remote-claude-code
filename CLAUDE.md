# CLAUDE.md

## Project Overview

remote-cc is a Telegram bot proxy for Claude Code CLI that enables remote Claude Code sessions via Telegram.

## Update & Restart Command

To apply latest changes to remote-cc without interrupting the remote user:

```bash
cd /q/s/remote-cc && npm run build && pm2 restart remote-cc
```

How it works:
- `npm run build` compiles TypeScript to `dist/` while the old process is still running
- `pm2 restart remote-cc` gracefully stops the old process and starts the new one (~2-3 second gap)
- Sessions persist in `sessions.json` — no data loss
- Claude session IDs preserved — `--resume` works after restart
- Telegram queues any messages sent during the brief gap — picked up automatically

You may not be able to get the result of the restart command because it kills your parent process. So do not consecutively call restart command - you can assume the restart succeeds.

## PM2 Management

- PM2 manages remote-cc as a daemon process
- Auto-starts on Windows boot via `pm2-windows-startup`
- Auto-restarts on crash
- Logs: `pm2 logs remote-cc`
- Status: `pm2 list`