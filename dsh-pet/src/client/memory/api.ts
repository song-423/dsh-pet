/**
 * 记忆面板的数据访问：事实记忆的「看 / 加 / 改 / 删」。
 *
 * 只做 HTTP 与响应整形，不碰 DOM、不持状态；失败回判别联合，由面板决定怎么显示。
 * 对话原文（memory.json）走 ./chat/api，这里只管事实清单——两者是两份文件、两组路由。
 * @module dsh-pet/src/client/memory/api
 */
import { ROUTE_PATH } from '../../shared/constants.ts';

/** 一条事实记忆（与宿主 `Fact` 同形，只取显示用到的字段）。 */
export interface FactView {
  readonly id: string;
  readonly text: string;
  /** 记下来的时刻（毫秒）。 */
  readonly ts: number;
  /** 最近一次被注入提示词的时刻（毫秒）；0 = 还没用过。 */
  readonly usedAt: number;
  /** 来源：自动提炼 / 手动添加 / 命令。 */
  readonly source: string;
}

/** 一次读取的结果：清单 + 上限（上限用于面板显示「N/60」）。 */
export interface FactsSnapshot {
  readonly facts: FactView[];
  readonly max: number;
}

/** 业务失败（宿主 HTTP 200 + `{ok:false}`）或网络失败。 */
export interface FactsError {
  readonly ok: false;
  readonly message: string;
}

/** 把响应体里的事实列表收窄；坏条目直接丢弃，一条坏数据不该让整份清单消失。 */
function factsOf(body: unknown): FactView[] {
  const raw = (body as { facts?: unknown } | null)?.facts;
  if (!Array.isArray(raw)) return [];
  const out: FactView[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    if (typeof f.id !== 'string' || f.id === '' || typeof f.text !== 'string') continue;
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    out.push({
      id: f.id,
      text: f.text,
      ts: num(f.ts),
      usedAt: num(f.usedAt),
      source: typeof f.source === 'string' ? f.source : 'manual',
    });
  }
  return out;
}

/** 统一的请求封装：非 JSON / 业务失败都折成 `FactsError`。 */
async function request(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  petId: string,
  options: { readonly query?: string; readonly body?: unknown } = {},
): Promise<{ ok: true; body: Record<string, unknown> } | FactsError> {
  const query = '?pet=' + encodeURIComponent(petId) + (options.query ?? '');
  try {
    const res = await fetch(ROUTE_PATH + '/memory/facts' + query, {
      method,
      cache: 'no-store',
      ...(options.body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) }),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null) return { ok: false, message: 'HTTP ' + res.status };
    if (body.ok === false) {
      return { ok: false, message: typeof body.message === 'string' ? body.message : String(body.reason ?? 'failed') };
    }
    return { ok: true, body };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 读某只宠物的事实清单。
 *
 * @param petId - 宠物 id。
 * @param signal - 中止信号（面板卸载时取消）。
 * @returns 清单与上限，或失败文案。
 */
export async function fetchFacts(petId: string, signal?: AbortSignal): Promise<FactsSnapshot | FactsError> {
  try {
    const res = await fetch(ROUTE_PATH + '/memory/facts?pet=' + encodeURIComponent(petId), {
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null) return { ok: false, message: 'HTTP ' + res.status };
    if (body.ok === false) {
      return { ok: false, message: typeof body.message === 'string' ? body.message : String(body.reason ?? 'failed') };
    }
    const max = Number(body.max);
    return { facts: factsOf(body), max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 60 };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 手动记一条事实。
 *
 * @param petId - 宠物 id。
 * @param text - 事实正文（宿主 trim 并校验 200 字）。
 * @returns 成功时带回新清单，失败给文案。
 */
export async function addFact(petId: string, text: string): Promise<FactsSnapshot | FactsError> {
  const res = await request('POST', petId, { body: { text } });
  if (!res.ok) return res;
  const max = Number(res.body.max);
  return { facts: factsOf(res.body), max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 60 };
}

/** 改一条事实的正文。 */
export async function updateFact(petId: string, id: string, text: string): Promise<FactsSnapshot | FactsError> {
  const res = await request('PATCH', petId, { body: { id, text } });
  if (!res.ok) return res;
  const max = Number(res.body.max);
  return { facts: factsOf(res.body), max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 60 };
}

/**
 * 删若干条（`ids` 为空 = 清空这只宠物的全部事实）。
 *
 * @param petId - 宠物 id。
 * @param ids - 要删的事实 id；空数组表示清空。
 * @returns 成功时带回剩余清单。
 */
export async function dropFacts(petId: string, ids: readonly string[]): Promise<FactsSnapshot | FactsError> {
  const query = ids.map((id) => '&id=' + encodeURIComponent(id)).join('');
  const res = await request('DELETE', petId, { query });
  if (!res.ok) return res;
  const max = Number(res.body.max);
  return { facts: factsOf(res.body), max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 60 };
}
