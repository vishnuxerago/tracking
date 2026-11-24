/**
 * Xerago Engineering Dashboard — open-source shared backend
 * Express + JWT auth + JSON DB + Socket.io realtime + Ollama AI
 */
const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const db = require('./db');
const ai = require('./ai');
const cloudVault = require('./cloudVault');
const mailer = require('./mailer');
cloudVault.ensureVault();

const PORT = process.env.PORT || 3847;
const JWT_SECRET = process.env.JWT_SECRET || 'xerago-open-source-dev-secret-change-me';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '16mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, accessLevel: user.accessLevel, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Login required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.accessLevel !== 'admin') {
    return res.status(403).json({ error: 'Admin / manager only' });
  }
  next();
}

function broadcast(event, payload) {
  io.emit(event, payload);
}

/** Manager / system updates → every connected teammate */
function notifyTeam(message, payload = {}) {
  io.emit('notify:team', { message, at: new Date().toISOString(), ...payload });
}

/** Teammate activity → admin/manager only */
function notifyAdmins(message, payload = {}) {
  io.to('role:admin').emit('notify:admin', { message, at: new Date().toISOString(), ...payload });
}

function memberName(id) {
  const m = db.get('team', id);
  return m ? m.name : id;
}

// ——— Auth ———
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const key = String(username || '').trim().toLowerCase();
  const user = db.getAll('team').find(
    (u) =>
      String(u.username || '').toLowerCase() === key ||
      String(u.email || '').toLowerCase() === key
  );
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  if (user.status !== 'Active') return res.status(403).json({ error: 'Account inactive' });
  const token = signToken(user);
  res.json({ token, user: db.publicUser(user) });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = db.get('team', req.user.id);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json({ user: db.publicUser(user) });
});

/** Change own password — hashed in server DB (never localStorage) */
app.post('/api/auth/change-password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const user = db.get('team', req.user.id);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (!bcrypt.compareSync(currentPassword || '', user.passwordHash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  const updated = {
    ...user,
    passwordHash: bcrypt.hashSync(String(newPassword), 10),
    mustChangePassword: false,
    passwordChangedAt: new Date().toISOString()
  };
  db.put('team', updated);
  db.logActivity(null, null, `${user.name} changed their password`, user.name);
  res.json({ ok: true, user: db.publicUser(updated) });
});

app.get('/api/health', async (_req, res) => {
  const ollama = await ai.checkOllama();
  res.json({
    ok: true,
    ai: ollama,
    mail: mailer.status(),
    stack: 'Node + Express + JSON DB + JWT + Socket.io + Ollama + SMTP mail (optional)'
  });
});

const READ_STORES = ['team', 'vendors', 'projects', 'tasks', 'blockers', 'documents', 'activity_log'];

/** Who can see a vault document */
function canSeeDocument(user, doc) {
  if (!doc) return false;
  if (user.accessLevel === 'admin') return true;
  if (doc.uploadedBy === user.id) return true;
  const share = doc.sharedWith || 'project';
  if (share === 'team' || share === 'all') return true;
  if (share === 'users') {
    return Array.isArray(doc.sharedWithIds) && doc.sharedWithIds.includes(user.id);
  }
  // project: anyone with a published task on this project
  if (share === 'project' || share === 'private') {
    if (doc.taskId) {
      const task = db.get('tasks', doc.taskId);
      if (task && task.responsibleId === user.id) return true;
    }
    if (share === 'project') {
      return db
        .getAll('tasks')
        .some((t) => t.projectId === doc.projectId && t.status !== 'Draft' && t.responsibleId === user.id);
    }
  }
  return false;
}

function publicDoc(doc) {
  if (!doc) return null;
  const { dataBase64, ...meta } = doc;
  return {
    ...meta,
    inCloud: !!(meta.storagePath || meta.cloudStored),
    sharedWith: meta.sharedWith || 'project',
    sharedWithIds: meta.sharedWithIds || [],
    revision: meta.revision || 'Rev A',
    versionGroupId: meta.versionGroupId || meta.id
  };
}

/** Rev A → Rev B → … → Rev Z → Rev AA */
function nextRevisionLabel(current) {
  const m = String(current || 'Rev A').match(/Rev\s*([A-Z]+)/i);
  let letters = (m ? m[1] : 'A').toUpperCase();
  const chars = letters.split('');
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] !== 'Z') {
      chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
      break;
    }
    chars[i] = 'A';
    i -= 1;
  }
  if (i < 0) chars.unshift('A');
  return `Rev ${chars.join('')}`;
}

function resolveVersionMeta({ projectId, name, fileName, versionOf, versionGroupId }) {
  const docs = db.getAll('documents').filter((d) => d.projectId === projectId);
  let parent = null;
  if (versionOf) parent = db.get('documents', versionOf);
  if (!parent && versionGroupId) {
    const group = docs.filter((d) => (d.versionGroupId || d.id) === versionGroupId);
    parent = group.sort((a, b) => String(b.revision || '').localeCompare(String(a.revision || ''))).slice(-1)[0]
      || group[group.length - 1];
  }
  if (!parent) {
    const key = String(name || fileName || '')
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[\s_-]*rev\s*[a-z]+$/i, '')
      .trim();
    if (key) {
      const matches = docs.filter((d) => {
        const n = String(d.name || d.fileName || '')
          .toLowerCase()
          .replace(/\.[a-z0-9]+$/i, '')
          .replace(/[\s_-]*rev\s*[a-z]+$/i, '')
          .trim();
        return n === key;
      });
      if (matches.length) {
        parent = matches.sort((a, b) => (b.versionIndex || 0) - (a.versionIndex || 0))[0];
      }
    }
  }
  if (!parent) {
    return { versionGroupId: null, revision: 'Rev A', versionIndex: 1, isNewVersion: false };
  }
  const groupId = parent.versionGroupId || parent.id;
  const siblings = docs.filter((d) => (d.versionGroupId || d.id) === groupId);
  const maxIdx = Math.max(0, ...siblings.map((d) => d.versionIndex || 1));
  const latest = siblings.sort((a, b) => (b.versionIndex || 0) - (a.versionIndex || 0))[0] || parent;
  return {
    versionGroupId: groupId,
    revision: nextRevisionLabel(latest.revision || 'Rev A'),
    versionIndex: maxIdx + 1,
    isNewVersion: true,
    replacesId: latest.id
  };
}

async function emailAssignees(byName, projectName, tasks) {
  const byUser = new Map();
  for (const t of tasks || []) {
    if (!t.responsibleId) continue;
    if (!byUser.has(t.responsibleId)) byUser.set(t.responsibleId, []);
    byUser.get(t.responsibleId).push(t);
  }
  const results = [];
  for (const [userId, userTasks] of byUser) {
    const member = db.get('team', userId);
    if (!member) continue;
    const content = mailer.assignmentEmail(member, {
      projectName,
      tasks: userTasks,
      by: byName
    });
    results.push(await mailer.notifyUser(member, content));
  }
  return results;
}

async function emailShareTargets(byName, doc, projectName, userIds) {
  const results = [];
  for (const id of userIds || []) {
    const member = db.get('team', id);
    if (!member) continue;
    const content = mailer.shareEmail(member, {
      fileName: doc.fileName || doc.name,
      projectName,
      by: byName
    });
    results.push(await mailer.notifyUser(member, content));
  }
  return results;
}

