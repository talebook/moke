import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverySaveFeedback } from '../src/lib/discovery/save-feedback.ts';

const current = { cancelled: false, selectionCurrent: true, paused: false };
const saved = { ok: true, outcome: 'created', persisted: true, server: { id: 'saved-entry' } };
const rejected = (code) => ({ ok: false, outcome: 'admission-rejected', code });

test('confirmed blur cancellation explains the pause without blaming the address or requiring reload', () => {
  for (const code of ['cancelled', 'stopped', 'invalid_session']) {
    const feedback = discoverySaveFeedback(rejected(code), { ...current, selectionCurrent: false, paused: true });
    assert.match(feedback.message, /后台暂停.*保存已取消/);
    assert.doesNotMatch(feedback.message, /地址校验/);
    assert.equal(feedback.reloadRequired, false);
    assert.equal(feedback.focusEntryId, undefined);
  }
});

test('abort after an uncertain native dispatch keeps unknown and forbids blind retry', () => {
  const result = { ok: false, outcome: 'storage-failure', code: 'write-rejected', persistence: 'unknown', reloadRequired: true };
  const feedback = discoverySaveFeedback(result, { ...current, cancelled: true, selectionCurrent: false, paused: true });
  assert.match(feedback.message, /尚未确认.*重新加载.*勿重复添加/);
  assert.doesNotMatch(feedback.message, /未写入|保存已取消/);
  assert.equal(feedback.reloadRequired, true);
  assert.equal(feedback.focusEntryId, undefined);
});

test('confirmed commit survives later cancellation without navigating an obsolete selection', () => {
  for (const context of [
    { ...current, cancelled: true },
    { ...current, selectionCurrent: false, paused: true },
  ]) {
    const feedback = discoverySaveFeedback(saved, context);
    assert.match(feedback.message, /已保存到服务器列表/);
    assert.doesNotMatch(feedback.message, /取消|未写入|未确认/);
    assert.equal(feedback.reloadRequired, true);
    assert.equal(feedback.focusEntryId, undefined);
  }
  assert.equal(discoverySaveFeedback(saved, current).focusEntryId, saved.server.id);
});

test('known prewrite abort is safe cancellation but unrelated validation errors remain distinct', () => {
  const cancelled = discoverySaveFeedback(rejected('cancelled'), { ...current, cancelled: true });
  assert.match(cancelled.message, /保存已取消，未写入/);
  assert.equal(cancelled.reloadRequired, false);
  const invalid = discoverySaveFeedback(rejected('candidate_unavailable'), { ...current, selectionCurrent: false, paused: true });
  assert.match(invalid.message, /候选来源或地址校验未通过/);
  assert.doesNotMatch(invalid.message, /后台暂停/);
});

test('an unchanged storage failure still gives its recovery path after blur', () => {
  const result = { ok: false, outcome: 'storage-failure', code: 'unavailable', persistence: 'unchanged', reloadRequired: true };
  const feedback = discoverySaveFeedback(result, { ...current, cancelled: true, paused: true });
  assert.match(feedback.message, /列表暂不能写入.*重新加载/);
  assert.equal(feedback.reloadRequired, true);
  assert.equal(feedback.focusEntryId, undefined);
});
