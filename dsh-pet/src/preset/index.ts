/**
 * 桌宠预设：把「桌宠」这个人格装进 DSH 的预设（agent preset）体系。
 *
 * 为什么要这一层：桌宠本来只活在浮窗里，用户想把它变成「DSH 里一个专门陪聊的会话」——
 * 同一个工作区、同一套会话界面，但人格是桌宠、工具只给只读。预设是 DSH 里唯一能把
 * 「人格 + 工具集」一起打包给一个会话的扩展点（见 @deepseek-ai/dsh-agent-preset）。
 *
 * 三条职责，全部只在本模块内实现：
 * 1. systemPrompt 的 deployment:persona-prefix 段 —— 用同名 section 覆盖部署人设，
 *    文本是**函数**（每次装配现算），这样事实记忆一改立刻生效，不必重开会话；
 * 2. /remember、/forget、/memory 三个命令 —— 让用户在会话里直接管记忆；
 * 3. 只读礼节 —— 工具集由 cordis.patch.yml 里的 tool-fs 配置裁剪成只读，这里补一句解释。
 *
 * 不碰网络、不发起对话、不写 memory.json：事实清单与浮窗共用 host/plugin/chat-facts 的那份文件。
 * 必须始终成立：本模块不在装配期读盘抛错（默认配置缺失时退化成「只有只读礼节」的一段文本），
 * 装配失败会让整个会话起不来，代价远大于少记几条事实。
 * @module dsh-pet/src/preset
 */
