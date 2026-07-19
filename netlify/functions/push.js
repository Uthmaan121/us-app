// Sends a Web Push notification to one stored subscription using our own
// VAPID keypair — no Firebase Cloud Messaging / paid plan needed. Called by
// the client right after it writes a new chat message, fridge note, or map
// memory, so the *other* person gets notified even if the app is closed.
import webpush from 'web-push';

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return err(500, 'Push not configured.');

  try {
    const { subscription, title, body } = JSON.parse(event.body || '{}');
    if (!subscription || !subscription.endpoint) return err(400, 'Missing subscription.');

    webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:hello@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

    await webpush.sendNotification(subscription, JSON.stringify({
      title: title || 'us.',
      body: body || 'You have a new update.',
    }));

    return { statusCode: 200, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    // A 410/404 just means that subscription expired — not a real error for our purposes.
    if (e.statusCode === 404 || e.statusCode === 410) {
      return { statusCode: 200, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify({ ok: false, expired: true }) };
    }
    return err(500, e.message || 'Push failed.');
  }
}

function err(status, message) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json', ...cors() }, body: JSON.stringify({ error: message }) };
}
function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
}
