import test from 'node:test';
import assert from 'node:assert/strict';
import { createReaderSourceBoundary } from '../src/lib/reader-source.ts';
import { createReaderProgressQueue } from '../src/lib/reader-progress-queue.ts';

const a = { serverUrl:'http://a.test', bookId:'42', sessionId:1 };
const b = { serverUrl:'http://b.test', bookId:'42', sessionId:2 };
function fixture() {
  const state = { labels:[], context:{sessionId:1,candidate:null}, opens:0, time:0, onOpen:async()=>{} };
  const boundary = createReaderSourceBoundary({
    getWindowLabels:async()=>[...state.labels], getContext:async()=>state.context,
    open:async()=>{state.opens++; await state.onOpen();},
    now:()=>state.time, wait:async()=>{state.time+=1000;},
  });
  return {state,boundary};
}

test('A timeout retains ownership, rejects switching/B retries, then closes/flushes before same-id B', async () => {
  const {state,boundary}=fixture();
  const writes=[];
  const queue=createReaderProgressQueue(async(source,progress)=>writes.push([source.serverUrl,progress.location]),10000);
  boundary.registerReaderProgressFlush(()=>queue.flush());
  await assert.rejects(boundary.openReaderFromSource(a,{}),/尚未确认/);
  let switched=false;
  await assert.rejects(boundary.withClosedReaderSession(async()=>{switched=true;state.context.sessionId=2;}),/尚未确认/);
  assert.equal(switched,false);
  await assert.rejects(boundary.requireClosedReaders(),/尚未确认/);
  await assert.rejects(boundary.openReaderFromSource(b,{}),/尚未确认/);
  assert.equal(state.opens,1);
  // The late native event is still A, even if a caller incorrectly mutates its current store.
  state.context.sessionId=2;
  const source=boundary.sourceForReaderEvent('reader-0','42');
  assert.deepEqual(source,a);
  assert.equal(boundary.sourceForReaderEvent('reader-0','99'),null);
  queue.schedule(source,{moke_book_id:'42',location:'A-position'});
  state.labels=['reader-0'];
  await assert.rejects(boundary.requireClosedReaders(),/请先关闭/);
  state.labels=[];
  await boundary.requireClosedReaders();
  assert.deepEqual(writes,[['http://a.test','A-position']]);
  // Closed labels remain tombstones while a subsequent B request is unresolved.
  state.onOpen=async()=>{
    assert.equal(boundary.sourceForReaderEvent('reader-0','42'),null);
    state.labels=['reader-1'];
  };
  await boundary.openReaderFromSource(b,{});
  assert.deepEqual(boundary.sourceForReaderEvent('reader-1','42'),b);
  assert.equal(boundary.sourceForReaderEvent('reader-0','42'),null);
});

test('early events use the immutable request source and retain the boundary until enumeration', async () => {
  const {state,boundary}=fixture();
  const input={...a};
  let early;
  state.onOpen=async()=>{
    early=boundary.sourceForReaderEvent('reader-0','42');
    input.serverUrl='http://changed.test';
    assert.deepEqual(early,a);
    await assert.rejects(boundary.requireClosedReaders(),/正在打开/);
    await assert.rejects(boundary.openReaderFromSource(a,{}),/状态正在变更/);
    state.labels=['reader-0'];
  };
  await boundary.openReaderFromSource(input,{});
  assert.equal(Object.isFrozen(early),true);
  await assert.rejects(boundary.openReaderFromSource(a,{}),/请先关闭/);
});

test('pre-dispatch stale/cancelled preparation releases reservation without a phantom pending request', async () => {
  const {state,boundary}=fixture();
  state.context.candidate={url:b.serverUrl};
  await assert.rejects(boundary.openReaderFromSource(a,{}),/状态已改变/);
  assert.equal(state.opens,0);
  state.context.candidate=null;
  await boundary.requireClosedReaders();
  state.onOpen=async()=>{state.labels=['reader-0'];};
  await boundary.openReaderFromSource(a,{});
});

test('an IPC rejection after dispatch cannot free ownership of a possibly queued window', async () => {
  const {state,boundary}=fixture();
  state.onOpen=async()=>{throw new Error('lost receipt');};
  await assert.rejects(boundary.openReaderFromSource(a,{}),/lost receipt/);
  await assert.rejects(boundary.withClosedReaderSession(async()=>{}),/尚未确认/);
  state.labels=['reader-0'];
  await assert.rejects(boundary.requireClosedReaders(),/请先关闭/);
  assert.deepEqual(boundary.sourceForReaderEvent('reader-0','42'),a);
  state.labels=[];
  await boundary.requireClosedReaders();
});

test('late reader closed before enumeration retires its label and allows safe recovery', async () => {
  const {boundary}=fixture();
  await assert.rejects(boundary.openReaderFromSource(a,{}),/尚未确认/);
  assert.deepEqual(boundary.sourceForReaderEvent('reader-0','42'),a);
  boundary.retireReaderWindow('reader-0');
  await boundary.requireClosedReaders();
  assert.equal(boundary.sourceForReaderEvent('reader-0','42'),null);
});

test('an unknown close receipt without a Moke book id cannot release a newer pending open', async () => {
  const {boundary}=fixture();
  await assert.rejects(boundary.openReaderFromSource(a,{}),/尚未确认/);
  boundary.retireReaderWindow('reader-99');
  await assert.rejects(boundary.requireClosedReaders(),/尚未确认/);
  await assert.rejects(boundary.openReaderFromSource(b,{}),/尚未确认/);
});

test('ambiguous window snapshots preserve the boundary instead of assigning the first label', async () => {
  const {state,boundary}=fixture();
  await assert.rejects(boundary.openReaderFromSource(a,{}),/尚未确认/);
  state.labels=['reader-0','reader-1'];
  await assert.rejects(boundary.requireClosedReaders(),/尚未确认/);
  assert.equal(boundary.sourceForReaderEvent('reader-0','99'),null);
});

test('flush failure prevents the reserved session/offline change and allows retry', async () => {
  const {boundary}=fixture();
  let changed=false;
  const remove=boundary.registerReaderProgressFlush(async()=>{throw new Error('flush failed');});
  await assert.rejects(boundary.withClosedReaderSession(async()=>{changed=true;}),/flush failed/);
  assert.equal(changed,false);
  remove();
  await boundary.withClosedReaderSession(async()=>{changed=true;});
  assert.equal(changed,true);
});
