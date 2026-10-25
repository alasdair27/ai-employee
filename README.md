# AI Employee

Cloud-based Slack AI employee — initial deployment scaffold.

## Current functionality
- HTTP health endpoint: `GET /health`
- Signed Slack Events API endpoint: `POST /slack/events`
- Slack URL verification
- Acknowledges app mentions in Slack (no task execution yet)
- Optional channel allowlist via `SLACK_TASK_CHANNEL_ID`

## Deploy to Render
Create a Render Blueprint from `render.yaml`. Add secrets through Render's environment settings, never GitHub.
This starter service uses a paid Starter instance to avoid free-tier sleeping; you can choose another plan in Render.

## Slack setup
Create a Slack app, enable **Event Subscriptions**, use the Render URL followed by `/slack/events`.
Add bot scopes `app_mentions:read` and `chat:write`, subscribe to `app_mention`, then install the app to your workspace.
Set `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` in Render and redeploy.
Invite the bot to a channel and mention it.

## Next milestones
Persistent task queue, worker, scheduler, OpenAI tools, GHL integration, isolated coding sandbox and approvals.
Do not use this prototype for sensitive tasks or production automations.
