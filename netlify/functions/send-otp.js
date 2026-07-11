import crypto from 'crypto';

const ALLOWED = ["hyphen080@gmail.com", "malikareebah157@gmail.com"];

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { email } = JSON.parse(event.body || '{}');
    const em = (email || '').toLowerCase().trim();

    if (!ALLOWED.includes(em)) {
      return err(400, 'That email is not authorised to use this app.');
    }

    const RESEND_KEY  = process.env.RESEND_API_KEY;
    const OTP_SECRET  = process.env.OTP_SECRET;

    if (!RESEND_KEY)  return err(500, 'RESEND_API_KEY is missing from Netlify environment variables.');
    if (!OTP_SECRET)  return err(500, 'OTP_SECRET is missing from Netlify environment variables.');

    // Generate 6-digit OTP
    const otp     = String(crypto.randomInt(100000, 999999));
    const expires = Date.now() + 15 * 60 * 1000; // 15 min

    // Sign it — client stores the token, server verifies OTP against it
    const hmac  = crypto.createHmac('sha256', OTP_SECRET)
      .update(`${otp}:${em}:${expires}`)
      .digest('hex');
    const token = Buffer.from(JSON.stringify({ email: em, expires, hmac })).toString('base64');

    // Send via Resend
    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${RESEND_KEY}`,
        'Content-Type':   'application/json',
      },
      body: JSON.stringify({
        from:    'us. <onboarding@resend.dev>',
        to:      em,
        subject: 'Your us. reset code',
        html:    buildEmail(otp),
      }),
    });

    if (!resendResp.ok) {
      const e = await resendResp.json().catch(() => ({}));
      return err(500, 'Could not send email: ' + (e.message || resendResp.status));
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...cors() },
      body: JSON.stringify({ token }),
    };
  } catch (e) {
    return err(500, e.message);
  }
}

function err(status, message) {
  return { statusCode: status, headers: cors(), body: JSON.stringify({ error: message }) };
}
function cors() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };
}
function buildEmail(otp) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#f5f5f5;font-family:sans-serif">
<div style="max-width:400px;margin:0 auto;background:#FCF0EC;border-radius:16px;padding:32px 28px">
  <h1 style="font-family:Georgia,serif;font-style:italic;color:#1A1512;margin:0 0 4px;font-size:32px">us.</h1>
  <h2 style="color:#C45450;font-size:16px;font-weight:600;margin:0 0 20px">Password Reset Code</h2>
  <p style="color:#7A6560;line-height:1.7;margin:0 0 24px;font-size:14px">
    Enter the code below in the app to set a new password.<br/>It expires in <strong>15 minutes</strong>.
  </p>
  <div style="background:#fff;border-radius:12px;padding:28px 24px;text-align:center;margin:0 0 24px;box-shadow:0 2px 16px rgba(196,84,80,.12)">
    <span style="font-size:42px;font-weight:800;letter-spacing:16px;color:#C45450;font-family:monospace">${otp}</span>
  </div>
  <p style="font-size:12px;color:#B09890;text-align:center;margin:0;line-height:1.6">
    If you didn't request this, ignore this email.<br/>Made with 💕 by Uthmaan
  </p>
</div></body></html>`;
}
