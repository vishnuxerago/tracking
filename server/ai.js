/**
 * Project-specific AI planner.
 * 1) Analyze which designations are actually needed (not everyone every time)
 * 2) Propose unique tasks for THIS project only
 * 3) Tasks are NOT created until manager confirms (handled by API)
 *
 * Engines (open models): Ollama → Groq (optional free key) → smart analyzer fallback
 */
const db = require('./db');
const crypto = require('crypto');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

function findByRole(team, patterns) {
  const lower = patterns.map((p) => p.toLowerCase());
  return team.find((m) => lower.some((p) => (m.role || '').toLowerCase().includes(p))) || null;
}

function mapRoleToMember(team, designation) {
  const d = (designation || '').toLowerCase();
  if (d.includes('project manager') || d.includes('pm') || d === 'manager' || d.includes('coordination')) {
    return findByRole(team, ['project manager', 'manager']) || team.find((t) => t.accessLevel === 'admin');
  }
  if (d.includes('3d') || d.includes('mechanical') || d.includes('enclosure') || d.includes('cad') || d.includes('housing')) {
    return findByRole(team, ['3d', 'mechanical']);
  }
  if (d.includes('operator') || d.includes('assembly') || d.includes('solder') || d.includes('procurement') || d.includes('flash') || d.includes('wiring')) {
    return findByRole(team, ['operator', 'electronic']);
  }
  if (d.includes('pcb') || d.includes('schematic') || d.includes('firmware') || d.includes('electronics') || d.includes('circuit') || d.includes('layout') || d.includes('gerber') || d.includes('bom')) {
    return findByRole(team, ['pcb', 'firmware', 'electronics']);
  }
  return null;
}

function projectText(proj) {
  return `${proj.name || ''} ${proj.type || ''} ${proj.description || ''}`.toLowerCase();
}

