import crypto from 'crypto';

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(), body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { email, otp, token, new_password } = JSON.parse(event.body || '{}');
    const em = (email || '').toLowerCase().trim();

    if (!em || !otp || !token || !new_password) return err(400, 'Missing required fields.');
    if (new_password.length < 6) return err(400, 'Password must be at least 6 characters.');

    const OTP_SECRET = process.env.OTP_SECRET;
    if (!OTP_SECRET) return err(500, 'OTP_SECRET missing from Netlify env vars.');

    // Decode token
    let td;
    try { td = JSON.parse(Buffer.from(token, 'base64').toString()); }
    catch { return err(400, 'Invalid reset token.'); }

    if (td.email !== em)         return err(400, 'Email does not match token.');
    if (Date.now() > td.expires) return err(400, 'Code has expired. Request a new one.');

    // Verify OTP via HMAC
    const expected = crypto.createHmac('sha256', OTP_SECRET)
      .update(`${otp}:${em}:${td.expires}`).digest('hex');
    let valid = false;
    try { valid = crypto.timingSafeEqual(Buffer.from(expected,'hex'), Buffer.from(td.hmac,'hex')); }
    catch { valid = false; }
    if (!valid) return err(400, 'Incorrect code. Please try again.');

    const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
    const PRIVATE_KEY  = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
    if (!CLIENT_EMAIL || !PRIVATE_KEY)
      return err(500, 'Firebase admin credentials missing. Add FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY to Netlify env vars.');

    // Get admin OAuth2 token
    const adminToken = await getAdminToken(CLIENT_EMAIL, PRIVATE_KEY);

    // Look up user by email
    const lookupResp = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: [em] }),
    });
    const lookupData = await lookupResp.json();
    if (!lookupData.users?.length) return err(404, 'No account found with that email.');
    const localId = lookupData.users[0].localId;

    // Update password
    const updateResp = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:update', {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ localId, password: new_password }),
    });
    const updateData = await updateResp.json();
    if (updateData.error) return err(500, 'Password update failed: ' + updateData.error.message);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors() },
      body: JSON.stringify({ success: true }),
    };
  } catch (e) {
    return err(500, e.message);
  }
}

function b64u(str) { return Buffer.from(str).toString('base64url'); }

function createJWT(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const pld = b64u(JSON.stringify({
    iss: clientEmail, sub: clientEmail,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/firebase',
  }));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${hdr}.${pld}`);
  return `${hdr}.${pld}.${sign.sign(privateKey, 'base64url')}`;
}

async function getAdminToken(clientEmail, privateKey) {
  const jwt  = createJWT(clientEmail, privateKey);
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const d = await resp.json();
  if (!d.access_token)
    throw new Error('Admin auth failed — check FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.');
  return d.access_token;
}

function err(status, message) {
  return { statusCode: status, headers: cors(), body: JSON.stringify({ error: message }) };
}
function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
}
