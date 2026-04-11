// Netlify/functions/send-email.js
// Sends emails via Gmail SMTP (primary) or Resend API (fallback).
//
// Gmail SMTP: set GMAIL_USER + GMAIL_APP_PASSWORD in Netlify env vars.
// Resend:     set RESEND_API_KEY (+ RESEND_FROM) — requires verified domain for non-self emails.

const nodemailer = require('nodemailer');
const { verifyAuth } = require('./utils/auth');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const authUser = await verifyAuth(event);
  if (authUser.error) return authUser.error;

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { to, subject, html, attachments } = payload;

  if (!to || !subject || !html) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Missing required fields: to, subject, html' })
    };
  }

  // ── Primary: Gmail SMTP via Nodemailer ──
  const gmailDiag = {};
  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;

  if (gmailUser && gmailPass) {
    try {
      const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: { user: gmailUser, pass: gmailPass },
      });

      const mailOpts = {
        from: process.env.GMAIL_FROM || ('StayOps <' + gmailUser + '>'),
        to,
        subject,
        html,
      };
      if (attachments && Array.isArray(attachments)) {
        mailOpts.attachments = attachments.map(a => ({
          filename: a.filename || 'attachment',
          content: a.content || '',
          encoding: 'base64',
        }));
      }

      const info = await transporter.sendMail(mailOpts);
      console.log('[send-email] Gmail SMTP sent:', info.messageId, 'to:', to);
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, id: info.messageId, provider: 'gmail' })
      };
    } catch (err) {
      console.error('[send-email] Gmail SMTP failed:', err.message);
      // Fall through to Resend if Gmail fails — include error for diagnostics
      gmailDiag.error = err.message;
    }
  } else {
    gmailDiag.error = !gmailUser ? 'GMAIL_USER not set' : 'GMAIL_APP_PASSWORD not set';
  }

  // ── Fallback: Resend API ──
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || 'StayOps <noreply@strmanagement.netlify.app>';

  if (!resendKey) {
    console.error('[send-email] No email provider configured (set GMAIL_APP_PASSWORD or RESEND_API_KEY)');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Email not configured — set GMAIL_APP_PASSWORD or RESEND_API_KEY' })
    };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + resendKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from, to, subject, html, ...(attachments ? { attachments } : {}) })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('[send-email] Resend error:', data);
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: data.message || 'Resend API error', detail: data, gmailError: gmailDiag.error || null })
      };
    }

    console.log('[send-email] Resend sent:', data.id, 'to:', to);
    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, id: data.id, provider: 'resend', gmailError: gmailDiag.error || null })
    };
  } catch (err) {
    console.error('[send-email] Resend error:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
