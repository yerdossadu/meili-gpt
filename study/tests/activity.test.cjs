const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createActivity}=require('../activity.js');
function setup(date='2026-10-05T12:00:00Z') {
  let value, current=new Date(date);
  const storage={getItem:()=>value,setItem:(_,v)=>value=v};
  return {activity:createActivity(storage,()=>current), setDate:d=>current=new Date(d), corrupt:v=>value=v};
}
test('New history has no invented minutes or learned words',()=>{
  const {activity}=setup();
  assert.deepEqual(activity.history(),{});
  assert.ok(activity.series().every(d=>d.time===0&&d.words===0));
});
test('Week records visible seconds and unique marks on actual dates',()=>{
  const {activity,setDate}=setup(); activity.record(120,'你好');activity.record(60,'你好');
  setDate('2026-10-06T12:00:00Z');activity.record(240,'谢谢');
  const week=activity.series();
  assert.deepEqual(week.slice(0,2).map(d=>[d.date,d.time,d.words]),[['2026-10-05',3,1],['2026-10-06',4,1]]);
});
test('Qyzylorda midnight and Sunday stay in correct calendar week',()=>{
  const {activity,setDate}=setup('2026-10-04T18:59:59Z');
  assert.equal(activity.dateKey(),'2026-10-04');
  assert.equal(activity.series()[0].date,'2026-09-28');
  setDate('2026-10-04T19:00:00Z');
  assert.equal(activity.dateKey(),'2026-10-05');assert.equal(activity.series()[0].date,'2026-10-05');
});
test('Month includes final days and deduplicates repeated words within period',()=>{
  const {activity,setDate}=setup(); activity.record(60,'你好');
  setDate('2026-10-06T12:00:00Z');activity.record(120,'你好');
  setDate('2026-10-31T12:00:00Z');activity.record(300,'谢谢');
  const month=activity.series('month');assert.equal(month[0].time,3);assert.equal(month[0].words,1);
  assert.deepEqual(month[4],{label:'29–31',time:5,words:1});
});
test('Corrupt or unavailable storage does not break a lesson',()=>{
  const {activity,corrupt}=setup();corrupt('broken');assert.deepEqual(activity.history(),{});
  corrupt('[]');assert.deepEqual(activity.history(),{});
  const blocked=createActivity({getItem:()=>{throw Error('blocked')},setItem:()=>{throw Error('full')}});
  assert.doesNotThrow(()=>blocked.record(1,'你'));assert.equal(blocked.series().length,7);
});
