/**
 * 事实记忆：跨会话长期记住「关于用户的事」（喜好、称呼、习惯、约定）。
 *
 * 与 memory.json 的分工：memory.json 是逐句对话流水（只截尾部若干轮进上下文），
 * 本文件是提炼后的事实清单（一直保留、按注入上限进上下文），两者互不覆盖。
 *
 * 不负责拼提示词（归 ../persona），不负责调模型（归 ../chat 与调用方）。
 * 始终成立：写盘原子（tmp + rename），解析失败的文件改名留档而不是被下一次写覆盖。
 * @module dsh-pet/src/host/plugin/chat-facts
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LoggerLike } from '../log-file.ts';

/** 事实文件的文件名（与 memory.json 同目录）。 */
export const FACTS_FILE_NAME = 'memory-facts.json';

/** 单条事实的最大字数：提炼阶段就该短，超长在入口处截断，不让提示词被一条拖垮。 */
const MAX_FACT_CHARS = 200;

/** 一条事实。 */
export interface Fact {
  /** 稳定 id（编辑 / 删除用它定位）。 */
  id: string;
  /** 事实正文（已归一化：去首尾空白、压空白、去前缀符号）。 */
  text: string;
  /** 写入时刻（毫秒）。 */
  ts: number;
  /** 最近一次被注入上下文的时刻（毫秒，淘汰按它排）。 */
  usedAt: number;
  /** 来源：auto = 对话后自动提炼，manual = 面板编辑，command = /remember 命令。 */
  source: 'auto' | 'manual' | 'command';
}

/** 文件结构：条目（素材根）→ 宠物 id → 事实表。与 memory.json 同构两层，便于按宠物隔离。 */
export type FactsFile = Record<string, Record<string, { facts: Fact[] }>>;

