import test from 'node:test';
import assert from 'node:assert/strict';
import {startRebuild, pageJobs, rebuiltPageUrl} from './rebuild-client.mjs';
test('rebuild sends css engine without requiring a paid model', async () => {
  const calls=[];
  const request=async (url, options) => {calls.push({url,options});return {ok:true,json:async()=>options?{id:'new',state:'queued'}:[]};};
  assert.equal((await startRebuild('book',7,request)).id,'new');
  assert.deepEqual(JSON.parse(calls[1].options.body),{from:7,to:7,engine:'css'});
});
test('repeated click reuses running conversion covering selected page', async () => {
  const job={id:'active',engine:'css',from:6,to:8,state:'running',createdAt:'2026-10-07'};
  let calls=0;
  assert.equal((await startRebuild('book',7,async()=>{calls++;return {ok:true,json:async()=>[job]};})).id,'active');
  assert.equal(calls,1);
});
test('only CSS jobs for this page are selected, newest first', () => {
  const base={engine:'css',from:7,to:7};
  const jobs=pageJobs([{...base,id:'old',createdAt:'a'},{...base,id:'new',createdAt:'b'},{...base,id:'png',engine:'local',createdAt:'c'},{...base,id:'other',from:8,to:8,createdAt:'d'}],7);
  assert.deepEqual(jobs.map(j=>j.id),['new','old']);
  assert.equal(rebuiltPageUrl('book',jobs[0],7),'/library/book/auto-web/new/web/7.html');
});
test('backend errors are surfaced instead of switching to legacy conversion', async()=>{
  await assert.rejects(startRebuild('book',7,async()=>({ok:false,json:async()=>({error:'OCR unavailable'})})),/OCR unavailable/);
});