// ——— Remaining work / gap analysis (before generic :store) ———
app.get('/api/analytics/remaining', auth, (req, res) => {
  const projects = db.getAll('projects');
  const tasks = db.getAll('tasks');
  const team = db.getAll('team').map(db.publicUser);

  const activeTasks = tasks.filter((t) => t.status !== 'Draft');
  const byMember = team.map((m) => {
    const mine = activeTasks.filter((t) => t.responsibleId === m.id);
    const remaining = mine.filter((t) => t.status !== 'Completed');
    return {
      member: m,
      total: mine.length,
      remaining: remaining.length,
      completed: mine.filter((t) => t.status === 'Completed').length,
      submitted: mine.filter((t) => t.status === 'Submitted').length,
      tasks: remaining
    };
  });

  const byProject = projects.map((p) => {
    const pTasks = activeTasks.filter((t) => t.projectId === p.id);
    const remaining = pTasks.filter((t) => t.status !== 'Completed');
    const drafts = tasks.filter((t) => t.projectId === p.id && t.status === 'Draft').length;
    return {
      project: p,
      total: pTasks.length,
      remaining: remaining.length,
      completed: pTasks.length - remaining.length,
      drafts,
      pct: pTasks.length ? Math.round(((pTasks.length - remaining.length) / pTasks.length) * 100) : 0,
      byDesignation: team.map((m) => ({
        role: m.role,
        name: m.name,
        remaining: remaining.filter((t) => t.responsibleId === m.id).length
      }))
    };
  });

  const unfinished = activeTasks.filter((t) => t.status !== 'Completed');
  const awaitingVerification = activeTasks.filter((t) => t.status === 'Submitted');
  const pendingPlans = projects.filter((p) => p.status === 'Pending Approval');
  res.json({
    byMember,
    byProject,
    unfinishedCount: unfinished.length,
    unfinished,
    awaitingVerification,
    pendingPlans
  });
});

app.get('/api/vendors/recommend', auth, (req, res) => {
  const service = req.query.service || '';
  res.json(ai.recommendVendors(service));
});

function recalcProjectProgress(projectId) {
  const proj = db.get('projects', projectId);
  if (!proj) return null;
  const pTasks = db.getAll('tasks').filter((t) => t.projectId === projectId && t.status !== 'Draft');
  const done = pTasks.filter((t) => t.status === 'Completed').length;
  const pct = pTasks.length ? Math.round((done / pTasks.length) * 100) : 0;
  const updated = { ...proj, progressPct: pct };
  if (pTasks.length && done === pTasks.length) updated.status = 'Completed';
  else if (proj.status === 'Pending Approval' && pTasks.some((t) => t.status !== 'Draft')) updated.status = 'In Progress';
  db.put('projects', updated);
  return updated;
}