/** Remove negated phrases so "no PCB" does not count as needing PCB */
function positiveText(text) {
  return text
    .replace(/\b(no|not|without|exclude|excluding|don't|dont|does not|do not)\s+[\w/-]+(?:\s+(?:or|and|,)\s+[\w/-]+)*/gi, ' ')
    .replace(/\bonly\s+(3d|mechanical|enclosure|cad|documentation|docs|firmware|pcb|assembly)\b/gi, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasAny(text, re) {
  return re.test(text);
}

/**
 * Decide which team roles this project actually needs.
 * Returns { needed: Member[], skipped: {member, reason}[], flags }
 */
function analyzeRequiredRoles(proj, team) {
  const raw = projectText(proj);
  const text = positiveText(raw);
  const type = (proj.type || '').toLowerCase();

  let needsPcb =
    hasAny(text, /\b(pcb|schematic|gerber|footprint|circuit|electronics|controller|iot|embedded|sensor|mcu|esp32|esp8266|stm32|antenna)\b/) ||
    ['pcb', 'embedded', 'electronics'].includes(type);
  // "board" alone is weak — only with electronics context
  if (/\bboard\b/.test(text) && hasAny(text, /\b(pcb|circuit|layout|gerber|mcu|sensor)\b/)) needsPcb = true;

  let needsMechanical =
    hasAny(text, /\b(enclosure|3d|casing|housing|mechanical|mount|bracket|mold|fitment|chassis|plastic|sla|fdm|cad|fixture)\b/) ||
    type === 'mechanical';

  let needsFirmware =
    hasAny(text, /\b(firmware|software|esp32|mcu|embedded|iot|driver|wifi|mqtt|ble|protocol|rtos|flashing)\b/) ||
    ['embedded', 'automation'].includes(type);

  let needsAssembly =
    hasAny(text, /\b(assembl|solder|procure|bom|wiring|bring-?up|power-?on|fab|manufactur|kitting)\b/) ||
    (type === 'prototype');

  // Explicit type overrides
  if (type === 'mechanical') {
    needsPcb = hasAny(text, /\b(pcb|schematic|circuit|mcu|electronics)\b/);
    needsFirmware = hasAny(text, /\b(firmware|software|esp32|mcu)\b/);
    needsMechanical = true;
    needsAssembly = hasAny(text, /\b(prototype|print|fabricat|assembl|sla|fdm)\b/);
  }

  if (type === 'pcb') {
    needsPcb = true;
    // layout/gerber/review only → skip mech/ops unless mentioned positively
    if (hasAny(text, /\b(review|consult|layout|gerber)\b/) && !hasAny(text, /\b(enclos|3d|housing|assembl|procure|firmware)\b/)) {
      needsMechanical = false;
      needsFirmware = hasAny(text, /\b(firmware|software|flash)\b/);
      needsAssembly = hasAny(text, /\b(assembl|procure|fab|manufactur)\b/);
    }
  }

  if (hasAny(raw, /\bonly documentation|spec only|requirements only|feasibility study\b/)) {
    needsPcb = false;
    needsMechanical = false;
    needsFirmware = false;
    needsAssembly = false;
  }

  // If description says "no assembly" etc. after positiveText stripping, also check raw negations
  if (/\b(no|without)\s+(assembl|procurement|solder)/i.test(raw)) needsAssembly = false;
  if (/\b(no|without)\s+(pcb|circuit|electronics)/i.test(raw)) needsPcb = false;
  if (/\b(no|without)\s+(firmware|software)/i.test(raw)) needsFirmware = false;
  if (/\b(no|without)\s+(enclosure|3d|mechanical|housing)/i.test(raw)) needsMechanical = false;

  const flags = {
    needsPcb,
    needsMechanical,
    needsFirmware,
    needsAssembly,
    needsPmCoordination: true
  };

  const pm = findByRole(team, ['project manager', 'manager']) || team.find((t) => t.accessLevel === 'admin');
  const pcb = findByRole(team, ['pcb']);
  const mech = findByRole(team, ['3d', 'mechanical']);
  const ops = findByRole(team, ['operator', 'electronic']);

  const needed = [];
  const skipped = [];
  const add = (member, why) => {
    if (!member) return;
    if (!needed.find((m) => m.id === member.id)) needed.push({ ...member, whyNeeded: why });
  };
  const skip = (member, why) => {
    if (!member) return;
    if (!needed.find((m) => m.id === member.id) && !skipped.find((s) => s.member.id === member.id)) {
      skipped.push({ member: { id: member.id, name: member.name, role: member.role }, reason: why });
    }
  };

  if (flags.needsPmCoordination && pm) add(pm, 'Coordinates scope, approvals, and vendor decisions');
  if (flags.needsPcb || flags.needsFirmware) {
    if (pcb) add(pcb, flags.needsFirmware && flags.needsPcb ? 'PCB/schematic + firmware for this product' : flags.needsFirmware ? 'Firmware / embedded work' : 'PCB / schematic / electronics design');
  } else if (pcb) skip(pcb, 'No PCB/electronics/firmware scope detected for this project');

  if (flags.needsMechanical) {
    if (mech) add(mech, '3D / mechanical / enclosure work required');
  } else if (mech) skip(mech, 'No enclosure or mechanical deliverable detected');

  if (flags.needsAssembly || (flags.needsPcb && /prototype|build|assembl|test/.test(text))) {
    if (ops) add(ops, 'Procurement, assembly, flashing, or hardware bring-up');
  } else if (ops) skip(ops, 'No assembly / procurement / lab bring-up detected');

  // Always keep at least one person
  if (!needed.length && pm) add(pm, 'Default owner for planning & delivery');

  const summary = buildAnalysisSummary(proj, needed, skipped, flags);
  return { needed, skipped, flags, summary };
}

function flagsFromTypeNeedOps(type) {
  return ['prototype', 'embedded', 'electronics', 'automation'].includes(type);
}

function buildAnalysisSummary(proj, needed, skipped, flags) {
  const roles = needed.map((m) => m.role).join(', ');
  const parts = [
    `Project "${proj.name}" (${proj.type}) analyzed.`,
    `Required designations: ${roles || 'none'}.`
  ];
  if (skipped.length) {
    parts.push(`Not required this time: ${skipped.map((s) => s.member.role).join(', ')}.`);
  }
  const focus = [];
  if (flags.needsPcb) focus.push('electronics/PCB');
  if (flags.needsFirmware) focus.push('firmware');
  if (flags.needsMechanical) focus.push('mechanical/3D');
  if (flags.needsAssembly) focus.push('build/test');
  if (focus.length) parts.push(`Focus areas: ${focus.join(', ')}.`);
  return parts.join(' ');
}

function proposeTask(order, name, description, category, member, priority, isExternal) {
  return {
    tempId: `prop_${order}_${crypto.randomBytes(2).toString('hex')}`,
    name,
    description,
    category,
    responsibleId: member ? member.id : null,
    designation: member ? member.role : 'Unassigned',
    priority: priority || 'Medium',
    isExternal: !!isExternal,
    supportIds: []
  };
}

/** Project-specific heuristic plan — different mix per project, only needed people */
function generateWithAnalyzer(proj, team) {
  const { needed, skipped, flags, summary } = analyzeRequiredRoles(proj, team);
  const byRole = (patterns) => needed.find((m) => patterns.some((p) => (m.role || '').toLowerCase().includes(p)));
  const pm = byRole(['project manager', 'manager']) || needed[0];
  const pcb = byRole(['pcb']);
  const mech = byRole(['3d', 'mechanical']);
  const ops = byRole(['operator', 'electronic']);

  const label = proj.name;
  const tasks = [];
  let n = 1;

  if (pm) {
    tasks.push(proposeTask(n++, `${label}: Scope & requirement freeze`, `Capture goals, constraints, and acceptance criteria unique to ${label}.`, 'Requirements', pm, 'High'));
  }

  if (pcb && flags.needsPcb) {
    tasks.push(proposeTask(n++, `${label}: Architecture & block diagram`, `Define power, MCU/interfaces, and signal path for ${label}.`, 'Architecture', pcb, 'Critical'));
    tasks.push(proposeTask(n++, `${label}: Component selection`, `Select parts and power architecture specific to ${label} requirements.`, 'Components', pcb, 'High'));
    tasks.push(proposeTask(n++, `${label}: Schematic capture`, `Create and review circuit schematic for ${label}.`, 'Schematic', pcb, 'Critical'));
    tasks.push(proposeTask(n++, `${label}: PCB layout & DRC`, `Layout, routing, and DRC for ${label} board.`, 'PCB', pcb, 'Critical'));
    tasks.push(proposeTask(n++, `${label}: Gerber & fab package`, `Export Gerbers/drill/BOM and release fab package for ${label}.`, 'Manufacturing', pcb, 'High', true));
  }

  if (pcb && flags.needsFirmware) {
    tasks.push(proposeTask(n++, `${label}: Firmware bring-up`, `Board support, drivers, and boot path for ${label}.`, 'Firmware', pcb, 'High'));
    tasks.push(proposeTask(n++, `${label}: Feature firmware`, `Implement product features / protocols described for ${label}.`, 'Firmware', pcb, 'High'));
  }

  if (mech && flags.needsMechanical) {
    tasks.push(proposeTask(n++, `${label}: 3D enclosure / mechanical design`, `CAD model and mounting strategy for ${label}.`, 'Mechanical', mech, 'High'));
    tasks.push(proposeTask(n++, `${label}: Fitment & clearance check`, `Verify mechanical fit against electronics for ${label}.`, 'Mechanical', mech, 'Medium'));
    if (/print|prototype|fabricat|mold|sla|fdm/.test(projectText(proj))) {
      tasks.push(proposeTask(n++, `${label}: Prototype fabrication`, `3D print / fab prototype parts for ${label}.`, 'Fabrication', mech, 'Medium', true));
    }
  }

  if (ops && (flags.needsAssembly || flags.needsPcb)) {
    if (/procure|bom|buy|component/.test(projectText(proj)) || flags.needsPcb) {
      tasks.push(proposeTask(n++, `${label}: Procurement / kitting`, `Source and kit components for ${label} build.`, 'Procurement', ops, 'High', true));
    }
    tasks.push(proposeTask(n++, `${label}: Assembly & soldering`, `Assemble hardware prototype for ${label}.`, 'Assembly', ops, 'High'));
    if (flags.needsFirmware || /flash|test|bring/.test(projectText(proj))) {
      tasks.push(proposeTask(n++, `${label}: Flash & power-on test`, `Program device and first-power validation for ${label}.`, 'Assembly', ops, 'Critical'));
    }
    tasks.push(proposeTask(n++, `${label}: Hardware validation`, `Test sensors/IO/performance against ${label} acceptance criteria.`, 'Testing', ops, 'High'));
  }

  if (pm) {
    tasks.push(proposeTask(n++, `${label}: Final review & sign-off`, `Manager review of deliverables and close-out for ${label}.`, 'Approval', pm, 'Critical'));
  }

  // Tiny unique hash of description so plans differ even for similar types
  const fingerprint = crypto.createHash('sha1').update(projectText(proj)).digest('hex').slice(0, 6);
  if (tasks[0]) {
    tasks[0].description += ` [plan-id ${fingerprint}]`;
  }

  return {
    analysis: { summary, neededRoles: needed.map((m) => ({ id: m.id, name: m.name, role: m.role, reason: m.whyNeeded })), skippedRoles: skipped, flags },
    tasks,
    engine: 'analyzer',
    model: null
  };
}

function normalizeAiPlan(parsed, proj, team) {
  const { needed, skipped, flags, summary } = analyzeRequiredRoles(proj, team);
  const neededIds = new Set(needed.map((m) => m.id));

  let rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  // Prefer AI's own neededRoles if provided
  let aiNeeded = Array.isArray(parsed.neededRoles) ? parsed.neededRoles : [];

  const tasks = [];
  let order = 1;
  for (const t of rawTasks) {
    const member = mapRoleToMember(team, t.designation || t.role || t.assigneeRole);
    if (!member) continue;
    // Drop tasks for people the combined analysis says are not needed — unless AI explicitly listed them in neededRoles
    const aiWantsRole = aiNeeded.some((r) => {
      const s = `${r.role || r.designation || r || ''}`.toLowerCase();
      return (member.role || '').toLowerCase().includes(s) || s.includes((member.role || '').toLowerCase().split(' ')[0]);
    });
    if (!neededIds.has(member.id) && !aiWantsRole && aiNeeded.length) continue;
    if (!neededIds.has(member.id) && !aiNeeded.length) {
      // trust local analyzer when AI omitted neededRoles
      continue;
    }
    const name = (t.name || `Task ${order}`).includes(proj.name) ? t.name : `${proj.name}: ${t.name || 'Work item'}`;
    tasks.push(
      proposeTask(
        order++,
        name,
        t.description || `Work item for ${proj.name}`,
        t.category || 'Requirements',
        member,
        t.priority || 'Medium',
        !!t.isExternal
      )
    );
  }

  if (tasks.length < 2) {
    // AI returned unusable plan — use analyzer
    return generateWithAnalyzer(proj, team);
  }

  // Recompute skipped based on who actually got tasks
  const usedIds = new Set(tasks.map((t) => t.responsibleId));
  const neededRoles = team
    .filter((m) => usedIds.has(m.id))
    .map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      reason: (needed.find((n) => n.id === m.id) || {}).whyNeeded || 'Selected by AI for this project'
    }));
  const skippedRoles = team
    .filter((m) => !usedIds.has(m.id))
    .map((m) => ({
      member: { id: m.id, name: m.name, role: m.role },
      reason: (skipped.find((s) => s.member.id === m.id) || {}).reason || 'Not assigned any tasks for this project'
    }));

  return {
    analysis: {
      summary: parsed.summary || `AI planned ${tasks.length} tasks for "${proj.name}". Involved: ${neededRoles.map((r) => r.role).join(', ') || 'n/a'}.`,
      neededRoles,
      skippedRoles,
      flags
    },
    tasks,
    engine: parsed._engine || 'ai',
    model: parsed._model || null
  };
}

function buildPrompt(proj, team) {
  const roster = team.map((m) => `- id:${m.id} | ${m.name} | role:${m.role} | skills:${(m.skills || []).join(', ')}`).join('\n');
  return `You are an expert hardware engineering project planner.
Analyze THIS project only. Do NOT invent a generic full-lifecycle template.
Do NOT assign every teammate if they are not needed.

Return ONLY valid JSON with this shape:
{
  "summary": "1-3 sentences: what this project needs and who is involved vs not",
  "neededRoles": [{"id":"tm_x","role":"...","reason":"why needed for THIS project"}],
  "skippedRoles": [{"id":"tm_y","role":"...","reason":"why NOT needed"}],
  "tasks":[{"name":"short task title including project context","description":"specific to this project","category":"Requirements|Architecture|Components|Schematic|PCB|Mechanical|Firmware|Procurement|Assembly|Testing|Approval|Manufacturing|Fabrication","designation":"exact role string from team","priority":"Low|Medium|High|Critical","isExternal":false}]
}

Rules:
- Only include people in neededRoles who must work on this project.
- Create 4-14 tasks unique to this project's name, type, and description — not copy-paste identical to other projects.
- If project is mechanical-only, do not invent PCB/firmware tasks.
- If project is PCB review-only, do not invent enclosure/assembly unless mentioned.
- Every task designation must match a team role below.
- Prefer fewer, sharper tasks over a bloated checklist.

Team:
${roster}

Project name: ${proj.name}
Project type: ${proj.type}
Project description: ${proj.description}`;
}

async function generateWithOllama(proj, team) {
  const prompt = buildPrompt(proj, team);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0.35 }
      }),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    const parsed = JSON.parse(data.response || '{}');
    parsed._engine = 'ollama';
    parsed._model = OLLAMA_MODEL;
    return normalizeAiPlan(parsed, proj, team);
  } finally {
    clearTimeout(timer);
  }
}

