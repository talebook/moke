import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { computePackageDigest, signPackage } from '../packages/moke-ext/src/commands/sign.js';
import { normalizeNativePath, validatePackagePath } from '../packages/moke-ext/src/package-path.js';
import { packageExtension } from '../packages/moke-ext/src/commands/package.js';
import { validateManifest } from '../packages/moke-ext/src/commands/validate.js';
const vector = JSON.parse(readFileSync(new URL('./fixtures/extension-digest-v1.json', import.meta.url)));

test('Node and Rust share normalized byte-order digest vectors (including Windows paths)', () => {
  const root=mkdtempSync(join(tmpdir(),'moke-vector-'));
  try {
    for (const [path,content] of Object.entries(vector.files)) {
      const full=join(root,path); mkdirSync(join(full,'..'),{recursive:true}); writeFileSync(full,content);
    }
    assert.equal(computePackageDigest(root),vector.sha256);
    assert.deepEqual(vector.windows_paths.map(p=>normalizeNativePath(p,'\\')).sort((a,b)=>Buffer.from(a).compare(Buffer.from(b))),vector.ordered_paths);
    for (const path of ['../a','C:/x','a\\b','a/CON.txt','e\u0301.txt','ui/./x']) assert.throws(()=>validatePackagePath(path));
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('authors can build a signed ZIP; stale signatures and host state are rejected', async () => {
  const root=mkdtempSync(join(tmpdir(),'moke-zip-')); const dist=join(root,'dist'); mkdirSync(dist);
  try {
    const manifest={name:'sample',version:'1.0.0',display_name:'Sample',publisher:{id:'example',name:'Example',source:'https://example.com'},permissions:['storage'],entry:{backend:{executable:'backend',targets:['linux-x86_64']}}};
    writeFileSync(join(dist,'manifest.json'),JSON.stringify(manifest)); writeFileSync(join(dist,'backend'),'test fixture binary');
    const {privateKey}=generateKeyPairSync('ed25519'); const key=join(root,'test-only.pem');
    writeFileSync(key,privateKey.export({type:'pkcs8',format:'pem'}));
    signPackage({directory:dist,keyPath:key,keyId:'test'});
    const output=await packageExtension(dist,join(root,'sample.zip'));
    assert.ok(existsSync(output)); assert.equal(readFileSync(output).readUInt32LE(),0x04034b50);
    writeFileSync(join(dist,'backend'),'changed');
    await assert.rejects(packageExtension(dist,join(root,'stale.zip')),/changed after signing/);
    writeFileSync(join(dist,'storage.json'),'{}');
    await assert.rejects(packageExtension(dist,join(root,'state.zip')),/host state/);
    assert.throws(()=>validateManifest({...manifest,publisher:{...manifest.publisher,source:'http://localhost.attacker.test'}}));
  } finally { rmSync(root,{recursive:true,force:true}); }
});
