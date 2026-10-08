import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isPrintedNumberDecoration,render} from './core.mjs';

test('suppresses a cut-out numbered marker aligned with its paragraph', () => {
  const para = {type:'para', number:'1', box:{x:.237, y:.165, w:.629, h:.027}};
  const marker = {box:{x:.151, y:.166, w:.023, h:.023}};
  assert.equal(isPrintedNumberDecoration(marker, para), true);
});

test('recognizes a wider cut-out for a two-digit paragraph number', () => {
  const para = {type:'para', number:'10', box:{x:.237, y:.608, w:.629, h:.029}};
  const marker = {box:{x:.150, y:.608, w:.036, h:.025}};
  assert.equal(isPrintedNumberDecoration(marker, para), true);
});

test('does not treat a narrow badge-edge crop as a complete printed number', () => {
  const para = {type:'para', number:'1', box:{x:.105, y:.38, w:.8, h:.028}};
  const partial = {box:{x:.073, y:.383, w:.0146, h:.0247}};
  assert.equal(isPrintedNumberDecoration(partial, para), false);
  const html = render({page:{width:1000,height:1400}, blocks:[{...para, cn:'汉语音节'}], decorations:[partial]}, {assets:{'deco-0':'/partial.png'}});
  assert.match(html, /class="hsk-num">1<\/span>/);
  assert.doesNotMatch(html, /partial\.png/);
});

test('renders the scanned number mark and does not add a duplicate red box', () => {
  const para = {type:'para', number:'10', box:{x:.237, y:.608, w:.629, h:.029}, cn:'这儿的苹果真便宜！'};
  const marker = {box:{x:.150, y:.608, w:.036, h:.025}};
  const html = render({page:{width:1000,height:1400}, blocks:[para], decorations:[marker], theme:{paper:'#fff'}}, {assets:{'deco-0':'/marker.png'}});
  assert.match(html, /src="\/marker\.png"/);
  assert.doesNotMatch(html, /class="hsk-num"/);
});

test('keeps decorations outside the number column and parenthesized labels', () => {
  const para = {type:'para', number:'1', box:{x:.237, y:.165, w:.629, h:.027}};
  assert.equal(isPrintedNumberDecoration({box:{x:.11, y:.166, w:.016, h:.023}}, para), false);
  assert.equal(isPrintedNumberDecoration({box:{x:.160, y:.166, w:.016, h:.023}}, {...para, number:'(1)'}), false);
});