async function generateWithGroq(proj, team) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
  const prompt = buildPrompt(proj, team);
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You output only valid JSON project plans. Never assign unnecessary teammates.' },
        { role: 'user', content: prompt }
      ]
    }),
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(content);
  parsed._engine = 'groq';
  parsed._model = GROQ_MODEL;
  return normalizeAiPlan(parsed, proj, team);
}

/**
 * Propose a plan only — does not write tasks to DB.
 */
async function proposePlanForProject(proj) {
  const team = db.getAll('team').filter((t) => t.status === 'Active');
  const errors = [];

  try {
    const plan = await generateWithOllama(proj, team);
    console.log(`[AI] Plan via Ollama (${plan.tasks.length} tasks, ${plan.analysis.neededRoles.length} people)`);
    return plan;
  } catch (err) {
    errors.push(`ollama: ${err.message}`);
  }

  try {
    const plan = await generateWithGroq(proj, team);
    console.log(`[AI] Plan via Groq (${plan.tasks.length} tasks)`);
    return plan;
  } catch (err) {
    errors.push(`groq: ${err.message}`);
  }

  console.warn('[AI] Falling back to smart analyzer:', errors.join(' | '));
  return generateWithAnalyzer(proj, team);
}

async function checkOllama() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { available: false, groqConfigured: !!GROQ_API_KEY };
    const data = await res.json();
    return {
      available: true,
      models: (data.models || []).map((m) => m.name),
      preferred: OLLAMA_MODEL,
      groqConfigured: !!GROQ_API_KEY
    };
  } catch {
    return { available: false, models: [], preferred: OLLAMA_MODEL, groqConfigured: !!GROQ_API_KEY };
  }
}