import { join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { findPetInstance, readAllConfig } from '../host/config.ts';
import type { ConfigPaths } from '../host/config.ts';
import type { LoggerLike } from '../host/log-file.ts';
import { PACKAGE_ROOT } from '../host/paths.ts';
import { petPersona } from '../host/persona.ts';
import { createChatFacts, type ChatFacts, type Fact } from '../host/plugin/chat-facts.ts';

/** Cordis 插件名（与包内宿主半侧的 `pet` 区分开）。 */
export const name = 'pet-preset';

/** 需要宿主提供的能力：提示词注册表与命令注册表。 */
export const inject = ['systemPrompt', 'commands'];

/** 覆盖部署人设用的 section 名：与 @deepseek-ai/dsh-system-prompt 的常量同值。 */
const PERSONA_SECTION = 'deployment:persona-prefix';

/** 由预设自己挑宠物时用的环境变量（缺省 = main 条目的第一只）。 */
const PET_ENV = 'DSH_PET_PRESET_PET';

/** 只读礼节：工具集已经裁到只剩读，这里说清楚为什么，免得模型以为自己「应该」能改。 */
const READONLY_LINE =
  '【说明】这个会话里你只有只读工具：可以看文件、翻代码、听用户讲，但改不了任何东西。' +
  '需要动手时，把该改什么、怎么改说清楚，让用户在普通会话里执行；不要假装已经改好了。';

/** 事实注入上限的兜底（与宿主侧 factsInjectMax 的缺省一致）。 */
const DEFAULT_INJECT_MAX = 25;

/** 记忆上限的兜底（与宿主侧 factsMax 的缺省一致）。 */
const DEFAULT_FACTS_MAX = 60;

/** 单条 /remember 输入的最大字数，与事实本体的截断上限同口径。 */
const MAX_COMMAND_TEXT = 200;

/** 预设自己算出来的路径：与 host/plugin/setup 的同名量保持同一口径。 */
interface PresetPaths {
  /** 用户数据根（~/.dsh/dsh-pet） */
  userRoot: string;
  /** 配置路径集（内置默认 + 用户主配置 + 文件宠物目录） */
  configPaths: ConfigPaths;
}

/** 命令处理结果（与 @deepseek-ai/dsh-commands 的 CommandResult 同形）。 */
type CommandResult = { kind: 'success'; text: string } | { kind: 'error'; text: string };

/** 命令 handler 收到的调用信息里本模块用到的字段。 */
interface CommandInvocation {
  /** 斜杠后面的原文（去掉前导空格） */
  rawInput: string;
}

/**
 * 复算用户数据根与配置路径。
 *
 * 不复用宿主侧的 createHostSetup：那是另一个 Cordis 容器里的对象，预设作用域拿不到；
 * 但两边的路径口径必须一致（都从 resolveDshHome() 派生），否则会读到两份不同的配置。
 */
function presetPaths(): PresetPaths {
  const userRoot = join(resolveDshHome(), 'dsh-pet');
  return {
    userRoot,
    configPaths: {
      defaultFile: join(PACKAGE_ROOT, 'assets', 'config.jsonc'),
      userFile: join(userRoot, 'main-config.jsonc'),
      legacyUserFile: join(userRoot, 'main-config.json'),
      petDir: join(userRoot, 'pet'),
    },
  };
}

/** 预设对应的宠物 id：环境变量优先，缺省取 main 条目的第一只；一只都没有则空串。 */
function pickPetId(merged: Record<string, Record<string, unknown>>): string {
  const fromEnv = process.env[PET_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  const mainPets = merged.main?.pets;
  const first = Array.isArray(mainPets) ? (mainPets[0] as Record<string, unknown> | undefined) : undefined;
  return first ? String(first.id ?? '') : '';
}

/** 读一次成品配置并按 id 定位宠物；读不到一律返回 undefined（装配期绝不抛）。 */
function findPresetPet(
  configPaths: ConfigPaths,
  petId: string,
): { entry: string; conf: Record<string, unknown>; pet: Record<string, unknown> } | undefined {
  if (petId === '') return undefined;
  try {
    return findPetInstance(readAllConfig(configPaths), petId);
  } catch {
    return undefined;
  }
}

/** 配置里某个数值字段：非有限或非正数时用兜底值。 */
function numberField(conf: Record<string, unknown>, key: string, fallback: number): number {
  const raw = Number(conf[key]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/**
 * 每次装配现算的人设段。
 *
 * 顺序与宿主侧 composeSystemPrompt 一致（人设 → 名字 → 事实），但这里不拼时间背景：
 * 预设的会话由 DSH 的 time-context 行负责，重复拼会出现两个「现在」。
 */
function sectionText(configPaths: ConfigPaths, facts: ChatFacts): string {
  const petId = pickPetId(readAllConfigSafe(configPaths) ?? {});
  const found = findPresetPet(configPaths, petId);
  const blocks: string[] = [];
  if (found) {
    const persona = petPersona(found.conf, found.pet).trim();
    if (persona !== '') blocks.push(persona);
    const petName = String(found.pet.name ?? '').trim();
    if (petName !== '') blocks.push('你的名字是“' + petName + '”。');
    if (found.conf.factsEnabled !== false) {
      let factsText: string;
      try {
        factsText = facts.renderSync(found.entry, petId, numberField(found.conf, 'factsInjectMax', DEFAULT_INJECT_MAX));
      } catch {
        factsText = ''; // 事实读不到不该毁掉整段人设
      }
      if (factsText !== '') blocks.push(factsText);
    }
  }
  blocks.push(READONLY_LINE);
  return blocks.join('\n');
}

/** readAllConfig 的静默版：读失败返回 undefined，供「装配期不抛」的路径使用。 */
function readAllConfigSafe(configPaths: ConfigPaths): Record<string, Record<string, unknown>> | undefined {
  try {
    return readAllConfig(configPaths);
  } catch {
    return undefined;
  }
}

/** 把一条命令的原文归一到可记录的事实文本（去斜杠命令自身、压空白、截断）。 */
function commandText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length > MAX_COMMAND_TEXT ? text.slice(0, MAX_COMMAND_TEXT).trim() : text;
}

/** 事实清单的短摘要：命令结果里最多列 20 条，再多只报数量。 */
function listLines(facts: readonly Fact[]): string[] {
  const shown = facts.slice(0, 20).map((f, index) => `${index + 1}. ${f.text}`);
  if (facts.length > shown.length) shown.push(`…还有 ${facts.length - shown.length} 条（在「桌宠记忆」面板里看）`);
  return shown;
}

/**
 * 注册预设的全部贡献。
 *
 * @param ctx - 预设这一行所在的 Cordis 上下文（agent 作用域）。
 */
export function apply(ctx: {
  systemPrompt: { section(section: unknown): unknown; getSectionOrder(name: string): number };
  commands: { register(definition: unknown): unknown };
  effect(setup: () => unknown, label: string): unknown;
  logger?: LoggerLike;
}): void {
  const { userRoot, configPaths } = presetPaths();
  const log: LoggerLike = ctx.logger ?? {};
  const facts = createChatFacts({ userRoot, log });

  // 人设段：同名覆盖部署人设。text 必须是同步函数——装配是同步的，异步只会拼出 [object Promise]。
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: PERSONA_SECTION,
        order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: () => sectionText(configPaths, facts),
      }),
    'dsh-pet: preset persona section',
  );

  /** 当前预设宠物的 id 与事实上限；命令与装配用同一套解析。 */
  const target = (): { petId: string; entry: string; max: number } | undefined => {
    const merged = readAllConfigSafe(configPaths) ?? {};
    const petId = pickPetId(merged);
    const found = findPresetPet(configPaths, petId);
    if (!found) return undefined;
    return { petId, entry: found.entry, max: numberField(found.conf, 'factsMax', DEFAULT_FACTS_MAX) };
  };

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'remember',
        description: '记住一件关于用户的事（长期记忆，跨会话保留）',
        input: { hint: '要记住的内容，例如：喜欢喝拿铁' },
        handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
          const text = commandText(invocation.rawInput);
          if (text === '') return { kind: 'error', text: '用法：/remember 要记住的内容' };
          const t = target();
          if (!t) return { kind: 'error', text: '找不到桌宠配置，无法写入记忆' };
          const added = await facts.add(t.entry, t.petId, [text], 'command', t.max);
          if (added.length === 0) return { kind: 'success', text: '这条我已经记着了，没有重复记。' };
          return { kind: 'success', text: '记住了：' + added[0].text };
        },
      }),
    'dsh-pet: preset command remember',
  );

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'memory',
        description: '列出桌宠记住的关于你的事',
        handler: async (): Promise<CommandResult> => {
          const t = target();
          if (!t) return { kind: 'error', text: '找不到桌宠配置' };
          const list = await facts.list(t.entry, t.petId);
          if (list.length === 0) return { kind: 'success', text: '我还没记住什么。用 /remember 告诉我一件事吧。' };
          return { kind: 'success', text: ['我记住的事：', ...listLines(list)].join('\n') };
        },
      }),
    'dsh-pet: preset command memory',
  );

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'forget',
        description: '忘掉一条记忆（按编号，编号见 /memory）',
        input: { hint: '编号，例如：2' },
        handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
          const raw = commandText(invocation.rawInput);
          const index = Number.parseInt(raw, 10);
          if (!Number.isInteger(index) || index < 1)
            return { kind: 'error', text: '用法：/forget 编号（编号见 /memory）' };
          const t = target();
          if (!t) return { kind: 'error', text: '找不到桌宠配置' };
          const list = await facts.list(t.entry, t.petId);
          const hit = list[index - 1];
          if (!hit) return { kind: 'error', text: `没有第 ${index} 条记忆，用 /memory 看看现有编号。` };
          const removed = await facts.drop(t.entry, t.petId, [hit.id]);
          if (removed === 0) return { kind: 'error', text: '删除没成功，再试一次？' };
          return { kind: 'success', text: '忘了：' + hit.text };
        },
      }),
    'dsh-pet: preset command forget',
  );
}
