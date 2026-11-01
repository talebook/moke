import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Render the pure result view using the project's actual JSX runtime. No DOM,
// Tauri bridge or server-connection store is needed to display candidates.
const source = readFileSync(new URL('../src/components/discovery/DiscoveryResults.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const compiledModule = { exports: {} };
new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), compiledModule, compiledModule.exports);
const { DiscoveryResults } = compiledModule.exports;

test('candidate names remain text and every URL and conflicting source name is visible', () => {
  const candidates = [
    { name: '<img src=x>', baseUrl: 'https://books.home.arpa:8443/team/books', joinable: false, unavailableReason: 'hostname_unresolved', sources: [{ fullname: 'a', interface: 'lan-a', addresses: ['192.168.50.10'], name: '<script>alert(1)</script>' }] },
    { name: '另一入口', baseUrl: 'http://192.168.50.10:8080', joinable: true, unavailableReason: null, sources: [] },
  ];
  const html = renderToStaticMarkup(createElement(DiscoveryResults, { rows: [{
    id: '9f0c663b-8ffd-4e13-92d9-2b68572c08b1', name: '<img src=x>', conflict: true, candidates,
  }] }));
  assert.ok(html.includes('&lt;img src=x&gt;'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.doesNotMatch(html, /<img|<script/);
  for (const candidate of candidates) assert.ok(html.includes(candidate.baseUrl));
  assert.ok(html.includes('同一标识出现不同名称'));
  assert.ok(html.includes('此域名尚未通过本机地址解析校验'));
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  assert.doesNotMatch(html, /href=|onclick=/i);
});

test('same names with different UUIDs remain separate rows', () => {
  const rows = [
    { id: '9f0c663b-8ffd-4e13-92d9-2b68572c08b1', name: '书库', conflict: false, candidates: [] },
    { id: '9f0c663b-8ffd-4e13-92d9-2b68572c08b2', name: '书库', conflict: false, candidates: [] },
  ];
  const html = renderToStaticMarkup(createElement(DiscoveryResults, { rows }));
  assert.ok(html.includes(rows[0].id));
  assert.ok(html.includes(rows[1].id));
  assert.equal((html.match(/<h2/g) ?? []).length, 2);
});

test('no candidates renders no stale list', () => {
  assert.equal(renderToStaticMarkup(createElement(DiscoveryResults, { rows: [] })), '');
});
