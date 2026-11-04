/**
 * 事实记忆（src/host/plugin/chat-facts.ts）的契约测试。
 *
 * 钉住四件事：归一化（列表符号/引号/超长）、去重与淘汰顺序、渲染格式、损坏文件不静默覆盖。
 * 这些是「桌宠长期记住用户」的唯一落盘路径，写坏了会把用户数据抹掉，所以每条边界都测。
 * 跑法：node --experimental-strip-types --test src/host/plugin/chat-facts.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createChatFacts, normalizeFactText, renderFacts, FACTS_FILE_NAME, type FactsFile } from './chat-facts.ts';

/** 建一个临时用户根 + 静默日志。 */
function harness(): { userRoot: string; facts: ReturnType<typeof createChatFacts>; cleanup: () => void } {
  const userRoot = mkdtempSync(join(tmpdir(), 'dsh-pet-facts-'));
  const facts = createChatFacts({ userRoot, log: {} });
  return {
    userRoot,
    facts,
    cleanup: () => rmSync(userRoot, { recursive: true, force: true }),
  };
}

describe('normalizeFactText —— 入口归一化', () => {
  test('压空白、剥列表符号与引号', () => {
    assert.equal(normalizeFactText('  - “喜欢拿铁”  '), '喜欢拿铁');
    assert.equal(normalizeFactText('1. 怕冷'), '怕冷');
    assert.equal(normalizeFactText('a\n\n  b'), 'a b');
  });

  test('非字符串与空串返回空串（调用方据此跳过）', () => {
    assert.equal(normalizeFactText(undefined), '');
    assert.equal(normalizeFactText('   '), '');
    assert.equal(normalizeFactText(42), '');
  });

  test('超长截到 200 字', () => {
    assert.equal(normalizeFactText('字'.repeat(300)).length, 200);
  });
});

describe('renderFacts —— 提示词段', () => {
  const fact = (text: string) => ({ id: text, text, ts: 1, usedAt: 1, source: 'manual' as const });

  test('空清单回空串（调用方据此决定不加段）', () => {
    assert.equal(renderFacts([], 10), '');
    assert.equal(renderFacts([fact('a')], 0), '');
  });

  test('首行是标题，其余每条一行，按注入上限截断', () => {
    const text = renderFacts([fact('喜欢拿铁'), fact('怕冷'), fact('养了猫')], 2);
    assert.equal(text, ['【你记得关于ta的事】', '- 喜欢拿铁', '- 怕冷'].join('\n'));
  });
});

describe('createChatFacts —— 落盘与淘汰', () => {
  test('add 去重、list 只回可用的条目', async () => {
    const h = harness();
    try {
      const added = await h.facts.add('main', 'p', ['喜欢拿铁', '喜欢拿铁', '  '], 'manual', 60);
      assert.deepEqual(
        added.map((f) => f.text),
        ['喜欢拿铁'],
      );
      const again = await h.facts.add('main', 'p', ['喜欢拿铁'], 'manual', 60);
      assert.equal(again.length, 0, '同一句不该重复记');
      const list = await h.facts.list('main', 'p');
      assert.equal(list.length, 1);
      assert.equal(list[0].source, 'manual');
    } finally {
      h.cleanup();
    }
  });

  test('超上限按 usedAt 先淘汰（常用的事实留得住）', async () => {
    const h = harness();
    try {
      await h.facts.add('main', 'p', ['a', 'b', 'c'], 'manual', 3);
      const before = await h.facts.list('main', 'p');
      // 把 a 的 usedAt 拖到最早（模拟长期没被注入），再加一条触发淘汰
      const file = join(h.userRoot, FACTS_FILE_NAME);
      const data = JSON.parse(readFileSync(file, 'utf8')) as FactsFile;
      const facts = data.main.p.facts;
      const a = facts.find((f) => f.text === 'a');
      assert.ok(a);
      a.usedAt = 1;
      for (const f of facts) if (f.text !== 'a') f.usedAt = Date.now();
      writeFileSync(file, JSON.stringify(data), 'utf8');

      assert.equal(before.length, 3);
      await h.facts.add('main', 'p', ['d'], 'manual', 3);
      const after = await h.facts.list('main', 'p');
      assert.equal(after.length, 3);
      assert.equal(
        after.some((f) => f.text === 'a'),
        false,
        '最久没用到的该被淘汰',
      );
      assert.equal(
        after.some((f) => f.text === 'd'),
        true,
        '新事实必须留下',
      );
    } finally {
      h.cleanup();
    }
  });

  test('render 刷新 usedAt，renderSync 与 render 语义一致', async () => {
    const h = harness();
    try {
      await h.facts.add('main', 'p', ['喜欢拿铁'], 'manual', 60);
      const file = join(h.userRoot, FACTS_FILE_NAME);
      const first = JSON.parse(readFileSync(file, 'utf8')) as FactsFile;
      const ts0 = first.main.p.facts[0].usedAt;
      assert.equal(typeof ts0, 'number');

      const rendered = await h.facts.render('main', 'p', 10);
      assert.equal(rendered, ['【你记得关于ta的事】', '- 喜欢拿铁'].join('\n'));

      const syncRendered = h.facts.renderSync('main', 'p', 10);
      assert.equal(syncRendered, rendered, '同步版必须与异步版同文案');
      assert.equal(h.facts.renderSync('main', 'nobody', 10), '', '没有事实时回空串');
    } finally {
      h.cleanup();
    }
  });

  test('update / drop / clear 的计数语义', async () => {
    const h = harness();
    try {
      const added = await h.facts.add('main', 'p', ['a', 'b', 'c'], 'manual', 60);
      assert.equal(await h.facts.update('main', 'p', added[0].id, '  新正文  '), true);
      assert.equal(await h.facts.update('main', 'p', 'missing', 'x'), false);
      const list = await h.facts.list('main', 'p');
      assert.equal(list[0].text, '新正文');

      assert.equal(await h.facts.drop('main', 'p', [added[1].id]), 1);
      assert.equal(await h.facts.clear('main', 'p'), 2, '清空返回剩下的条数');
      assert.deepEqual(await h.facts.list('main', 'p'), []);
    } finally {
      h.cleanup();
    }
  });

  test('损坏文件改名成 .corrupt-<ts> 留档，原文件不再存在', async () => {
    const h = harness();
    try {
      const file = join(h.userRoot, FACTS_FILE_NAME);
      writeFileSync(file, 'not json at all', 'utf8');
      assert.deepEqual(await h.facts.list('main', 'p'), []);
      const names = readdirSync(h.userRoot);
      assert.equal(names.includes(FACTS_FILE_NAME), false, '原文件名不该还在（否则下次写会静默覆盖用户数据）');
      const backup = names.find((n) => n.startsWith(FACTS_FILE_NAME + '.corrupt-'));
      assert.ok(backup, '必须留下一份 .corrupt-<ts> 存档');
      assert.equal(readFileSync(join(h.userRoot, backup), 'utf8'), 'not json at all', '存档内容要与原件一致');
    } finally {
      h.cleanup();
    }
  });
});