// ——— Projects: AI proposes plan first; tasks created only after manager confirms ———
app.post('/api/projects', auth, requireAdmin, async (req, res) => {
  try {
    const { name, type, description, customer, managerId, priority, targetDate } = req.body || {};
    if (!name || !type || !description) {
      return res.status(400).json({ error: 'name, type, and description are required' });
    }

    const proj = {
      id: db.uid('proj'),
      code: `XER-${new Date().getFullYear()}-${Math.floor(Math.random() * 90 + 10)}`,
      name,
      type,
      description,
      customer: customer || 'Internal',
      managerId: managerId || req.user.id,
      priority: priority || 'High',
      targetDate: targetDate || '',
      status: 'Pending Approval',
      progressPct: 0,
      planEngine: null,
      planModel: null,
      proposedPlan: null
    };
    db.put('projects', proj);

    const plan = await ai.proposePlanForProject(proj);
    proj.proposedPlan = {
      analysis: plan.analysis,
      tasks: plan.tasks,
      createdAt: new Date().toISOString()
    };
    proj.planEngine = plan.engine;
    proj.planModel = plan.model || null;
    db.put('projects', proj);

    const involved = (plan.analysis?.neededRoles || []).map((r) => r.role).join(', ');
    db.logActivity(
      proj.id,
      null,
      `AI analyzed "${name}" via ${plan.engine}: ${plan.tasks.length} proposed tasks for [${involved || 'n/a'}] — awaiting manager confirmation (no tasks created yet)`,
      req.user.name
    );

    broadcast('data:changed', { stores: ['projects', 'activity_log'], reason: 'plan_proposed' });
    res.status(201).json({
      project: proj,
      tasks: plan.tasks,
      analysis: plan.analysis,
      engine: plan.engine,
      model: plan.model,
      needsVerification: true,
      tasksCreated: false
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to create project' });
  }
});

app.post('/api/projects/:id/regenerate-tasks', auth, requireAdmin, async (req, res) => {
  try {
    const proj = db.get('projects', req.params.id);
    if (!proj) return res.status(404).json({ error: 'Project not found' });

    // Remove any unpublished leftovers; keep completed/assigned work unless force
    const oldDrafts = db.getAll('tasks').filter((t) => t.projectId === proj.id && t.status === 'Draft');
    for (const t of oldDrafts) db.remove('tasks', t.id);

    const plan = await ai.proposePlanForProject(proj);
    const updatedProj = {
      ...proj,
      status: 'Pending Approval',
      proposedPlan: { analysis: plan.analysis, tasks: plan.tasks, createdAt: new Date().toISOString() },
      planEngine: plan.engine,
      planModel: plan.model || null
    };
    db.put('projects', updatedProj);

    db.logActivity(
      proj.id,
      null,
      `Re-analyzed plan via ${plan.engine} (${plan.tasks.length} proposed tasks) — confirm before creating assignments`,
      req.user.name
    );
    broadcast('data:changed', { stores: ['projects', 'activity_log'], reason: 'plan_proposed' });
    res.json({
      tasks: plan.tasks,
      analysis: plan.analysis,
      engine: plan.engine,
      model: plan.model,
      project: updatedProj,
      needsVerification: true,
      tasksCreated: false
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Manager confirms AI proposal → NOW create & assign real tasks */
app.post('/api/projects/:id/publish-plan', auth, requireAdmin, async (req, res) => {
  const proj = db.get('projects', req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const proposed = proj.proposedPlan?.tasks || [];
  if (!proposed.length) {
    return res.status(400).json({ error: 'No AI proposal to confirm. Create/regenerate a plan first.' });
  }

  // Clear previous draft tasks if any
  db.getAll('tasks')
    .filter((t) => t.projectId === proj.id && t.status === 'Draft')
    .forEach((t) => db.remove('tasks', t.id));

  const edits = req.body?.taskEdits || {};
  const included = req.body?.includedTempIds; // optional allowlist
  let planTasks = proposed.map((t) => {
    const patch = edits[t.tempId] || {};
    return { ...t, ...patch, tempId: t.tempId };
  });
  if (Array.isArray(included) && included.length) {
    const allow = new Set(included);
    planTasks = planTasks.filter((t) => allow.has(t.tempId));
  }
  // Drop unchecked / unassigned
  planTasks = planTasks.filter((t) => t.responsibleId && t._exclude !== true);

  if (!planTasks.length) {
    return res.status(400).json({ error: 'Select at least one task with an assignee before confirming.' });
  }

  const published = ai.materializeTasks(proj.id, planTasks);
  for (const tk of published) {
    db.put('tasks', tk);
    broadcast('task:assigned', { task: tk, assigneeId: tk.responsibleId });
  }

  const involved = [...new Set(published.map((t) => memberName(t.responsibleId)))].join(', ');
  const updatedProj = {
    ...proj,
    status: 'In Progress',
    proposedPlan: { ...proj.proposedPlan, confirmedAt: new Date().toISOString(), confirmedBy: req.user.id }
  };
  db.put('projects', updatedProj);
  db.logActivity(
    proj.id,
    null,
    `Manager confirmed AI plan — created ${published.length} tasks for: ${involved}`,
    req.user.name
  );
  broadcast('data:changed', { stores: ['projects', 'tasks', 'activity_log'], reason: 'plan_published' });
  broadcast('progress:updated', { projectId: proj.id, reason: 'plan_published' });
  notifyTeam(`Manager published plan for "${proj.name}" — ${published.length} new task(s) assigned`, {
    reason: 'plan_published',
    projectId: proj.id
  });
  // Email each assignee with FULL task list for that person (SMTP if configured)
  let mailResults = [];
  try {
    mailResults = await emailAssignees(req.user.name, proj.name, published);
  } catch (err) {
    console.error('[mail] plan publish', err.message);
    mailResults = [{ ok: false, error: err.message }];
  }
  res.json({
    project: updatedProj,
    tasks: published,
    mail: mailer.status(),
    mailResults
  });
});

app.patch('/api/projects/:id', auth, requireAdmin, (req, res) => {
  const proj = db.get('projects', req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const updated = { ...proj, ...req.body, id: proj.id };
  db.put('projects', updated);
  broadcast('data:changed', { stores: ['projects'], reason: 'project_updated' });
  res.json(updated);
});

/** Soft-delete: archive project (keeps vault + tasks; hidden from active list) */
app.post('/api/projects/:id/archive', auth, requireAdmin, (req, res) => {
  const proj = db.get('projects', req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  if (proj.archived) return res.json(proj);
  const updated = {
    ...proj,
    archived: true,
    archivedAt: new Date().toISOString(),
    archivedBy: req.user.id,
    previousStatus: proj.status,
    status: 'Archived'
  };
  db.put('projects', updated);
  db.logActivity(proj.id, null, `Archived project "${proj.name}" (soft-delete)`, req.user.name);
  broadcast('data:changed', { stores: ['projects', 'activity_log'], reason: 'project_archived' });
  notifyTeam(`Manager archived project "${proj.name}"`, { reason: 'project_archived', projectId: proj.id });
  res.json(updated);
});

/** Restore archived project to active list */
app.post('/api/projects/:id/restore', auth, requireAdmin, (req, res) => {
  const proj = db.get('projects', req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  const updated = {
    ...proj,
    archived: false,
    archivedAt: null,
    archivedBy: null,
    status: proj.previousStatus && proj.previousStatus !== 'Archived' ? proj.previousStatus : 'In Progress'
  };
  delete updated.previousStatus;
  db.put('projects', updated);
  db.logActivity(proj.id, null, `Restored project "${proj.name}" from archive`, req.user.name);
  broadcast('data:changed', { stores: ['projects', 'activity_log'], reason: 'project_restored' });
  notifyTeam(`Manager restored project "${proj.name}"`, { reason: 'project_restored', projectId: proj.id });
  res.json(updated);
});

/** Hard delete — permanent (from archive or active) */
app.delete('/api/projects/:id', auth, requireAdmin, (req, res) => {
  const proj = db.get('projects', req.params.id);
  if (!proj) return res.status(404).json({ error: 'Project not found' });

  const tasks = db.getAll('tasks').filter((t) => t.projectId === proj.id);
  for (const t of tasks) db.remove('tasks', t.id);

  const blockers = db.getAll('blockers').filter((b) => b.projectId === proj.id);
  for (const b of blockers) db.remove('blockers', b.id);

  const docs = db.getAll('documents').filter((d) => d.projectId === proj.id);
  for (const d of docs) {
    if (d.storagePath) cloudVault.removeFile(d.storagePath);
    db.remove('documents', d.id);
  }
  cloudVault.removeProjectFiles(proj.id);

  db.remove('projects', proj.id);
  db.logActivity(null, null, `Permanently deleted project "${proj.name}" and related data`, req.user.name);
  broadcast('data:changed', {
    stores: ['projects', 'tasks', 'blockers', 'documents', 'activity_log'],
    reason: 'project_deleted'
  });
  res.json({ ok: true, deleted: proj.id });
});

/** Due-date reminders — overdue + due within N days */
app.get('/api/reminders/due', auth, (req, res) => {
  const days = Math.min(30, Math.max(1, Number(req.query.days) || 3));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const soon = new Date(today);
  soon.setDate(soon.getDate() + days);

  const isAdmin = req.user.accessLevel === 'admin';
  let tasks = db.getAll('tasks').filter((t) => t.status !== 'Draft' && t.status !== 'Completed' && t.targetDate);
  if (!isAdmin) tasks = tasks.filter((t) => t.responsibleId === req.user.id);

  const projects = db.getAll('projects').filter((p) => !p.archived);
  const overdue = [];
  const dueSoon = [];
  for (const t of tasks) {
    const proj = projects.find((p) => p.id === t.projectId);
    if (!proj) continue;
    const d = new Date(t.targetDate);
    if (Number.isNaN(d.getTime())) continue;
    d.setHours(0, 0, 0, 0);
    const row = {
      taskId: t.id,
      taskName: t.name,
      projectId: t.projectId,
      projectName: proj.name,
      targetDate: t.targetDate,
      status: t.status,
      responsibleId: t.responsibleId,
      daysOverdue: Math.round((today - d) / 86400000),
      daysUntil: Math.round((d - today) / 86400000)
    };
    if (d < today) overdue.push(row);
    else if (d <= soon) dueSoon.push(row);
  }

  let projectReminders = [];
  if (isAdmin) {
    for (const p of projects) {
      if (!p.targetDate) continue;
      const d = new Date(p.targetDate);
      if (Number.isNaN(d.getTime())) continue;
      d.setHours(0, 0, 0, 0);
      if (d < today || d <= soon) {
        projectReminders.push({
          projectId: p.id,
          projectName: p.name,
          targetDate: p.targetDate,
          overdue: d < today,
          daysUntil: Math.round((d - today) / 86400000)
        });
      }
    }
  }

  res.json({ overdue, dueSoon, projectReminders, daysWindow: days, checkedAt: new Date().toISOString() });
});

// ——— Tasks (manager assigns; members update own) ———
app.post('/api/tasks', auth, requireAdmin, (req, res) => {
  const body = req.body || {};
  if (!body.projectId || !body.name) return res.status(400).json({ error: 'projectId and name required' });
  const task = {
    id: db.uid('task'),
    projectId: body.projectId,
    name: body.name,
    description: body.description || '',
    category: body.category || 'Requirements',
    responsibleId: body.responsibleId || null,
    supportIds: body.supportIds || [],
    isExternal: !!body.isExternal,
    externalVendorId: body.externalVendorId || null,
    priority: body.priority || 'Medium',
    status: body.status || 'Assigned',
    startDate: body.startDate || new Date().toISOString().slice(0, 10),
    targetDate: body.targetDate || '',
    dependencies: body.dependencies || [],
    notes: body.notes || '',
    designation: body.designation || ''
  };
  db.put('tasks', task);
  db.logActivity(task.projectId, task.id, `Assigned task "${task.name}" to ${memberName(task.responsibleId)}`, req.user.name);
  broadcast('data:changed', { stores: ['tasks', 'activity_log'], reason: 'task_assigned', task });
  broadcast('task:assigned', { task, assigneeId: task.responsibleId });
  const proj = db.get('projects', task.projectId);
  if (task.responsibleId) {
    emailAssignees(req.user.name, proj?.name || 'Project', [task]).catch((err) =>
      console.error('[mail] task assign', err.message)
    );
  }
  res.status(201).json(task);
});

app.put('/api/tasks/:id', auth, (req, res) => {
  const existing = db.get('tasks', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });

  const isAdmin = req.user.accessLevel === 'admin';
  const isOwner = existing.responsibleId === req.user.id;
  if (!isAdmin && !isOwner) {
    return res.status(403).json({ error: 'You can only update tasks assigned to you' });
  }

  // Members cannot self-complete — must submit for manager verification
  if (!isAdmin && req.body.status === 'Completed') {
    return res.status(400).json({ error: 'Submit work with documents for manager verification instead of marking Completed' });
  }
  if (!isAdmin && existing.status === 'Draft') {
    return res.status(403).json({ error: 'Draft plan not published yet' });
  }

  let updated;
  if (isAdmin) {
    updated = { ...existing, ...req.body, id: existing.id, projectId: existing.projectId };
  } else {
    const allowedStatus = ['Assigned', 'Not Started', 'In Progress', 'Waiting', 'Blocked', 'Testing'];
    const nextStatus = req.body.status != null ? req.body.status : existing.status;
    if (req.body.status && !allowedStatus.includes(req.body.status) && req.body.status !== existing.status) {
      return res.status(400).json({ error: 'Use Submit for Review to send completed work to the manager' });
    }
    updated = {
      ...existing,
      status: nextStatus,
      notes: req.body.notes != null ? req.body.notes : existing.notes
    };
  }

  db.put('tasks', updated);
  recalcProjectProgress(updated.projectId);

  const assigneeChanged = isAdmin && req.body.responsibleId && req.body.responsibleId !== existing.responsibleId;
  if (assigneeChanged) {
    db.logActivity(
      updated.projectId,
      updated.id,
      `Reassigned "${updated.name}" to ${memberName(updated.responsibleId)}`,
      req.user.name
    );
    broadcast('task:assigned', { task: updated, assigneeId: updated.responsibleId });
    const proj = db.get('projects', updated.projectId);
    emailAssignees(req.user.name, proj?.name || 'Project', [updated]).catch((err) =>
      console.error('[mail] reassign', err.message)
    );
  } else {
    db.logActivity(updated.projectId, updated.id, `Progress update on "${updated.name}" → ${updated.status}`, req.user.name);
  }

  broadcast('data:changed', { stores: ['tasks', 'projects', 'activity_log'], reason: 'task_updated', task: updated });
  broadcast('progress:updated', { projectId: updated.projectId, task: updated, by: req.user.name });
  if (isAdmin) {
    notifyTeam(`Manager updated "${updated.name}" → ${updated.status}`, { reason: 'manager_update', taskId: updated.id });
  } else {
    notifyAdmins(`${req.user.name} updated "${updated.name}" → ${updated.status}`, {
      reason: 'member_progress',
      taskId: updated.id
    });
  }
  res.json(updated);
});

/** Teammate submits completed work + documents for manager verification */
app.post('/api/tasks/:id/submit', auth, (req, res) => {
  const existing = db.get('tasks', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });
  if (existing.status === 'Draft') return res.status(400).json({ error: 'Task is still a draft' });
  if (existing.status === 'Completed') return res.status(400).json({ error: 'Already completed' });

  const isAdmin = req.user.accessLevel === 'admin';
  const isOwner = existing.responsibleId === req.user.id;
  if (!isAdmin && !isOwner) return res.status(403).json({ error: 'Only the assignee can submit this task' });

  const { notes, documents } = req.body || {};
  const docs = Array.isArray(documents) ? documents : [];
  if (!docs.length) {
    return res.status(400).json({ error: 'Attach at least one document showing the work done' });
  }

  const savedDocIds = [];
  for (const d of docs) {
    if (!d.fileName || !d.dataBase64) continue;
    // Cap ~12MB raw ≈ 16MB base64
    if (String(d.dataBase64).length > 16_000_000) {
      return res.status(400).json({ error: `File too large: ${d.fileName}` });
    }
    const docId = db.uid('doc');
    let stored;
    try {
      stored = cloudVault.storeBase64({
        docId,
        projectId: existing.projectId,
        fileName: d.fileName,
        mimeType: d.mimeType,
        dataBase64: d.dataBase64
      });
    } catch (err) {
      return res.status(500).json({ error: `Cloud upload failed: ${err.message}` });
    }
    const doc = {
      id: docId,
      taskId: existing.id,
      projectId: existing.projectId,
      name: d.name || d.fileName,
      fileName: stored.fileName,
      mimeType: stored.mimeType,
      storagePath: stored.storagePath,
      cloudStored: true,
      fileSize: d.fileSize || `${Math.max(1, Math.round(stored.bytes / 1024))} KB`,
      bytes: stored.bytes,
      uploadedBy: req.user.id,
      uploadedByName: req.user.name,
      dateAdded: new Date().toISOString().slice(0, 10),
      category: 'Task Deliverable',
      // Progress uploads show project-wise in Cloud Document Vault
      sharedWith: 'project',
      sharedWithIds: [],
      revision: 'Rev A',
      versionIndex: 1,
      versionGroupId: docId
    };
    // Auto-bump revision if same title already exists on this project
    const ver = resolveVersionMeta({
      projectId: existing.projectId,
      name: doc.name,
      fileName: doc.fileName
    });
    if (ver.isNewVersion) {
      doc.revision = ver.revision;
      doc.versionIndex = ver.versionIndex;
      doc.versionGroupId = ver.versionGroupId;
      doc.replacesId = ver.replacesId;
    } else {
      doc.versionGroupId = docId;
    }
    db.put('documents', doc);
    savedDocIds.push(doc.id);
  }
  if (!savedDocIds.length) return res.status(400).json({ error: 'No valid documents uploaded' });

  const updated = {
    ...existing,
    status: 'Submitted',
    notes: notes != null ? notes : existing.notes,
    documentIds: [...(existing.documentIds || []), ...savedDocIds],
    submittedAt: new Date().toISOString(),
    submittedBy: req.user.id
  };
  db.put('tasks', updated);
  recalcProjectProgress(updated.projectId);
  db.logActivity(
    updated.projectId,
    updated.id,
    `${req.user.name} submitted "${updated.name}" with ${savedDocIds.length} document(s) — awaiting manager verification`,
    req.user.name
  );
  broadcast('data:changed', {
    stores: ['tasks', 'documents', 'projects', 'activity_log'],
    reason: 'task_submitted',
    task: updated
  });
  broadcast('progress:updated', { projectId: updated.projectId, task: updated, by: req.user.name, awaitingVerification: true });
  notifyAdmins(`${req.user.name} submitted "${updated.name}" with ${savedDocIds.length} file(s) — verify in PM Command`, {
    reason: 'task_submitted',
    taskId: updated.id,
    documentIds: savedDocIds
  });
  res.json({ task: updated, documentIds: savedDocIds });
});

/** Manager verifies submitted work → marks process completed */
app.post('/api/tasks/:id/verify', auth, requireAdmin, (req, res) => {
  const existing = db.get('tasks', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });
  if (existing.status !== 'Submitted' && existing.status !== 'Review') {
    return res.status(400).json({ error: 'Task must be Submitted before manager can verify' });
  }
  const updated = {
    ...existing,
    status: 'Completed',
    verifiedAt: new Date().toISOString(),
    verifiedBy: req.user.id,
    notes: req.body?.notes != null ? req.body.notes : existing.notes
  };
  db.put('tasks', updated);
  const proj = recalcProjectProgress(updated.projectId);
  db.logActivity(updated.projectId, updated.id, `Manager verified & completed "${updated.name}"`, req.user.name);
  broadcast('data:changed', { stores: ['tasks', 'projects', 'activity_log'], reason: 'task_verified', task: updated });
  broadcast('progress:updated', { projectId: updated.projectId, task: updated, by: req.user.name, verified: true });
  notifyTeam(`Manager verified & completed "${updated.name}"`, { reason: 'task_verified', taskId: updated.id });
  res.json({ task: updated, project: proj });
});

/** Manager rejects submission → teammate must rework */
app.post('/api/tasks/:id/reject', auth, requireAdmin, (req, res) => {
  const existing = db.get('tasks', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });
  const reason = (req.body && req.body.reason) || 'Needs rework';
  const updated = {
    ...existing,
    status: 'In Progress',
    notes: `${existing.notes || ''}\n\n[Manager rework] ${reason}`.trim(),
    submittedAt: null
  };
  db.put('tasks', updated);
  db.logActivity(updated.projectId, updated.id, `Manager sent "${updated.name}" back for rework: ${reason}`, req.user.name);
  broadcast('data:changed', { stores: ['tasks', 'activity_log'], reason: 'task_rejected', task: updated });
  broadcast('task:assigned', { task: updated, assigneeId: updated.responsibleId });
  broadcast('progress:updated', { projectId: updated.projectId, task: updated, by: req.user.name, rejected: true });
  notifyTeam(`Manager sent "${updated.name}" back for rework: ${reason}`, {
    reason: 'task_rejected',
    taskId: updated.id
  });
  res.json(updated);
});

app.delete('/api/tasks/:id', auth, requireAdmin, (req, res) => {
  const existing = db.get('tasks', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Task not found' });
  db.remove('tasks', existing.id);
  recalcProjectProgress(existing.projectId);
  db.logActivity(existing.projectId, existing.id, `Deleted task "${existing.name}"`, req.user.name);
  broadcast('data:changed', { stores: ['tasks', 'projects', 'activity_log'], reason: 'task_deleted' });
  res.json({ ok: true });
});

app.get('/api/documents/:id/download', auth, (req, res) => {
  const doc = db.get('documents', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (!canSeeDocument(req.user, doc)) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  // Prefer cloud vault file on disk
  if (doc.storagePath) {
    const file = cloudVault.readFile(doc.storagePath);
    if (file) {
      res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${doc.fileName || 'document'}"`);
      return res.send(file.buffer);
    }
  }

  // Legacy base64 fallback
  if (doc.dataBase64) {
    return res.json({
      id: doc.id,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      dataBase64: doc.dataBase64,
      name: doc.name
    });
  }
  return res.status(404).json({ error: 'File missing from cloud vault' });
});

/** Vault storage usage (server disk under data/cloud-vault) */
app.get('/api/cloud-vault/stats', auth, (req, res) => {
  const maxMb = Number(process.env.VAULT_MAX_MB || 5120);
  const maxBytes = Math.max(50, maxMb) * 1024 * 1024;
  let usedBytes = 0;
  const docs = db.getAll('documents');
  for (const d of docs) {
    if (d.bytes) usedBytes += Number(d.bytes) || 0;
    else if (d.storagePath) {
      const file = cloudVault.readFile(d.storagePath);
      if (file?.buffer) usedBytes += file.buffer.length;
    }
  }
  res.json({
    usedBytes,
    maxBytes,
    usedMb: Math.round((usedBytes / (1024 * 1024)) * 100) / 100,
    maxMb,
    fileCount: docs.filter((d) => d.cloudStored || d.storagePath).length,
    vaultRoot: 'data/cloud-vault',
    note: 'Soft quota on server disk (default 5 GB). Raise VAULT_MAX_MB if the machine has space.'
  });
});

/** Cloud vault list — project-wise; latest rev + version history */
app.get('/api/cloud-vault', auth, (req, res) => {
  const all = db.getAll('documents').map(publicDoc).filter((d) => canSeeDocument(req.user, d));
  const projects = db.getAll('projects').filter((p) => !p.archived || req.user.accessLevel === 'admin');
  const byProject = {};
  for (const d of all) {
    const key = d.projectId || 'general';
    if (!byProject[key]) {
      const proj = projects.find((p) => p.id === key);
      byProject[key] = {
        projectId: key,
        projectName: proj ? proj.name : 'General',
        documents: []
      };
    }
    byProject[key].documents.push(d);
  }
  // Attach version families (grouped)
  for (const group of Object.values(byProject)) {
    const families = {};
    for (const d of group.documents) {
      const gid = d.versionGroupId || d.id;
      if (!families[gid]) families[gid] = [];
      families[gid].push(d);
    }
    group.families = Object.values(families).map((vers) => {
      const sorted = vers.sort((a, b) => (b.versionIndex || 0) - (a.versionIndex || 0));
      return { versionGroupId: sorted[0].versionGroupId || sorted[0].id, latest: sorted[0], versions: sorted };
    });
  }
  res.json({
    documents: all,
    byProject: Object.values(byProject),
    vaultRoot: 'data/cloud-vault',
    mail: mailer.status()
  });
});

/** Direct Cloud Document Vault upload (admin + teammates) */
app.post('/api/documents/upload', auth, (req, res) => {
  const {
    projectId,
    name,
    category,
    fileName,
    mimeType,
    dataBase64,
    fileSize,
    taskId,
    sharedWith,
    sharedWithIds,
    versionOf,
    versionGroupId,
    asNewVersion,
    forceNew
  } = req.body || {};
  if (!projectId || !fileName || !dataBase64) {
    return res.status(400).json({ error: 'projectId, fileName, and file data are required' });
  }
  const proj = db.get('projects', projectId);
  if (!proj) return res.status(404).json({ error: 'Project not found' });
  if (proj.archived) return res.status(400).json({ error: 'Project is archived — restore it first' });
  if (String(dataBase64).length > 16_000_000) {
    return res.status(400).json({ error: 'File too large (max ~12MB per file)' });
  }

  const maxMb = Number(process.env.VAULT_MAX_MB || 5120);
  const maxBytes = Math.max(50, maxMb) * 1024 * 1024;
  let usedBytes = 0;
  for (const d of db.getAll('documents')) usedBytes += Number(d.bytes) || 0;
  const incoming = Buffer.from(dataBase64, 'base64').length;
  if (usedBytes + incoming > maxBytes) {
    return res.status(400).json({
      error: `Cloud vault full (${Math.round(usedBytes / 1048576)} MB / ${maxMb} MB). Delete files or set VAULT_MAX_MB higher.`
    });
  }

  let share = 'project';
  let shareIds = [];
  if (req.user.accessLevel === 'admin') {
    share = ['project', 'team', 'users', 'private'].includes(sharedWith) ? sharedWith : 'team';
    shareIds = share === 'users' && Array.isArray(sharedWithIds) ? sharedWithIds.filter(Boolean) : [];
  }

  let versionMeta = { versionGroupId: null, revision: 'Rev A', versionIndex: 1, isNewVersion: false };
  if (!forceNew) {
    versionMeta = resolveVersionMeta({
      projectId,
      name: name || fileName,
      fileName,
      versionOf: versionOf || null,
      versionGroupId: versionGroupId || null
    });
    if (asNewVersion && !versionMeta.isNewVersion && versionOf) {
      versionMeta = resolveVersionMeta({ projectId, name, fileName, versionOf });
    }
  }

  const docId = db.uid('doc');
  let stored;
  try {
    stored = cloudVault.storeBase64({
      docId,
      projectId,
      fileName,
      mimeType,
      dataBase64
    });
  } catch (err) {
    return res.status(500).json({ error: `Cloud upload failed: ${err.message}` });
  }

  const groupId = versionMeta.versionGroupId || docId;
  const doc = {
    id: docId,
    taskId: taskId || null,
    projectId,
    name: name || fileName,
    fileName: stored.fileName,
    mimeType: stored.mimeType,
    storagePath: stored.storagePath,
    cloudStored: true,
    fileSize: fileSize || `${Math.max(1, Math.round(stored.bytes / 1024))} KB`,
    bytes: stored.bytes,
    uploadedBy: req.user.id,
    uploadedByName: req.user.name,
    dateAdded: new Date().toISOString().slice(0, 10),
    category: category || 'Artifact',
    sharedWith: share,
    sharedWithIds: shareIds,
    revision: versionMeta.revision,
    versionIndex: versionMeta.versionIndex || 1,
    versionGroupId: groupId,
    replacesId: versionMeta.replacesId || null
  };
  db.put('documents', doc);
    db.logActivity(
    projectId,
    taskId || null,
    `${req.user.name} uploaded "${doc.fileName}" (${doc.revision}) to cloud vault (${share}${shareIds.length ? ` → ${shareIds.length} people` : ''})`,
    req.user.name
  );
  broadcast('data:changed', { stores: ['documents', 'activity_log'], reason: 'document_uploaded', docId: doc.id });

  if (req.user.accessLevel === 'admin') {
    if (share === 'team') {
      notifyTeam(`Manager shared "${doc.fileName}" in vault (${proj.name})`, {
        reason: 'vault_share',
        docId: doc.id
      });
      const teamIds = db
        .getAll('team')
        .filter((t) => t.status === 'Active' && t.id !== req.user.id)
        .map((t) => t.id);
      emailShareTargets(req.user.name, doc, proj.name, teamIds).catch(() => {});
    } else if (share === 'users' && shareIds.length) {
      for (const uid of shareIds) {
        io.to(`user:${uid}`).emit('notify:team', {
          message: `Manager shared "${doc.fileName}" with you (${proj.name})`,
          reason: 'vault_share',
          docId: doc.id
        });
      }
      emailShareTargets(req.user.name, doc, proj.name, shareIds).catch(() => {});
    } else if (share === 'project') {
      notifyTeam(`Manager uploaded "${doc.fileName}" for project ${proj.name}`, {
        reason: 'vault_upload',
        docId: doc.id
      });
    }
  } else {
    notifyAdmins(`${req.user.name} uploaded "${doc.fileName}" to vault (${proj.name})`, {
      reason: 'vault_upload',
      docId: doc.id
    });
  }

  res.status(201).json({ document: publicDoc(doc), cloudPath: stored.storagePath });
});

/** Admin deletes a vault document (file + DB record) */
app.delete('/api/documents/:id', auth, requireAdmin, (req, res) => {
  const doc = db.get('documents', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.storagePath) cloudVault.removeFile(doc.storagePath);
  db.remove('documents', doc.id);
  db.logActivity(
    doc.projectId,
    doc.taskId,
    `Admin deleted vault file "${doc.fileName || doc.name}" (${doc.revision || 'Rev A'})`,
    req.user.name
  );
  broadcast('data:changed', { stores: ['documents', 'activity_log'], reason: 'document_deleted', docId: doc.id });
  res.json({ ok: true, deleted: doc.id });
});

/** Admin shares an existing vault file with person(s) or whole team */
app.post('/api/documents/:id/share', auth, requireAdmin, (req, res) => {
  const doc = db.get('documents', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const { sharedWith, sharedWithIds } = req.body || {};
  const share = ['project', 'team', 'users', 'private'].includes(sharedWith) ? sharedWith : 'team';
  const shareIds = share === 'users' && Array.isArray(sharedWithIds) ? sharedWithIds.filter(Boolean) : [];
  const updated = { ...doc, sharedWith: share, sharedWithIds: shareIds };
  db.put('documents', updated);
  const proj = db.get('projects', doc.projectId);
  db.logActivity(
    doc.projectId,
    doc.taskId,
    `Manager shared "${doc.fileName}" → ${share}${shareIds.length ? ` (${shareIds.length})` : ''}`,
    req.user.name
  );
  broadcast('data:changed', { stores: ['documents', 'activity_log'], reason: 'document_shared', docId: doc.id });

  if (share === 'team') {
    notifyTeam(`Manager shared "${doc.fileName}" with the team (${proj?.name || 'project'})`, {
      reason: 'vault_share',
      docId: doc.id
    });
    const teamIds = db
      .getAll('team')
      .filter((t) => t.status === 'Active' && t.id !== req.user.id)
      .map((t) => t.id);
    emailShareTargets(req.user.name, updated, proj?.name || 'Project', teamIds).catch(() => {});
  } else if (share === 'users' && shareIds.length) {
    for (const uid of shareIds) {
      io.to(`user:${uid}`).emit('notify:team', {
        message: `Manager shared "${doc.fileName}" with you`,
        reason: 'vault_share',
        docId: doc.id
      });
    }
    emailShareTargets(req.user.name, updated, proj?.name || 'Project', shareIds).catch(() => {});
  }

  res.json({ document: publicDoc(updated) });
});

// ——— Team (admin edits; everyone can read via /api/team) ———
app.post('/api/team', auth, requireAdmin, (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.role) return res.status(400).json({ error: 'name and role required' });
  const username = (body.username || body.name.split(/\s+/)[0] || 'user').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (db.getAll('team').some((t) => t.username === username)) {
    return res.status(400).json({ error: 'Username already exists' });
  }
  const bcrypt = require('bcryptjs');
  const member = {
    id: db.uid('tm'),
    name: body.name,
    username,
    passwordHash: bcrypt.hashSync(body.password || 'team123', 10),
    role: body.role,
    accessLevel: body.accessLevel === 'admin' ? 'admin' : 'member',
    skills: Array.isArray(body.skills) ? body.skills : String(body.skills || '').split(',').map((s) => s.trim()).filter(Boolean),
    responsibilities: body.responsibilities || '',
    email: body.email || '',
    status: body.status === 'Inactive' ? 'Inactive' : 'Active'
  };
  db.put('team', member);
  db.logActivity(null, null, `Admin added team member "${member.name}" (${member.role}) · ${member.status}`, req.user.name);
  broadcast('data:changed', { stores: ['team', 'activity_log'], reason: 'team_updated' });
  res.status(201).json(db.publicUser(member));
});

app.put('/api/team/:id', auth, requireAdmin, (req, res) => {
  const existing = db.get('team', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Team member not found' });
  const body = req.body || {};

  if (body.status === 'Inactive' && existing.accessLevel === 'admin') {
    const otherAdmins = db.getAll('team').filter((t) => t.accessLevel === 'admin' && t.status === 'Active' && t.id !== existing.id);
    if (!otherAdmins.length) {
      return res.status(400).json({ error: 'Cannot deactivate the only active admin' });
    }
  }

  const updated = {
    ...existing,
    name: body.name != null ? body.name : existing.name,
    role: body.role != null ? body.role : existing.role,
    email: body.email != null ? body.email : existing.email,
    responsibilities: body.responsibilities != null ? body.responsibilities : existing.responsibilities,
    skills:
      body.skills != null
        ? Array.isArray(body.skills)
          ? body.skills
          : String(body.skills).split(',').map((s) => s.trim()).filter(Boolean)
        : existing.skills,
    status: body.status === 'Inactive' ? 'Inactive' : body.status === 'Active' ? 'Active' : existing.status,
    accessLevel:
      body.accessLevel === 'admin' || body.accessLevel === 'member' ? body.accessLevel : existing.accessLevel
  };

  if (body.password) {
    const bcrypt = require('bcryptjs');
    updated.passwordHash = bcrypt.hashSync(body.password, 10);
  }

  db.put('team', updated);
  db.logActivity(
    null,
    null,
    `Admin updated "${updated.name}" → ${updated.status} / ${updated.role}`,
    req.user.name
  );
  broadcast('data:changed', { stores: ['team', 'activity_log'], reason: 'team_updated' });
  res.json(db.publicUser(updated));
});

// ——— Vendors (admin add / edit / delete) ———
function vendorFromBody(body, existing) {
  return {
    id: existing ? existing.id : db.uid('v'),
    name: body.name,
    company: body.company != null ? body.company : existing?.company || '',
    role: body.role != null ? body.role : existing?.role || '',
    category: body.category || existing?.category,
    services: Array.isArray(body.services) ? body.services : existing?.services || [],
    mobile: body.mobile != null ? body.mobile : existing?.mobile || '',
    whatsapp: body.whatsapp != null ? body.whatsapp : existing?.whatsapp || '',
    email: body.email != null ? body.email : existing?.email || '',
    website: body.website != null ? body.website : existing?.website || '',
    rating: body.rating != null ? Number(body.rating) : existing?.rating || 4,
    reliability: body.reliability || existing?.reliability || 'High',
    leadTime: body.leadTime || existing?.leadTime || 'Standard',
    status: body.status === 'Inactive' ? 'Inactive' : body.status === 'Active' ? 'Active' : existing?.status || 'Active',
    notes: body.notes != null ? body.notes : existing?.notes || ''
  };
}

app.post('/api/vendors', auth, requireAdmin, (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.category) return res.status(400).json({ error: 'name and category required' });
  const vendor = vendorFromBody(body, null);
  db.put('vendors', vendor);
  db.logActivity(null, null, `Added vendor "${vendor.name}"`, req.user.name);
  broadcast('data:changed', { stores: ['vendors', 'activity_log'], reason: 'vendor_added' });
  res.status(201).json(vendor);
});

app.put('/api/vendors/:id', auth, requireAdmin, (req, res) => {
  const existing = db.get('vendors', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Vendor not found' });
  const body = req.body || {};
  if (!body.name || !body.category) return res.status(400).json({ error: 'name and category required' });
  const vendor = vendorFromBody(body, existing);
  db.put('vendors', vendor);
  db.logActivity(null, null, `Updated vendor "${vendor.name}" (${vendor.status})`, req.user.name);
  broadcast('data:changed', { stores: ['vendors', 'activity_log'], reason: 'vendor_updated' });
  res.json(vendor);
});

app.delete('/api/vendors/:id', auth, requireAdmin, (req, res) => {
  const existing = db.get('vendors', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Vendor not found' });
  db.remove('vendors', existing.id);
  db.logActivity(null, null, `Deleted vendor "${existing.name}"`, req.user.name);
  broadcast('data:changed', { stores: ['vendors', 'activity_log'], reason: 'vendor_deleted' });
  res.json({ ok: true });
});

// ——— Blockers ———
app.post('/api/blockers', auth, (req, res) => {
  const body = req.body || {};
  const ownerId = body.ownerId || body.assignedTo || req.user.id;
  const owner = db.get('team', ownerId);
  const reporter = db.get('team', req.user.id);
  const blocker = {
    id: db.uid('blk'),
    projectId: body.projectId,
    description: body.description,
    priority: body.priority || 'High',
    status: 'Active',
    dateIdentified: new Date().toISOString().slice(0, 10),
    reportedBy: req.user.id,
    reportedByName: reporter ? reporter.name : req.user.name,
    reportedByUsername: reporter ? reporter.username : req.user.username,
    ownerId,
    ownerName: owner ? owner.name : req.user.name,
    ownerUsername: owner ? owner.username : req.user.username,
    resolutionNotes: '',
    resolutionDocumentIds: []
  };
  db.put('blockers', blocker);
  db.logActivity(
    blocker.projectId,
    null,
    `Reported blocker: "${blocker.description}" → assigned to ${blocker.ownerName} (@${blocker.ownerUsername})`,
    req.user.name
  );
  broadcast('data:changed', { stores: ['blockers', 'activity_log'], reason: 'blocker_added' });
  // Notify assigned owner
  if (ownerId && ownerId !== req.user.id) {
    io.to(`user:${ownerId}`).emit('notify:team', {
      message: `${req.user.name} assigned you a blocker to resolve: "${blocker.description}"`,
      reason: 'blocker_assigned',
      blockerId: blocker.id
    });
  }
  if (req.user.accessLevel === 'admin') {
    notifyTeam(`Manager flagged blocker: "${blocker.description}" (owner: @${blocker.ownerUsername})`, {
      reason: 'blocker_added',
      blockerId: blocker.id
    });
  } else {
    notifyAdmins(`${req.user.name} reported blocker → owner @${blocker.ownerUsername}: "${blocker.description}"`, {
      reason: 'blocker_added',
      blockerId: blocker.id
    });
  }
  res.status(201).json(blocker);
});

/** Only the assigned owner can resolve — needs description + optional files */
app.post('/api/blockers/:id/resolve', auth, (req, res) => {
  const existing = db.get('blockers', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Blocker not found' });
  if (existing.status === 'Resolved') return res.status(400).json({ error: 'Already resolved' });

  const ownerId = existing.ownerId || existing.reportedBy;
  if (req.user.id !== ownerId) {
    return res.status(403).json({
      error: `Only the assigned owner (@${existing.ownerUsername || 'owner'}) can resolve this blocker`
    });
  }

  const notes = String(req.body?.resolutionNotes || req.body?.notes || '').trim();
  if (!notes) {
    return res.status(400).json({ error: 'Resolution description is required — explain how you resolved it' });
  }

  const docs = Array.isArray(req.body?.documents) ? req.body.documents : [];
  const savedDocIds = [];
  for (const d of docs) {
    if (!d.fileName || !d.dataBase64) continue;
    if (String(d.dataBase64).length > 16_000_000) {
      return res.status(400).json({ error: `File too large: ${d.fileName}` });
    }
    const docId = db.uid('doc');
    let stored;
    try {
      stored = cloudVault.storeBase64({
        docId,
        projectId: existing.projectId,
        fileName: d.fileName,
        mimeType: d.mimeType,
        dataBase64: d.dataBase64
      });
    } catch (err) {
      return res.status(500).json({ error: `Upload failed: ${err.message}` });
    }
    const doc = {
      id: docId,
      taskId: null,
      projectId: existing.projectId,
      name: d.name || d.fileName,
      fileName: stored.fileName,
      mimeType: stored.mimeType,
      storagePath: stored.storagePath,
      cloudStored: true,
      fileSize: d.fileSize || `${Math.max(1, Math.round(stored.bytes / 1024))} KB`,
      bytes: stored.bytes,
      uploadedBy: req.user.id,
      uploadedByName: req.user.name,
      dateAdded: new Date().toISOString().slice(0, 10),
      category: 'Blocker Resolution',
      sharedWith: 'project',
      sharedWithIds: [],
      revision: 'Rev A',
      versionIndex: 1,
      versionGroupId: docId,
      blockerId: existing.id
    };
    db.put('documents', doc);
    savedDocIds.push(doc.id);
  }

  const updated = {
    ...existing,
    status: 'Resolved',
    resolutionNotes: notes,
    resolutionDocumentIds: [...(existing.resolutionDocumentIds || []), ...savedDocIds],
    resolvedAt: new Date().toISOString(),
    resolvedBy: req.user.id,
    resolvedByName: req.user.name,
    resolvedByUsername: req.user.username
  };
  db.put('blockers', updated);
  db.logActivity(
    existing.projectId,
    null,
    `@${req.user.username} resolved blocker: "${existing.description}" — ${notes}${savedDocIds.length ? ` (${savedDocIds.length} file(s))` : ''}`,
    req.user.name
  );
  broadcast('data:changed', {
    stores: ['blockers', 'documents', 'activity_log'],
    reason: 'blocker_resolved',
    blockerId: updated.id
  });
  notifyAdmins(
    `@${req.user.username} resolved blocker: "${existing.description}"`,
    { reason: 'blocker_resolved', blockerId: updated.id }
  );
  if (existing.reportedBy && existing.reportedBy !== req.user.id) {
    io.to(`user:${existing.reportedBy}`).emit('notify:team', {
      message: `@${req.user.username} resolved your blocker: "${existing.description}"`,
      reason: 'blocker_resolved',
      blockerId: updated.id
    });
  }
  res.json({
    blocker: updated,
    documentIds: savedDocIds
  });
});

app.put('/api/blockers/:id', auth, (req, res) => {
  const existing = db.get('blockers', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  // Resolving must go through /resolve (owner + notes + optional files)
  if (req.body?.status === 'Resolved' && existing.status !== 'Resolved') {
    return res.status(400).json({
      error: 'Use Resolve with a description (and optional files). Only the assigned owner can resolve.'
    });
  }
  const updated = { ...existing, ...req.body, id: existing.id, ownerId: existing.ownerId };
  db.put('blockers', updated);
  broadcast('data:changed', { stores: ['blockers'], reason: 'blocker_updated' });
  if (req.user.accessLevel === 'admin') {
    notifyTeam(`Manager updated blocker → ${updated.status || 'updated'}`, {
      reason: 'blocker_updated',
      blockerId: updated.id
    });
  } else {
    notifyAdmins(`${req.user.name} updated a blocker → ${updated.status || 'updated'}`, {
      reason: 'blocker_updated',
      blockerId: updated.id
    });
  }
  res.json(updated);
});

// ——— Admin (before generic :store routes) ———
app.post('/api/admin/reset', auth, requireAdmin, (req, res) => {
  db.reset();
  broadcast('data:changed', { stores: READ_STORES, reason: 'reset' });
  res.json({ ok: true });
});

app.get('/api/admin/export', auth, requireAdmin, (req, res) => {
  const data = {};
  for (const s of READ_STORES) {
    data[s] = s === 'team' ? db.getAll(s).map(db.publicUser) : db.getAll(s);
  }
  data.schemaVersion = '2.0.0';
  data.exportDate = new Date().toISOString();
  res.json(data);
});

// ——— Generic store reads (last among /api routes) ———
app.get('/api/:store', auth, (req, res) => {
  const { store } = req.params;
  if (!READ_STORES.includes(store)) return res.status(404).json({ error: 'Unknown store' });
  let rows = db.getAll(store);
  if (store === 'team') rows = rows.map(db.publicUser);
  // Active projects only on main list (archived live in History)
  if (store === 'projects') {
    const includeArchived = String(req.query.includeArchived || '') === '1';
    if (!includeArchived) rows = rows.filter((p) => !p.archived);
  }
  // Hide draft AI plans from teammates until manager publishes
  if (store === 'tasks' && req.user.accessLevel !== 'admin') {
    rows = rows.filter((t) => t.status !== 'Draft' && t.responsibleId === req.user.id);
  }
  // Hide tasks belonging to archived projects from active views (unless projectId filter for restore/history)
  if (store === 'tasks') {
    const projectFilter = req.query.projectId;
    if (projectFilter) {
      rows = rows.filter((t) => t.projectId === projectFilter);
    } else {
      const archivedIds = new Set(db.getAll('projects').filter((p) => p.archived).map((p) => p.id));
      rows = rows.filter((t) => !archivedIds.has(t.projectId));
    }
  }
  // Strip heavy base64 from document list responses
  if (store === 'documents') {
    rows = rows.map(publicDoc).filter((d) => canSeeDocument(req.user, d));
  }
  res.json(rows);
});

app.get('/api/:store/:id', auth, (req, res) => {
  const { store, id } = req.params;
  if (!READ_STORES.includes(store)) return res.status(404).json({ error: 'Unknown store' });
  let row = db.get(store, id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (store === 'team') row = db.publicUser(row);
  if (store === 'tasks' && req.user.accessLevel !== 'admin') {
    if (row.status === 'Draft' || row.responsibleId !== req.user.id) {
      return res.status(403).json({ error: 'Not allowed' });
    }
  }
  if (store === 'documents') {
    if (!canSeeDocument(req.user, row)) return res.status(403).json({ error: 'Not allowed' });
    row = publicDoc(row);
  }
  res.json(row);
});

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

io.on('connection', (socket) => {
  socket.on('join', (payload) => {
    const userId = typeof payload === 'string' ? payload : payload?.userId;
    const accessLevel = typeof payload === 'object' ? payload?.accessLevel : null;
    if (userId) socket.join(`user:${userId}`);
    if (accessLevel === 'admin') socket.join('role:admin');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const mail = mailer.status();
  console.log(`\n  Xerago IoT Command Center`);
  console.log(`  → http://0.0.0.0:${PORT}`);
  console.log(`  Admin:  dinesh / admin123`);
  console.log(`  Team:   vishnu|arun|daniel / team123`);
  console.log(`  Vault:  data/cloud-vault`);
  console.log(`  Mail:   ${mail.mode}${mail.configured ? ` via ${mail.host}` : ' (set SMTP_HOST/USER/PASS to send real email)'}`);
  console.log(`  AI:     Ollama optional at ${process.env.OLLAMA_URL || 'http://127.0.0.1:11434'}\n`);
});
