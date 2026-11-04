/**
 * 事实记忆的查看与编辑：`/memory/facts`。
 *
 * 不负责提炼（归 ./plugin/fact-extract），不负责拼提示词（归 ../persona）。
 * 与 /chat 分开一组路径：一个管「说过的话」，一个管「记住的事」，混在一起会让前端
 * 的「清空对话」误伤事实清单。
 * @module dsh-pet/src/host/routes/facts
 */
import { readAllConfig } from '../config.ts';
import type { RouteResult } from '../http.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';

/** 单次 POST 最多接受几条：面板手填不会超过这个数，防一次请求塞满清单。 */
const MAX_ADD_PER_REQUEST = 20;

/** 单条事实的最大字数（传进下列提示由 chat-facts 的 normalizeFactText 再截一次）。 */
const MAX_TEXT_CHARS = 200;

/** 条目级事实条数上限（`factsMax`，缺省 60）：与自动提炼用同一个口径。 */
function factsMaxOf(conf: Record<string, unknown>): number {
  const raw = Number(conf.factsMax);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60;
}

/** 事实记忆领域：未命中返回 undefined，命中返回应答。 */
export async function handleFactsRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  // 正向命中写在这里而不是用负向守卫提前返回：scripts/check-openapi.mjs 靠扫
  // 「rest 全等某个一级段」的写法建立「实现里有哪些段」的集合，负向守卫会被它漏掉，
  // 于是文档里的 /memory 会被误报成「实现中不存在」。
  if (input.rest === 'memory/facts') return handleFacts(deps, input);
  return undefined;
}

/** 真正的事实记忆处理（只被上面的正向命中调用）。 */
async function handleFacts(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult> {
  const { configPaths, facts, requirePet } = deps;
  const { body, method, url } = input;
  if (method !== 'GET' && method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') return methodNotAllowed();

  try {
    // 惰性读配置：GET 也要读，因为条数上限与宠物归属都从配置来
    let cfgCache: Record<string, Record<string, unknown>> | undefined;
    const cfg = (): Record<string, Record<string, unknown>> => (cfgCache ??= readAllConfig(configPaths));
    const who = requirePet(url.searchParams, cfg);
    if (!who.ok) return who.res;
    const petId = who.petId;

    if (method === 'GET') {
      return okResult({ ok: true, facts: await facts.list(who.entry, petId), max: factsMaxOf(who.conf) });
    }

    if (method === 'DELETE') {
      // `?id=`（可重复）= 只删这几条；不传 = 清空这只宠物的全部事实
      const ids = url.searchParams
        .getAll('id')
        .map((v) => v.trim())
        .filter((v) => v !== '');
      const removed = ids.length === 0 ? await facts.clear(who.entry, petId) : await facts.drop(who.entry, petId, ids);
      // 回包与 GET/POST 同形（removed + 最新清单）：面板每次写完都直接拿这份渲染，
      // 不用再补一次 GET，也不会出现「删了一条整列变空」的中间态。
      return okResult({ ok: true, removed, facts: await facts.list(who.entry, petId), max: factsMaxOf(who.conf) });
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
    } catch {
      return invalidJson();
    }

    if (method === 'PATCH') {
      const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
      const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
      if (id === '') return failResult('bad-request', '缺少 id');
      if (text === '') return failResult('bad-request', '内容为空');
      if (text.length > MAX_TEXT_CHARS) return failResult('bad-request', `内容过长（限 ${MAX_TEXT_CHARS} 字）`);
      const changed = await facts.update(who.entry, petId, id, text);
      if (!changed) return failResult('bad-request', '没有这条记忆：' + id);
      return okResult({ ok: true, facts: await facts.list(who.entry, petId), max: factsMaxOf(who.conf) });
    }

    // POST：`text` 单条，或 `texts` 批量（两者都给时以 texts 为准）
    const many = Array.isArray(parsed.texts) ? parsed.texts : undefined;
    const one = typeof parsed.text === 'string' ? parsed.text : undefined;
    const raws = (many ?? (one === undefined ? [] : [one])).filter((v): v is string => typeof v === 'string');
    const texts = raws.map((v) => v.trim()).filter((v) => v !== '');
    if (texts.length === 0) return failResult('bad-request', '内容为空');
    if (texts.length > MAX_ADD_PER_REQUEST) {
      return failResult('bad-request', `一次最多加 ${MAX_ADD_PER_REQUEST} 条`);
    }
    if (texts.some((v) => v.length > MAX_TEXT_CHARS)) {
      return failResult('bad-request', `单条过长（限 ${MAX_TEXT_CHARS} 字）`);
    }
    const added = await facts.add(who.entry, petId, texts, 'manual', factsMaxOf(who.conf));
    return okResult({ ok: true, added, facts: await facts.list(who.entry, petId), max: factsMaxOf(who.conf) });
  } catch (e) {
    return failResult('generate-error', e instanceof Error ? e.message : String(e));
  }
}
