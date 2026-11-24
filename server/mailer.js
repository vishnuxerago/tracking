/**
 * Outbound email for Xerago IoT Command Center.
 * Configure SMTP via env (company mail / Gmail / Outlook).
 * If SMTP is not set, emails are logged to the server console (dev mode).
 */
const nodemailer = require('nodemailer');

function envOrEmpty(key) {
  const v = (process.env[key] || '').trim();
  if (!v || v === '-' || v.toLowerCase() === 'none' || v.toLowerCase() === 'not-set') return '';
  return v;
}

const SMTP_HOST = envOrEmpty('SMTP_HOST');
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = envOrEmpty('SMTP_USER');
const SMTP_PASS = envOrEmpty('SMTP_PASS');
const SMTP_FROM = envOrEmpty('SMTP_FROM') || SMTP_USER || 'xerago-iot@localhost';
const APP_URL = envOrEmpty('APP_URL') || 'http://localhost:3847';

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

function formatTaskPlain(t, index) {
  const lines = [
    `${index}. ${t.name || 'Untitled task'}`,
    `   Category: ${t.category || '—'}`,
    `   Priority: ${t.priority || 'Medium'}`,
    `   Role: ${t.designation || '—'}`,
    `   Due: ${t.targetDate || t.dueDate || 'TBD'}`,
    `   Status: ${t.status || 'Assigned'}`
  ];
  if (t.description) lines.push(`   Details: ${t.description}`);
  if (t.notes) lines.push(`   Notes: ${t.notes}`);
  return lines.join('\n');
}

function formatTaskHtml(t, index) {
  const desc = t.description
    ? `<p style="margin:6px 0 0;color:#334155;">${escapeHtml(t.description)}</p>`
    : '';
  const notes = t.notes
    ? `<p style="margin:4px 0 0;color:#64748b;font-size:13px;"><em>Notes:</em> ${escapeHtml(t.notes)}</p>`
    : '';
  return `<li style="margin:0 0 14px;">
  <strong>${index}. ${escapeHtml(t.name || 'Untitled task')}</strong>
  <div style="margin-top:4px;font-size:13px;color:#475569;">
    <span>Category: ${escapeHtml(t.category || '—')}</span> ·
    <span>Priority: ${escapeHtml(t.priority || 'Medium')}</span> ·
    <span>Role: ${escapeHtml(t.designation || '—')}</span> ·
    <span>Due: ${escapeHtml(t.targetDate || t.dueDate || 'TBD')}</span> ·
    <span>Status: ${escapeHtml(t.status || 'Assigned')}</span>
  </div>
  ${desc}${notes}
</li>`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** One email per assignee listing EVERY task they got in this send. */
function assignmentEmail(member, { projectName, tasks, by }) {
  const list = tasks || [];
  const count = list.length;
  const subject = `[Xerago IoT] ${count} task${count === 1 ? '' : 's'} assigned — ${projectName}`;

  const plainTasks = list.length
    ? list.map((t, i) => formatTaskPlain(t, i + 1)).join('\n\n')
    : '1. (see dashboard)';

  const text = `Hi ${member.name},

${by || 'Manager'} assigned you ${count} task${count === 1 ? '' : 's'} on "${projectName}".

Here is everything assigned to you in this update:

${plainTasks}

Open the command center: ${APP_URL}

— Xerago IoT Command Center`;

  const htmlTasks = list.length
    ? list.map((t, i) => formatTaskHtml(t, i + 1)).join('')
    : '<li>See dashboard</li>';

  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;color:#0f172a;line-height:1.45;">
  <p>Hi <strong>${escapeHtml(member.name)}</strong>,</p>
  <p><strong>${escapeHtml(by || 'Manager')}</strong> assigned you
    <strong>${count}</strong> task${count === 1 ? '' : 's'} on
    <strong>${escapeHtml(projectName)}</strong>.</p>
  <p style="margin-bottom:8px;">Here is <strong>everything assigned to you</strong> in this update:</p>
  <ol style="padding-left:18px;margin:0;">${htmlTasks}</ol>
  <p style="margin-top:18px;"><a href="${escapeHtml(APP_URL)}" style="color:#249e5e;font-weight:600;">Open Xerago IoT Command Center</a></p>
  <p style="color:#94a3b8;font-size:12px;">— Xerago IoT Command Center</p>
</div>`;

  return { subject, text, html };
}

function shareEmail(member, { fileName, projectName, by }) {
  const subject = `[Xerago IoT] Document shared — ${fileName}`;
  const text = `Hi ${member.name},

${by || 'Manager'} shared "${fileName}" with you on project "${projectName}".

Open Cloud Document Vault: ${APP_URL}

— Xerago IoT Command Center`;
  const html = `<p>Hi <strong>${escapeHtml(member.name)}</strong>,</p>
<p><strong>${escapeHtml(by || 'Manager')}</strong> shared <strong>${escapeHtml(fileName)}</strong> on project <strong>${escapeHtml(projectName)}</strong>.</p>
<p><a href="${escapeHtml(APP_URL)}">Open Cloud Document Vault</a></p>`;
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
