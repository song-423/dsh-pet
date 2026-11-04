/**
 * 主动搭话的门禁（纯函数）与调度拍。
 *
 * 与碎碎念的分工：碎碎念 = 按固定周期说一句与上下文无关的话；主动搭话 = **没人说话一阵子之后**
 * 接上话头说一句（能看到最近几轮历史和事实记忆，见 chat-memory 的 publishProactive）。
 * 所以这里的每一道门都是「现在到底该不该开口」，不含任何文案与模型调用。
 *
 * 门禁全部收在这个文件，是为了能被单测直接喂时间戳——定时器本身只有 `registerProactiveLoop`
 * 一处，那一层不承担判断。
 *
 * @module dsh-pet/src/host/plugin/proactive
 */

/** 一拍多久检查一次（秒）：主动搭话的精度只要到分钟，60s 足够，也不至于白跑。 */
export const PROACTIVE_TICK_SEC = 60;

/** 空闲多久算「安静了」（分钟，缺省 45）：太短会打断用户思考，太长就永远轮不到。 */
const DEFAULT_IDLE_MIN = 45;

/** 每小时最多几句（缺省 2）：主动搭话是点缀，多了就是骚扰。 */
const DEFAULT_PER_HOUR = 2;

/** 安静时段缺省值（本地时间，跨午夜）：这段时间内绝不主动开口。 */
const DEFAULT_QUIET = '23:00-08:00';

/** 主动搭话的门禁参数（已解析成数字）。 */
export interface ProactiveGate {
  /** 条目是否开启主动搭话。 */
  enabled: boolean;
  /** 空闲判定阈值（毫秒）。 */
  idleMs: number;
  /** 每小时上限。 */
  perHour: number;
  /** 安静时段：起点小时（含）与终点小时（不含），均为本地 0–23。 */
  quietStart: number;
  quietEnd: number;
}

/** 把 `HH:MM-HH:MM` / `HH-HH` 解析成一对小时；解析不了回落缺省。 */
function parseQuietHours(raw: unknown): { start: number; end: number } {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const m = /^(\d{1,2})(?::\d{2})?\s*[-~至到]\s*(\d{1,2})(?::\d{2})?$/.exec(text);
  const toHour = (v: string | undefined): number | null => {
    if (v === undefined) return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
  };
  const start = toHour(m?.[1]);
  const end = toHour(m?.[2]);
  if (start === null || end === null) {
    const fallback = /^(\d{1,2}):\d{2}-(\d{1,2}):\d{2}$/.exec(DEFAULT_QUIET);
    return { start: Number(fallback?.[1] ?? 23), end: Number(fallback?.[2] ?? 8) };
  }
  return { start, end };
}

/**
 * 从条目配置解析门禁。
 *
 * 缺省全关（`proactiveEnabled` 不写 = 不开）：主动开口是打扰型功能，必须用户显式打开。
 *
 * @param conf - 合并后的条目配置。
 * @returns 解析好的门禁（非法值全部回落缺省，不抛）。
 */
export function proactiveGate(conf: Record<string, unknown>): ProactiveGate {
  const idleRaw = Number(conf.proactiveIdleMin);
  const perHourRaw = Number(conf.proactivePerHour);
  const { start, end } = parseQuietHours(conf.proactiveQuietHours);
  return {
    enabled: conf.proactiveEnabled === true,
    idleMs: (Number.isFinite(idleRaw) && idleRaw > 0 ? idleRaw : DEFAULT_IDLE_MIN) * 60_000,
    perHour: Number.isFinite(perHourRaw) && perHourRaw > 0 ? Math.floor(perHourRaw) : DEFAULT_PER_HOUR,
    quietStart: start,
    quietEnd: end,
  };
}

/** 某个本地小时是否落在安静时段内（支持跨午夜：23–08 表示 23,0..7）。 */
export function inQuietHours(hour: number, gate: ProactiveGate): boolean {
  const { quietStart, quietEnd } = gate;
  if (quietStart === quietEnd) return false;
  // 跨午夜：起点 > 终点 → 命中区间是 [start, 24) ∪ [0, end)
  return quietStart > quietEnd ? hour >= quietStart || hour < quietEnd : hour >= quietStart && hour < quietEnd;
}

/** 一次判定的输入：全是可注入的事实，函数自身不看时钟也不读配置。 */
export interface ProactiveCheck {
  /** 判定时刻（毫秒）。 */
  now: number;
  /** 上一次用户发言时刻（ms；0 = 从没说过话）。 */
  lastUserAt: number;
  /** 这只宠物上一次主动开口的时刻（ms；0 = 没有过）。 */
  lastProactiveAt: number;
  /** 最近一小时内主动开口的时刻（用于每小时上限）。 */
  recentProactive: readonly number[];
  gate: ProactiveGate;
  /** 是否正在睡觉。 */
  sleeping: boolean;
  /** 是否被占用（别的交互正在进行）。 */
  locked: boolean;
  /** 当前 display 是否可见。 */
  displayed: boolean;
  /** 上次主动搭话的那句话的生成结果是否还在队列里没消化（防连发）。 */
  busy: boolean;
}

/**
 * 现在该不该主动开口。
 *
 * 顺序有讲究：先看硬开关，再看便宜的状态位，最后才比较时间——日志里能看出是「关着」还是「还不到点」。
 *
 * @returns 该开口时返回 `true`；任何一道门不满足都返回 `false`。
 */
export function proactiveDue(check: ProactiveCheck): boolean {
  if (!check.gate.enabled) return false;
  if (check.sleeping || check.locked || !check.displayed || check.busy) return false;
  if (inQuietHours(new Date(check.now).getHours(), check.gate)) return false;
  // 从没说过话也要等：新装/新加的宠物不该一上来就自顾自开口
  // （lastUserAt = 0 表示「还没有过用户发言」，不是「很久以前说过」——按后者算会立刻满足空闲阈值）
  if (check.lastUserAt <= 0) return false;
  if (check.now - check.lastUserAt < check.gate.idleMs) return false;
  // 冷却：一小时上限 N 句 → 两句之间至少 3600/N 秒
  const cooldownMs = 3_600_000 / check.gate.perHour;
  if (check.now - check.lastProactiveAt < cooldownMs) return false;
  const windowStart = check.now - 3_600_000;
  return check.recentProactive.filter((t) => t > windowStart).length < check.gate.perHour;
}
