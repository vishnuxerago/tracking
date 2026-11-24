/**
 * Outbound email for Xerago IoT Command Center.
 * Configure SMTP via env (company mail / Gmail / Outlook).
 * If SMTP is not set, emails are logged to the server console (dev mode).
 */
const nodemailer = require('nodemailer');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || 'xerago-iot@localhost';
const APP_URL = process.env.APP_URL || 'http://localhost:3847';

let transporter = null;

function isConfigured() {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

function getTransporter() {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
  }
  return transporter;
}

function status() {
  return {
    configured: isConfigured(),
    host: SMTP_HOST || null,
    from: SMTP_FROM,
    mode: isConfigured() ? 'smtp' : 'console-fallback'
  };
}

async function sendMail({ to, subject, text, html }) {
  if (!to) return { ok: false, skipped: true, reason: 'no-recipient' };
  const payload = {
    from: SMTP_FROM,
    to,
    subject,
    text: text || '',
    html: html || `<pre>${text || ''}</pre>`
  };

  const tx = getTransporter();
  if (!tx) {
    console.log('[mail:console]', { to, subject, text: text || '(html)' });
    return { ok: true, mode: 'console', to };
  }
  try {
    const info = await tx.sendMail(payload);
    return { ok: true, mode: 'smtp', to, messageId: info.messageId };
  } catch (err) {
    console.error('[mail:error]', err.message);
    return { ok: false, error: err.message, to };
  }
}

async function notifyUser(member, { subject, text, html }) {
  if (!member || !member.email) return { ok: false, skipped: true, reason: 'no-email' };
  return sendMail({ to: member.email, subject, text, html });
}

function assignmentEmail(member, { projectName, tasks, by }) {
  const list = (tasks || [])
    .map((t) => `• ${t.name}${t.category ? ` (${t.category})` : ''}`)
    .join('\n');
  const subject = `[Xerago IoT] New assignment — ${projectName}`;
  const text = `Hi ${member.name},

${by || 'Manager'} assigned you work on "${projectName}":

${list || '• (see dashboard)'}

Open the command center: ${APP_URL}

— Xerago IoT Command Center`;
  const html = `<p>Hi <strong>${member.name}</strong>,</p>
<p><strong>${by || 'Manager'}</strong> assigned you work on <strong>${projectName}</strong>:</p>
<ul>${(tasks || []).map((t) => `<li>${t.name}${t.category ? ` <em>(${t.category})</em>` : ''}</li>`).join('') || '<li>See dashboard</li>'}</ul>
<p><a href="${APP_URL}">Open Xerago IoT Command Center</a></p>`;
  return { subject, text, html };
}

function shareEmail(member, { fileName, projectName, by }) {
  const subject = `[Xerago IoT] Document shared — ${fileName}`;
  const text = `Hi ${member.name},

${by || 'Manager'} shared "${fileName}" with you on project "${projectName}".

Open Cloud Document Vault: ${APP_URL}

— Xerago IoT Command Center`;
  const html = `<p>Hi <strong>${member.name}</strong>,</p>
<p><strong>${by || 'Manager'}</strong> shared <strong>${fileName}</strong> on project <strong>${projectName}</strong>.</p>
<p><a href="${APP_URL}">Open Cloud Document Vault</a></p>`;
  return { subject, text, html };
}

module.exports = {
  status,
  isConfigured,
  sendMail,
  notifyUser,
  assignmentEmail,
  shareEmail,
  APP_URL
};
