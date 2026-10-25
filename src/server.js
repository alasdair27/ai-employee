import { initialize, addTasks, listTasks, updateTask, databaseConfigured } from './tasks.js';
import http from 'node:http';
import crypto from 'node:crypto';

const port = Number(process.env.PORT || 3000);
const signingSecret = process.env.SLACK_SIGNING_SECRET;
const botToken = process.env.SLACK_BOT_TOKEN;
const openaiKey = process.env.OPENAI_API_KEY;
const openaiModel = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
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

async function generateReply(message) {
  if (!openaiKey) {
    return "I'm online, but my OpenAI API key hasn't been configured yet. I can't reason through tasks until it is.";
  }
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + openaiKey,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: openaiModel,
      instructions: "You are Sam, an AI operations and development assistant working in Slack. Be concise, practical and friendly. You can discuss GHL, websites and coding, but you have NO tools or ability to make changes yet. Never claim you completed a task or saved it to a queue. If asked to execute work, explain that execution tools are being built. Never request secrets in Slack.",
      input: message.slice(0, 12000),
      max_output_tokens: 450,
      store: false
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) {
    console.error('OpenAI API request failed', response.status);
    return "I couldn't reach my AI service right now. Please try again shortly.";
  }
  const data = await response.json();
  const output = (data.output || []).flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text').map(item => item.text).join('\n').trim();
  return output || "I received your message but couldn't generate a response. Please try again.";
}

async function handleTaskCommand(event) {
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  const command = text.toLowerCase();
  if (command === 'tasks' || command === 'list tasks') {
    const tasks = await listTasks(event.channel,event.user);
    return tasks.length ? tasks.map(t => '#' + t.id + ' [' + t.status + '] ' + t.description).join('\n') : 'Your task queue is empty.';
  }
  if (/^(done|complete|block|cancel)\s+#?\d+$/i.test(text)) {
    const [action,number] = text.split(/\s+#?/);
    const status = ({done:'completed',complete:'completed',block:'blocked',cancel:'cancelled'})[action.toLowerCase()];
    const task=await updateTask(event.channel,event.user,Number(number),status);
    return task ? 'Updated #' + task.id + ' to ' + task.status + ': ' + task.description : 'Task not found or already closed.';
  }
  if (/^add(?: tasks?)?:?\s*/i.test(text)) {
    const content=text.replace(/^add(?: tasks?)?:?\s*/i,'').trim();
    const descriptions=content.split(/\n/).map(line=>line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/,'').trim()).filter(Boolean);
    if (!descriptions.length) return 'Send: add tasks: followed by one task per line.';
    if (descriptions.length > 20 || descriptions.some(t=>t.length > 1000)) return 'Please send up to 20 tasks, each under 1,000 characters.';
    const tasks=await addTasks(event.channel,event.user,descriptions);
    return 'Saved ' + tasks.length + ' task(s):\n' + tasks.map(t=>'#'+t.id+' [queued] '+t.description).join('\n') + '\n\nThese are queued, not executed yet.';
  }
  return null;
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
  if (!validSlackSignature(req, raw)) { console.warn('Slack event rejected: invalid signature'); return respond(401, { error: 'invalid_signature' }); }
  let body;
  try { body = JSON.parse(raw); } catch { return respond(400, { error: 'invalid_json' }); }
  if (body.type === 'url_verification') return respond(200, { challenge: body.challenge });
  if (body.type !== 'event_callback') return respond(200, { ok: true });
  const event = body.event || {};
  console.log('Slack event received', { type: event.type, channelType: event.channel_type, subtype: event.subtype || null, eventId: body.event_id || null });
  const isMention = event.type === 'app_mention';
  const isDM = event.type === 'message' && event.channel_type === 'im' && !event.subtype;
  if ((!isMention && !isDM) || event.bot_id || !event.text) {
    console.log('Slack event ignored', { reason: 'unsupported_event_or_bot_or_empty', type: event.type, channelType: event.channel_type });
    return respond(200, { ok: true });
  }
  if (allowedChannel && !isDM && event.channel !== allowedChannel) {
    console.log('Slack event ignored', { reason: 'channel_not_allowed' });
    return respond(200, { ok: true });
  }
  if (seen.has(body.event_id)) return respond(200, { ok: true });
  seen.set(body.event_id, Date.now());
  for (const [key, time] of seen) if (Date.now() - time > 600000) seen.delete(key);
  respond(200, { ok: true });
  // Prototype only: acknowledges messages; persistent tasks and execution are added next.
  try {
    const cleaned = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    let reply;
    if (/^(tasks|list tasks|add\b|done\b|complete\b|block\b|cancel\b)/i.test(cleaned)) {
      if (!databaseConfigured) {
        reply = 'My task database is not connected yet. Please configure DATABASE_URL in Render.';
      } else {
        try { reply = await handleTaskCommand(event); }
        catch (error) { console.error('Task command failed:', error.message); reply = 'I could not access the task database. Please try again.'; }
      }
    }
    if (!reply) reply = await generateReply(event.text);
    await postSlack(event.channel, reply, isDM ? undefined : event.ts);
    console.log('Slack reply sent', { eventId: body.event_id || null, isDM });
  } catch (error) { console.error('Slack notification error:', error.message); }
});
initialize().then(() => {
  server.listen(port, '0.0.0.0', () => console.log('AI Employee listening on ' + port));
}).catch(error => {
  console.error('Database initialization failed:', error.message);
  process.exit(1);
});
