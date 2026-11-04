/**
 * 事实提炼：一轮面板对话结束后，问一次模型「这轮里有哪些关于用户、值得长期记住的事」。
 *
 * 只负责一次生成与解析，不落盘（落盘归 ./chat-facts）。
 * 始终成立：解析失败一律返回空数组——提炼是锦上添花，绝不能因为它让对话报错。
 * @module dsh-pet/src/host/plugin/fact-extract
 */
import { generateChat, type ChatMemoryMessage } from '../chat.ts';
import { configuredModel } from '../model-selection.ts';
import { normalizeFactText } from './chat-facts.ts';

/** 单轮最多提炼几条：太多会把闲聊噪声写进长期记忆。 */
export const MAX_FACTS_PER_ROUND = 3;

/** 提炼用的系统提示词：只认「关于用户、跨会话仍然成立」的事实。 */
const EXTRACT_SYSTEM = [
  '你是一个记忆整理助手。下面给你一段用户与桌面宠物之间的对话，请从中提炼「关于用户本人、跨会话仍然成立」的事实。',
  '只收：称呼 / 喜好与厌恶 / 习惯与作息 / 身份与工作 / 重要约定 / 明确说过的长期偏好。',
  '不收：一次性的情绪、当天的临时安排、宠物自己的话、寒暄、猜测、对话里没出现过的东西。',
  '每条不超过 40 字，用陈述句，主语用「用户」。',
  '严格只输出一个 JSON 字符串数组，例如 ["用户叫小林","用户喜欢喝冰美式"]；没有可记的就输出 []。不要输出任何解释。',
].join('\n');

/** 提炼输入。 */
export interface FactExtractInput {
  /** 宿主上下文（要 llm / agentDefaultModel）。 */
  readonly ctx: Parameters<typeof generateChat>[0]['ctx'];
  /** 该宠物的条目配置（取 chatModel 指定模型）。 */
  readonly conf: Record<string, unknown>;
  /** 本轮之前的历史（已截断，只给最近几轮，省 token）。 */
  readonly history: readonly ChatMemoryMessage[];
  /** 用户这轮说的话。 */
  readonly userText: string;
  /** 宠物这轮的回复正文。 */
  readonly replyText: string;
}

/** 从模型输出里抠出 JSON 数组；失败返回空数组。 */
export function parseFactArray(text: string): string[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const item of parsed) {
    const fact = normalizeFactText(item);
    if (fact !== '') out.push(fact);
  }
  return out.slice(0, MAX_FACTS_PER_ROUND);
}

/**
 * 让模型提炼本轮的事实。
 *
 * @param input - 上下文、条目配置、最近历史与本轮正文。
 * @returns 归一化后的事实文本数组（空数组 = 没有值得记的 / 提炼失败）。
 */
export async function extractFacts(input: FactExtractInput): Promise<string[]> {
  const { ctx, conf, history, userText, replyText } = input;
  if (userText.trim() === '') return [];
  const transcript = [
    ...history.map((m) => (m.role === 'user' ? '用户：' : '宠物：') + m.content),
    '用户：' + userText,
    '宠物：' + replyText,
  ].join('\n');
  const result = await generateChat({
    ctx,
    system: EXTRACT_SYSTEM,
    history: [],
    userText: transcript,
    preferred: configuredModel(conf, 'chatModel'),
  });
  if (!result.ok) return [];
  return parseFactArray(result.text);
}