/** 归一化一条事实正文：去前缀符号、压空白、截断；空串表示不该记。 */
export function normalizeFactText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let text = raw.replace(/\s+/g, ' ').trim();
  // 模型常带「- 」「* 」「1. 」这类列表符号与引号，落盘前剥掉，避免提示词里出现双层符号
  text = text.replace(/^[-*•·\d.、)\]]+\s*/, '').trim();
  text = text.replace(/^["'「“]|["'」”]$/g, '').trim();
  if (text.length > MAX_FACT_CHARS) text = text.slice(0, MAX_FACT_CHARS).trim();
  return text;
}

/** 事实记忆的依赖。 */
export interface ChatFactsInput {
  /** 用户数据根目录（~/.dsh/dsh-pet）。 */
  readonly userRoot: string;
  /** 宿主日志。 */
  readonly log: LoggerLike;
}

/** 事实记忆的产出（供下游工厂按需 Pick）。 */
export interface ChatFacts {
  /** 事实文件路径。 */
  readonly factsPath: string;
  list(entry: string, petId: string): Promise<Fact[]>;
  add(entry: string, petId: string, texts: readonly string[], source: Fact['source'], max: number): Promise<Fact[]>;
  update(entry: string, petId: string, id: string, text: string): Promise<boolean>;
  drop(entry: string, petId: string, ids: readonly string[]): Promise<number>;
  clear(entry: string, petId: string): Promise<number>;
  /** 渲染进提示词的事实段（同时记 usedAt；返回空串表示没有可注入的事实）。 */
  render(entry: string, petId: string, injectMax: number): Promise<string>;
  /**
   * render 的同步版：给「系统提示词装配」这类**必须同步返回**的场合用。
   *
   * DSH 的 `systemPrompt.section({ text })` 支持把 text 写成函数、每次装配现算，
   * 但装配是同步的 —— async 的 render 在那里只会拼出 `[object Promise]`。
   * 因此这一份走同步文件 API（进程内没有 await 点，天然不会被别的写打断），
   * 语义与 render 完全一致：同样截断、同样刷新 usedAt、同样空清单回空串。
   * 记时间失败不影响返回（提示词装配不该因为写盘失败而抛）。
   */
  renderSync(entry: string, petId: string, injectMax: number): string;
}

/** 一条事实的渲染行。 */
export function factLine(text: string): string {
  return '- ' + text;
}

/** 一批事实的渲染段：空清单返回空串（调用方据此决定加不加段）。 */
export function renderFacts(facts: readonly Fact[], injectMax: number): string {
  const limit = Number.isFinite(injectMax) && injectMax > 0 ? Math.floor(injectMax) : 0;
  const picked = limit > 0 ? facts.slice(0, limit) : [];
  if (picked.length === 0) return '';
  return ['【你记得关于ta的事】', ...picked.map((f) => factLine(f.text))].join('\n');
}

/** 生成事实 id：时间戳 + 随机尾巴，只需进程内与文件内唯一。 */
function newFactId(now: number): string {
  return 'f' + now.toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * 创建事实记忆服务（`apply` 期间构造一次）。
 *
 * @param deps - 用户根目录与日志。
 * @returns 读写事实的串行接口。
 */
export function createChatFacts(deps: ChatFactsInput): ChatFacts {
  const { userRoot, log } = deps;
  const factsPath = join(userRoot, FACTS_FILE_NAME);
  // 同进程内的读改写串行队列：与 memory.json 同一套路，避免两个请求交错写坏文件
  let queue: Promise<void> = Promise.resolve();
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** 读文件：不存在 → 空；解析失败 → 改名留档 + 空（绝不静默覆盖用户数据）。 */
  const readFacts = async (): Promise<FactsFile> => {
    let raw: string;
    try {
      raw = await readFile(factsPath, 'utf8');
    } catch {
      return {};
    }
    try {
      const parsed = JSON.parse(raw) as FactsFile;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return parsed;
    } catch (e) {
      const backup = factsPath + '.corrupt-' + Date.now();
      try {
        await rename(factsPath, backup);
        log.error?.(
          `dsh-pet: 事实记忆文件无法解析，已改名为 ${backup}（事实清单将从空开始）：${e instanceof Error ? e.message : String(e)}`,
        );
      } catch (renameError) {
        log.error?.(
          `dsh-pet: 事实记忆文件无法解析且改名失败：${renameError instanceof Error ? renameError.message : String(renameError)}`,
        );
      }
      return {};
    }
  };

  /** 原子写：先写 tmp 再 rename，进程被杀时不会留下半个 JSON。 */
  const writeFacts = async (data: FactsFile): Promise<void> => {
    await mkdir(userRoot, { recursive: true });
    const tmp = factsPath + '.tmp';
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, factsPath);
  };

  /** 取出某个宠物的可变事实容器（不存在则创建）。 */
  const bucketOf = (data: FactsFile, entry: string, petId: string): { facts: Fact[] } => {
    const byPet = (data[entry] ??= {});
    const leaf = (byPet[petId] ??= { facts: [] });
    if (!Array.isArray(leaf.facts)) leaf.facts = [];
    return leaf;
  };

  const list = (entry: string, petId: string): Promise<Fact[]> =>
    withLock(async () => {
      const data = await readFacts();
      const facts = data[entry]?.[petId]?.facts;
      return Array.isArray(facts) ? facts.filter((f) => f && typeof f.text === 'string') : [];
    });

  const add = (
    entry: string,
    petId: string,
    texts: readonly string[],
    source: Fact['source'],
    max: number,
  ): Promise<Fact[]> =>
    withLock(async () => {
      const data = await readFacts();
      const leaf = bucketOf(data, entry, petId);
      const now = Date.now();
      const seen = new Set(leaf.facts.map((f) => f.text.toLowerCase()));
      const added: Fact[] = [];
      for (const raw of texts) {
        const text = normalizeFactText(raw);
        if (text === '' || seen.has(text.toLowerCase())) continue;
        const fact: Fact = { id: newFactId(now + added.length), text, ts: now, usedAt: now, source };
        leaf.facts.push(fact);
        seen.add(text.toLowerCase());
        added.push(fact);
      }
      // 淘汰：超出上限时按「最久没被用到」先走，其次按写入时间（新事实优先留下）
      const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 60;
      if (leaf.facts.length > limit) {
        leaf.facts.sort((a, b) => a.usedAt - b.usedAt || a.ts - b.ts);
        leaf.facts = leaf.facts.slice(leaf.facts.length - limit);
      }
      if (added.length > 0) await writeFacts(data);
      return added;
    });

  const update = (entry: string, petId: string, id: string, text: string): Promise<boolean> =>
    withLock(async () => {
      const data = await readFacts();
      const leaf = data[entry]?.[petId];
      const target = leaf?.facts.find((f) => f.id === id);
      if (!target) return false;
      const next = normalizeFactText(text);
      if (next === '') return false;
      target.text = next;
      target.ts = Date.now();
      await writeFacts(data);
      return true;
    });

  const drop = (entry: string, petId: string, ids: readonly string[]): Promise<number> =>
    withLock(async () => {
      const data = await readFacts();
      const leaf = data[entry]?.[petId];
      if (!leaf) return 0;
      const doomed = new Set(ids);
      const before = leaf.facts.length;
      leaf.facts = leaf.facts.filter((f) => !doomed.has(f.id));
      const removed = before - leaf.facts.length;
      if (removed > 0) {
        if (leaf.facts.length === 0) {
          delete data[entry][petId];
          if (Object.keys(data[entry]).length === 0) delete data[entry];
        }
        await writeFacts(data);
      }
      return removed;
    });

  const clear = (entry: string, petId: string): Promise<number> =>
    withLock(async () => {
      const data = await readFacts();
      const leaf = data[entry]?.[petId];
      if (!leaf) return 0;
      const removed = leaf.facts.length;
      if (removed > 0) {
        delete data[entry][petId];
        if (Object.keys(data[entry]).length === 0) delete data[entry];
        await writeFacts(data);
      }
      return removed;
    });

  const render = (entry: string, petId: string, injectMax: number): Promise<string> =>
    withLock(async () => {
      const data = await readFacts();
      const facts = data[entry]?.[petId]?.facts;
      if (!Array.isArray(facts) || facts.length === 0) return '';
      const section = renderFacts(facts, injectMax);
      if (section === '') return '';
      // 注入 = 用到了：刷新 usedAt，淘汰时优先保留常用事实
      const limit = Number.isFinite(injectMax) && injectMax > 0 ? Math.floor(injectMax) : 0;
      const now = Date.now();
      for (const fact of facts.slice(0, limit)) fact.usedAt = now;
      await writeFacts(data);
      return section;
    });

  const renderSync = (entry: string, petId: string, injectMax: number): string => {
    let raw: string;
    try {
      raw = readFileSync(factsPath, 'utf8');
    } catch {
      return '';
    }
    let data: FactsFile;
    try {
      const parsed = JSON.parse(raw) as FactsFile;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
      data = parsed;
    } catch {
      // 同步路径不改名留档（那是写路径的职责），只当作没有事实，等写路径去处理损坏文件
      return '';
    }
    const facts = data[entry]?.[petId]?.facts;
    if (!Array.isArray(facts) || facts.length === 0) return '';
    const section = renderFacts(facts, injectMax);
    if (section === '') return '';
    const limit = Number.isFinite(injectMax) && injectMax > 0 ? Math.floor(injectMax) : 0;
    const now = Date.now();
    for (const fact of facts.slice(0, limit)) fact.usedAt = now;
    try {
      const tmp = factsPath + '.tmp';
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      renameSync(tmp, factsPath);
    } catch {
      // 记时间失败不影响提示词照常带上事实
    }
    return section;
  };

  return { factsPath, list, add, update, drop, clear, render, renderSync };
}
