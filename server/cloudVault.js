/**
 * Open-source "cloud" document vault — files stored on the server disk.
 * Path: data/cloud-vault/{projectId}/{docId}__{safeFileName}
 * Admin can download any file; teammates can download their own task uploads.
 */
const fs = require('fs');
const path = require('path');

const VAULT_ROOT = path.join(__dirname, '..', 'data', 'cloud-vault');

function ensureVault() {
  if (!fs.existsSync(VAULT_ROOT)) fs.mkdirSync(VAULT_ROOT, { recursive: true });
}

function safeName(name) {
  return String(name || 'file')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
}

function projectDir(projectId) {
  const dir = path.join(VAULT_ROOT, safeName(projectId || 'general'));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function storeBase64({ docId, projectId, fileName, mimeType, dataBase64 }) {
  ensureVault();
  const clean = safeName(fileName);
  const dir = projectDir(projectId);
  const file = `${docId}__${clean}`;
  const abs = path.join(dir, file);
  const rel = path.join(safeName(projectId || 'general'), file);
  const buf = Buffer.from(dataBase64, 'base64');
  fs.writeFileSync(abs, buf);
  return {
    storagePath: rel.replace(/\\/g, '/'),
    absolutePath: abs,
    bytes: buf.length,
    mimeType: mimeType || 'application/octet-stream',
    fileName: clean
  };
}

function readFile(storagePath) {
  if (!storagePath) return null;
  const abs = path.join(VAULT_ROOT, storagePath);
  if (!abs.startsWith(VAULT_ROOT) || !fs.existsSync(abs)) return null;
  return {
    absolutePath: abs,
    buffer: fs.readFileSync(abs),
    exists: true
  };
}

function removeFile(storagePath) {
  if (!storagePath) return;
  const abs = path.join(VAULT_ROOT, storagePath);
  if (abs.startsWith(VAULT_ROOT) && fs.existsSync(abs)) {
    try {
      fs.unlinkSync(abs);
    } catch {
      /* ignore */
    }
  }
}

function removeProjectFiles(projectId) {
  const dir = path.join(VAULT_ROOT, safeName(projectId || ''));
  if (!fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

module.exports = {
  VAULT_ROOT,
  storeBase64,
  readFile,
  removeFile,
  removeProjectFiles,
  ensureVault
};
