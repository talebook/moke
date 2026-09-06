// Shared by validate/build/sign/package: never sign an invalid manifest.
import { readFileSync } from 'node:fs';
const PERMISSIONS = ['books.read','books.download','user.profile','server.info','reader.events.subscribe','reader.command.send','reader.state.read','storage','sidebar.add','page.register'];
const TARGETS = ['windows-x86_64','windows-aarch64','linux-x86_64','linux-aarch64','macos-x86_64','macos-aarch64'];
function object(value, keys, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !keys.includes(k))) throw new Error(`${label}: invalid object or unknown fields`);
}
function string(value, max, label, required = false) {
  if (value === undefined && !required) return;
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || (required && !value.trim())) throw new Error(`${label}: invalid string`);
}
export function validateManifest(m) {
  object(m, ['name','version','api_version','display_name','description','author','publisher','entry','sidebar','permissions','lucide_icons'], 'manifest');
  string(m.name,64,'name',true);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(m.name)) throw new Error('Invalid extension name');
  string(m.version,64,'version',true);
  if (!/^\d+\.\d+\.\d+$/.test(m.version) || m.version.split('.').some(n => n.length > 10)) throw new Error('Invalid version');
  string(m.display_name,128,'display_name',true);
  string(m.description,512,'description'); string(m.author,128,'author');
  if (m.api_version !== undefined && !['','1'].includes(m.api_version)) throw new Error('Unsupported api_version');
  if (m.publisher !== undefined) {
    object(m.publisher,['id','name','source'],'publisher');
    string(m.publisher.id,128,'publisher.id',true);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(m.publisher.id)) throw new Error('Invalid publisher.id');
    string(m.publisher.name,128,'publisher.name',true); string(m.publisher.source,512,'publisher.source',true);
    const url = new URL(m.publisher.source);
    if (/[\r\n\x00-\x20]/.test(m.publisher.source) || url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) throw new Error('publisher.source must be HTTPS (literal localhost allowed for development)');
  }
  if (m.permissions !== undefined && (!Array.isArray(m.permissions) || m.permissions.some(p => !PERMISSIONS.includes(p)))) throw new Error('Unknown permissions');
  if (m.entry !== undefined) {
    object(m.entry,['ui_port','backend'],'entry');
    if (m.entry.ui_port !== undefined && (!Number.isInteger(m.entry.ui_port) || m.entry.ui_port < 0 || m.entry.ui_port > 65535)) throw new Error('Invalid ui_port');
    const b = m.entry.backend;
    if (b !== undefined) {
      object(b,['executable','args','targets'],'backend'); string(b.executable,128,'executable',true);
      if (!/^[a-zA-Z0-9_.-]+$/.test(b.executable) || b.executable.includes('..') || ['signature.json','storage.json','uninstall.exe','installer.nsi'].includes(b.executable.toLowerCase()) || b.executable.toLowerCase().endsWith('-setup.exe')) throw new Error('Invalid executable');
      if (b.args !== undefined && (!Array.isArray(b.args) || b.args.some(a => typeof a !== 'string' || /[\r\n]/.test(a)))) throw new Error('Invalid backend args');
      if (b.targets !== undefined && (!Array.isArray(b.targets) || b.targets.some(t => !TARGETS.includes(t)))) throw new Error('Unsupported backend.targets');
    }
  }
  if (m.sidebar !== undefined) {
    object(m.sidebar,['label','icon','order'],'sidebar'); string(m.sidebar.label,64,'sidebar.label',true); string(m.sidebar.icon,64,'sidebar.icon',true);
    if (m.sidebar.order !== undefined && (!Number.isInteger(m.sidebar.order) || m.sidebar.order < -2147483648 || m.sidebar.order > 2147483647)) throw new Error('Invalid sidebar.order');
  }
  if (m.lucide_icons !== undefined && (!Array.isArray(m.lucide_icons) || m.lucide_icons.length > 50 || m.lucide_icons.some(i => typeof i !== 'string' || Buffer.byteLength(i) > 64))) throw new Error('Invalid lucide_icons');
  return m;
}
export default function validate() {
  const raw = readFileSync('manifest.json','utf8');
  if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('Manifest exceeds 64 KiB');
  validateManifest(JSON.parse(raw));
  console.log('manifest.json valid');
}
