import http from 'node:http';
import crypto from 'node:crypto';

const port = Number(process.env.PORT || 3000);
const signingSecret = process.env.SLACK_SIGNING_SECRET;
const botToken = process.env.SLACK_BOT_TOKEN;
const allowedChannel = process.env.SLACK_TASK_CHANNEL_ID;
const seen = new Map();

function validSlackSignature(req, raw) {
  if (!signingSecret) return false;
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (!timestamp || !signature || !/^\d+$/.test(String(timestamp))) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = 'v0=' + crypto.createHmac('sha256', signingSecret)
    .update('v0:' + timestamp + ':' + raw).digest('hex');
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function postSlack(channel, text, threadTs) {
  if (!botToken) throw new Error('SLACK_BOT_TOKEN not configured');
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + botToken, 'content-type': 'application/json' },
    body: JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error('Slack message failed: ' + (result.error || response.status));
}

const server = http.createServer(async (req, res) => {
  const respond = (status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (req.method === 'GET' && req.url === '/health') return respond(200, { ok: true, service: 'ai-employee' });
  if (req.method !== 'POST' || req.url !== '/slack/events') return respond(404, { error: 'not_found' });

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024 * 1024) return respond(413, { error: 'too_large' });
  }
  if (!validSlackSignature(req, raw)) return respond(401, { error: 'invalid_signature' });
  let body;
  try { body = JSON.parse(raw); } catch { return respond(400, { error: 'invalid_json' }); }
  if (body.type === 'url_verification') return respond(200, { challenge: body.challenge });
  if (body.type !== 'event_callback') return respond(200, { ok: true });
  const event = body.event || {};
  const isMention = event.type === 'app_mention';
  const isDM = event.type === 'message' && event.channel_type === 'im' && !event.subtype;
  if ((!isMention && !isDM) || event.bot_id || !event.text) return respond(200, { ok: true });
  if (allowedChannel && event.channel !== allowedChannel) return respond(200, { ok: true });
  if (seen.has(body.event_id)) return respond(200, { ok: true });
  seen.set(body.event_id, Date.now());
  for (const [key, time] of seen) if (Date.now() - time > 600000) seen.delete(key);
  respond(200, { ok: true });
  // Prototype only: acknowledges messages; persistent tasks and execution are added next.
  try {
    await postSlack(event.channel,
      "Received your request. The cloud Slack listener is working. Task execution isn't enabled yet.",
      isDM ? undefined : event.ts);
  } catch (error) { console.error('Slack notification error:', error.message); }
});
server.listen(port, '0.0.0.0', () => console.log('AI Employee listening on ' + port));
