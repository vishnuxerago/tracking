/**
 * Simple open-source JSON file database (no native deps).
 * Atomic writes via temp file + rename.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'xerago-db.json');

const DEFAULT = () => ({
  team: [],
  vendors: [],
  projects: [],
  tasks: [],
  blockers: [],
  documents: [],
  activity_log: [],
  categories: [],
  templates: []
});

let state = DEFAULT();

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(DB_PATH)) {
    state = DEFAULT();
    seed();
    save();
    return;
  }
  try {
    state = { ...DEFAULT(), ...JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) };
  } catch {
    state = DEFAULT();
    seed();
    save();
  }
  if (!state.team || state.team.length === 0) {
    seed();
    save();
  }
}

function save() {
  ensureDir();
  const payload = JSON.stringify(state, null, 2);
  const tmp = DB_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, payload, 'utf8');
    try {
      if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    } catch {
      /* Windows may lock briefly — fall through to direct write */
    }
    try {
      fs.renameSync(tmp, DB_PATH);
    } catch {
      fs.copyFileSync(tmp, DB_PATH);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  } catch {
    fs.writeFileSync(DB_PATH, payload, 'utf8');
  }
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function seed() {
  const hash = (pw) => bcrypt.hashSync(pw, 10);

  state.team = [
    {
      id: 'tm_1',
      name: 'Dinesh R.',
      username: 'dinesh',
      passwordHash: hash('admin123'),
      role: 'Project Manager',
      accessLevel: 'admin',
      skills: ['Project Management', 'System Architecture', 'Technical Coordination', 'External Vendor Management', 'Final Approval'],
      responsibilities: 'Project coordination, task assignment, progress monitoring, dependency management, vendor coordination, review & approval.',
      email: 'r.dinesh@xerago.com',
      status: 'Active',
      mustChangePassword: true
    },
    {
      id: 'tm_2',
      name: 'Arun Kumar S.',
      username: 'arun',
      passwordHash: hash('team123'),
      role: '3D Designer',
      accessLevel: 'member',
      skills: ['3D Modeling', 'Mechanical Design', 'Enclosure Integration', 'Fitment Analysis'],
      responsibilities: '3D modeling, mechanical design, enclosure design, product dimensions, mounting, connector openings, prototype prep.',
      email: 'arunkumar.s@xerago.com',
      status: 'Active',
      mustChangePassword: true
    },
    {
      id: 'tm_3',
      name: 'S. Vishnu Durga Reddy',
      username: 'vishnu',
      passwordHash: hash('team123'),
      role: 'PCB Designer',
      accessLevel: 'member',
      skills: ['Schematic Design', 'PCB Layout', 'Routing', 'DRC', 'Gerber Generation', 'BOM'],
      responsibilities: 'Requirement analysis, system block diagram, component selection, circuit design, schematic, PCB layout, Gerber generation.',
      email: 'singamalavishnu@xerago.com',
      status: 'Active',
      mustChangePassword: true
    },
    {
      id: 'tm_4',
      name: 'Daniel Amirtharaj B.',
      username: 'daniel',
      passwordHash: hash('team123'),
      role: 'Electronic Operator',
      accessLevel: 'member',
      skills: ['Hardware Assembly', 'Soldering', 'Firmware Flashing', 'Sensor Testing', 'Procurement Support'],
      responsibilities: 'Component procurement support, hardware assembly, wiring, prototype assembly, soldering, firmware flashing, device testing.',
      email: 'danielamirtharaj@xerago.com',
      status: 'Active',
      mustChangePassword: true
    }
  ];

  state.vendors = [
    { id: 'v_1', name: 'PCB Express', company: 'PCB Express India', role: 'PCB Manufacturing Partner', category: 'PCB Manufacturer', services: ['PCB Manufacturing', 'PCB Fast Prototype'], mobile: '+91 9840011223', whatsapp: '+91 9840011223', email: 'orders@pcbexpress.in', rating: 5, reliability: 'High', leadTime: '3-5 Days', status: 'Active', notes: 'Excellent turnaround for 2-layer and 4-layer FR4 boards.' },
    { id: 'v_2', name: 'Inceptarc', company: 'Inceptarc Technologies', role: 'PCB & Electronics Assembler', category: 'PCB Assembly', services: ['PCB Assembly', 'Component Procurement'], mobile: '+91 9841122334', whatsapp: '+91 9841122334', email: 'contact@inceptarc.com', rating: 4, reliability: 'High', leadTime: '5-7 Days', status: 'Active', notes: 'Reliable SMT assembly and stencil fabrication.' },
    { id: 'v_3', name: 'Rajendar', company: 'Precision Fab', role: 'Mechanical Fabricator', category: 'Fabrication', services: ['Fabrication', '3D / Mechanical Services'], mobile: '+91 9842233445', whatsapp: '+91 9842233445', email: 'rajendar@precisionfab.in', rating: 4, reliability: 'Medium', leadTime: '4 Days', status: 'Active', notes: 'Metal bracket & custom aluminum heatsink fabrication.' },
    { id: 'v_4', name: 'Senthil', company: 'Apex Test Labs', role: 'Testing Specialist', category: 'Testing Service', services: ['Testing Service'], mobile: '+91 9843344556', whatsapp: '+91 9843344556', email: 'senthil@apextest.com', rating: 5, reliability: 'High', leadTime: '2 Days', status: 'Active', notes: 'EMI/EMC compliance pre-testing and thermal camera validation.' },
    { id: 'v_5', name: 'Caddline', company: 'Caddline Enclosures', role: '3D Mold & Enclosure Manufacturer', category: '3D / Mechanical Designer', services: ['3D / Mechanical Services', 'Fabrication'], mobile: '+91 9844455667', whatsapp: '+91 9844455667', email: 'info@caddline.com', rating: 4, reliability: 'High', leadTime: '7 Days', status: 'Active', notes: 'Plastic injection molding and rapid SLA 3D printing.' },
    { id: 'v_6', name: 'Shankar', company: 'Freelance PCB Solutions', role: 'External PCB Consultant', category: 'PCB Designer', services: ['PCB Design'], mobile: '+91 9845566778', whatsapp: '+91 9845566778', email: 'shankar.pcb@gmail.com', rating: 5, reliability: 'High', leadTime: 'Flexible', status: 'Active', notes: 'Expert in high-speed differential pair routing & RF antenna layout review.' },
    { id: 'v_7', name: 'Jagadeesh', company: 'IoT Technical Systems', role: 'Electronics Guide & Advisor', category: 'Electronics Consultant', services: ['Electronics Consultation'], mobile: '+91 9846677889', whatsapp: '+91 9846677889', email: 'jagadeesh.guide@gmail.com', rating: 5, reliability: 'High', leadTime: 'On-demand', status: 'Active', notes: 'Power architecture and embedded firmware troubleshooting advisor.' }
  ];

  state.projects = [];
  state.tasks = [];
  state.blockers = [];
  state.documents = [];
  state.activity_log = [{
    id: uid('log'),
    projectId: null,
    taskId: null,
    action: 'System initialized with open-source shared database',
    changedBy: 'System',
    timestamp: new Date().toISOString()
  }];
}

function getAll(store) {
  return [...(state[store] || [])];
}

function get(store, id) {
  return (state[store] || []).find((x) => x.id === id) || null;
}

function put(store, item) {
  if (!state[store]) state[store] = [];
  const idx = state[store].findIndex((x) => x.id === item.id);
  if (idx >= 0) state[store][idx] = item;
  else state[store].push(item);
  save();
  return item;
}

function remove(store, id) {
  if (!state[store]) return false;
  const before = state[store].length;
  state[store] = state[store].filter((x) => x.id !== id);
  save();
  return state[store].length < before;
}

function replaceAll(store, items) {
  state[store] = items || [];
  save();
}

function logActivity(projectId, taskId, action, changedBy) {
  const log = {
    id: uid('log'),
    projectId,
    taskId,
    action,
    changedBy: changedBy || 'System',
    timestamp: new Date().toISOString()
  };
  put('activity_log', log);
  return log;
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

function reset() {
  state = DEFAULT();
  seed();
  save();
}

load();

module.exports = {
  getAll,
  get,
  put,
  remove,
  replaceAll,
  logActivity,
  publicUser,
  reset,
  uid,
  save,
  getState: () => state
};
