import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, restReminderDue } from '../src/shared/settings.js';

const MIN = 60_000;
const base = { now: 10 * MIN, lastActivity: 9 * MIN, lastPrompt: 0, enabled: true };

test('DEFAULT_SETTINGS.restReminder 默认关闭', () => {
  assert.equal(DEFAULT_SETTINGS.restReminder, false);
});

test('未开启时永不提醒', () => {
  assert.equal(restReminderDue({ ...base, enabled: false }), false);
});

test('超过 5 分钟无活动视为暂停阅读', () => {
  assert.equal(restReminderDue({ ...base, lastActivity: base.now - 5 * MIN - 1 }), false);
});

test('距上次提醒不足 45 分钟不提醒', () => {
  assert.equal(restReminderDue({ ...base, lastPrompt: base.now - 45 * MIN + 1 }), false);
});

test('满 45 分钟且有活动提醒', () => {
  assert.equal(restReminderDue({ ...base, lastPrompt: base.now - 45 * MIN }), true);
  assert.equal(restReminderDue({ ...base, lastPrompt: base.now - 90 * MIN }), true);
});

test('自定义 everyMs 生效', () => {
  assert.equal(restReminderDue({ ...base, lastPrompt: base.now - 10 * MIN, everyMs: 10 * MIN }), true);
  assert.equal(restReminderDue({ ...base, lastPrompt: base.now - 10 * MIN + 1, everyMs: 10 * MIN }), false);
});