function recommendVendors(requiredService) {
  const vendors = db.getAll('vendors').filter((v) => v.status === 'Active');
  return vendors
    .map((v) => {
      let score = 0;
      if (v.services && v.services.includes(requiredService)) score += 50;
      score += (v.rating || 3) * 8;
      if (v.reliability === 'High') score += 10;
      return { vendor: v, score };
    })
    .sort((a, b) => b.score - a.score);
}

/** Materialize confirmed plan items into task records */
function materializeTasks(projId, planTasks) {
  return (planTasks || []).map((t, i) => ({
    id: `task_${projId}_${i + 1}_${crypto.randomBytes(2).toString('hex')}`,
    projectId: projId,
    name: t.name,
    description: t.description || '',
    category: t.category || 'Requirements',
    responsibleId: t.responsibleId || null,
    supportIds: t.supportIds || [],
    isExternal: !!t.isExternal,
    externalVendorId: t.externalVendorId || null,
    priority: t.priority || 'Medium',
    status: 'Assigned',
    startDate: new Date().toISOString().slice(0, 10),
    targetDate: '',
    dependencies: [],
    notes: '',
    designation: t.designation || '',
    documentIds: [],
    submittedAt: null,
    submittedBy: null,
    verifiedAt: null,
    verifiedBy: null
  }));
}

module.exports = {
  proposePlanForProject,
  materializeTasks,
  checkOllama,
  recommendVendors,
  analyzeRequiredRoles,
  generateWithAnalyzer
};
