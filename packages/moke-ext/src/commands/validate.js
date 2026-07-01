// moke-ext validate — validate manifest.json

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const KNOWN_PERMISSIONS = [
  'books.read', 'books.download',
  'user.profile', 'server.info',
  'reader.events.subscribe', 'reader.command.send', 'reader.state.read',
  'storage', 'sidebar.add', 'page.register',
];

function fail(msg) {
  console.error(`  FAIL  ${msg}`);
  return false;
}

function ok(msg) {
  console.log(`  OK    ${msg}`);
  return true;
}

export default function validate() {
  const manifestPath = join(process.cwd(), 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error('No manifest.json found in current directory.');
    console.error('Run "moke-ext init <name>" to create a new extension.');
    process.exit(1);
  }

  console.log('Validating manifest.json...\n');

  let raw;
  try { raw = readFileSync(manifestPath, 'utf-8'); } catch (e) { fail(`Cannot read: ${e.message}`); process.exit(1); }
  if (raw.length > 64 * 1024) { fail('File too large (>64 KB)'); process.exit(1); }

  let m;
  try { m = JSON.parse(raw); } catch (e) { fail(`Invalid JSON: ${e.message}`); process.exit(1); }

  let passed = 0, total = 0;

  // Required fields
  const required = [
    ['name', 'string', /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/],
    ['version', 'string', /^\d+\.\d+\.\d+$/],
    ['display_name', 'string', /^.{1,128}$/],
  ];
  for (const [field, type, pattern] of required) {
    total++;
    if (typeof m[field] !== type) { fail(`${field}: missing or wrong type (expected ${type})`); continue; }
    if (pattern && !pattern.test(m[field])) { fail(`${field}: "${m[field]}" does not match ${pattern}`); continue; }
    ok(`${field}: ${m[field]}`);
    passed++;
  }

  // Optional string fields
  for (const field of ['description', 'author']) {
    total++;
    if (m[field] !== undefined && typeof m[field] !== 'string') { fail(`${field}: must be string`); continue; }
    if (m[field] && m[field].length > (field === 'description' ? 512 : 128)) { fail(`${field}: too long`); continue; }
    ok(`${field}: ${m[field] || '(not set)'}`);
    passed++;
  }

  // Permissions
  total++;
  if (!Array.isArray(m.permissions)) { fail('permissions: must be an array'); }
  else {
    const unknown = m.permissions.filter(p => !KNOWN_PERMISSIONS.includes(p));
    if (unknown.length) { fail(`permissions: unknown — ${unknown.join(', ')}`); }
    else { ok(`permissions: ${m.permissions.length ? m.permissions.join(', ') : '(none)'}`); passed++; }
  }

  // Entry
  total++;
  if (m.entry !== undefined) {
    if (typeof m.entry !== 'object' || m.entry === null) { fail('entry: must be an object'); }
    else {
      const hasUi = typeof m.entry.ui_port === 'number';
      const hasBackend = m.entry.backend && typeof m.entry.backend === 'object';
      if (hasBackend) {
        const exe = m.entry.backend.executable;
        if (!exe || typeof exe !== 'string' || exe.includes('/') || exe.includes('\\') || exe.includes('..')) {
          fail('entry.backend.executable: must be a plain filename (no path separators)');
        } else if (!hasUi) {
          fail('entry: backend requires ui_port to be set (even if 0 for auto-assign)');
        } else {
          ok(`entry: backend="${exe}" ui_port=${m.entry.ui_port}`);
          passed++;
        }
      } else if (hasUi) {
        ok(`entry: ui_port=${m.entry.ui_port}`);
        passed++;
      } else {
        fail('entry: must have ui_port and/or backend');
      }
    }
  } else {
    ok('entry: (headless extension)');
    passed++;
  }

  // Sidebar
  total++;
  if (m.sidebar !== undefined) {
    if (!m.sidebar.label || typeof m.sidebar.label !== 'string') { fail('sidebar.label: required string'); }
    else if (m.sidebar.label.length > 64) { fail('sidebar.label: too long (>64 chars)'); }
    else { ok(`sidebar: "${m.sidebar.label}"`); passed++; }
  } else {
    ok('sidebar: (none)');
    passed++;
  }

  // Unknown fields
  const known = ['name','version','api_version','display_name','description','author','entry','sidebar','permissions','lucide_icons'];
  const unknownFields = Object.keys(m).filter(k => !known.includes(k));
  if (unknownFields.length) {
    fail(`Unknown fields: ${unknownFields.join(', ')} (will be rejected by Moke)`);
  }

  console.log(`\n${passed}/${total} checks passed`);

  if (passed < total) process.exit(1);
}
