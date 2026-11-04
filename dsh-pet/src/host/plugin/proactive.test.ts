/**
 * 主动搭话门禁（src/host/plugin/proactive.ts）的契约测试。
 *
 * 钉住四类边界：默认关闭、安静时段跨午夜、空闲阈值、每小时上限与冷却。
 * 这些门决定「桌宠会不会突然开口」，改坏任何一条都会变成骚扰或永不开口，
 * 因此全部用注入的时间戳测，不依赖真实时钟。
 * 跑法：node --experimental-strip-types --test src/host/plugin/proactive.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { proactiveDue, proactiveGate, inQuietHours, type ProactiveCheck, type ProactiveGate } from './proactive.ts';

/** 一个开启的默认门禁：空闲 45 分钟、每小时 2 句、安静时段 23–08。 */
function gate(over: Partial<ProactiveGate> = {}): ProactiveGate {
  return { enabled: true, idleMs: 45 * 60_000, perHour: 2, quietStart: 23, quietEnd: 8, ...over };
}

/** 一份「本该开口」的检查输入：本地时间 15:00、空闲已经 2 小时。 */
function check(over: Partial<ProactiveCheck> = {}): ProactiveCheck {
  // 2026-11-04 15:00 本地时间（getHours() 才是 inQuietHours 读的东西，构造时按本地时区）
  const now = new Date(2026, 10, 4, 15, 0, 0).getTime();
  const base: ProactiveCheck = {
    now,
    lastUserAt: now - 2 * 3_600_000,
    lastProactiveAt: now - 2 * 3_600_000,
    recentProactive: [],
    gate: gate(),
    sleeping: false,
    locked: false,
    displayed: true,
    busy: false,
  };
  return { ...base, ...over };
}

describe('proactiveGate —— 配置解析', () => {
  test('没写 proactiveEnabled 就是关（打扰型功能必须显式打开）', () => {
    assert.equal(proactiveGate({}).enabled, false);
    assert.equal(proactiveGate({ proactiveEnabled: true }).enabled, true);
  });

  test('非法数值回落缺省，不抛', () => {
    const g = proactiveGate({ proactiveEnabled: true, proactiveIdleMin: -5, proactivePerHour: 'x' });
    assert.equal(g.idleMs, 45 * 60_000);
    assert.equal(g.perHour, 2);
  });

  test('安静时段支持 23:00-08:00 与中文分隔符；写坏了回落缺省', () => {
    assert.deepEqual(
      [
        proactiveGate({ proactiveQuietHours: '23:00-08:00' }).quietStart,
        proactiveGate({ proactiveQuietHours: '23:00-08:00' }).quietEnd,
      ],
      [23, 8],
    );
    assert.deepEqual(
      [
        proactiveGate({ proactiveQuietHours: '22~6' }).quietStart,
        proactiveGate({ proactiveQuietHours: '22~6' }).quietEnd,
      ],
      [22, 6],
    );
    assert.deepEqual(
      [
        proactiveGate({ proactiveQuietHours: '胡写' }).quietStart,
        proactiveGate({ proactiveQuietHours: '胡写' }).quietEnd,
      ],
      [23, 8],
    );
  });
});

describe('inQuietHours —— 安静时段（跨午夜）', () => {
  const g = gate();

  test('23 点与凌晨 3 点在时段内', () => {
    assert.equal(inQuietHours(23, g), true);
    assert.equal(inQuietHours(0, g), true);
    assert.equal(inQuietHours(7, g), true);
  });

  test('8 点是终点（不含），午间不在时段内', () => {
    assert.equal(inQuietHours(8, g), false);
    assert.equal(inQuietHours(15, g), false);
    assert.equal(inQuietHours(22, g), false);
  });

  test('起点等于终点视为没有安静时段', () => {
    assert.equal(inQuietHours(3, gate({ quietStart: 8, quietEnd: 8 })), false);
  });
});

describe('proactiveDue —— 该不该开口', () => {
  test('默认全满足时开口', () => {
    assert.equal(proactiveDue(check()), true);
  });

  test('关掉开关、睡觉、被占用、不可见、忙都会拦下', () => {
    assert.equal(proactiveDue(check({ gate: gate({ enabled: false }) })), false);
    assert.equal(proactiveDue(check({ sleeping: true })), false);
    assert.equal(proactiveDue(check({ locked: true })), false);
    assert.equal(proactiveDue(check({ displayed: false })), false);
    assert.equal(proactiveDue(check({ busy: true })), false);
  });

  test('用户刚说过话（未到空闲阈值）时不开口', () => {
    const c = check();
    assert.equal(proactiveDue({ ...c, lastUserAt: c.now - 10 * 60_000 }), false);
  });

  test('从没说过话（lastUserAt = 0）也要等到阈值以后', () => {
    const c = check();
    // 0 → 距离 now 远超阈值，但语义上「没有上一次发言」不该被当成空闲很久
    assert.equal(proactiveDue({ ...c, lastUserAt: 0 }), false);
  });

  test('冷却：上一次主动开口太近时不开口', () => {
    const c = check();
    // 每小时 2 句 → 冷却 30 分钟
    assert.equal(proactiveDue({ ...c, lastProactiveAt: c.now - 10 * 60_000 }), false);
    assert.equal(proactiveDue({ ...c, lastProactiveAt: c.now - 31 * 60_000 }), true);
  });

  test('每小时上限：最近一小时内已说满就闭嘴，过窗之后恢复', () => {
    const c = check();
    const recent = [c.now - 5 * 60_000, c.now - 20 * 60_000];
    assert.equal(proactiveDue({ ...c, recentProactive: recent }), false);
    // 第一条滑出一小时窗口后只剩一条，可以再说
    const slid = [c.now - 65 * 60_000, c.now - 20 * 60_000];
    assert.equal(proactiveDue({ ...c, recentProactive: slid }), true);
  });

  test('落在安静时段内不开口（22 点整仍可，23 点整不行）', () => {
    const at = (hour: number) => {
      const now = new Date(2026, 10, 4, hour, 0, 0).getTime();
      return { now, lastUserAt: now - 3_600_000, lastProactiveAt: now - 3_600_000 };
    };
    assert.equal(proactiveDue(check(at(22))), true);
    assert.equal(proactiveDue(check(at(23))), false);
    assert.equal(proactiveDue(check(at(3))), false);
  });
});
