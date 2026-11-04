/**
 * 悬停快捷键的判据：鼠标停在某只宠物上时，按 `L`（或配置指定的键）打开对话、按 `S` 截图。
 * 按键规则归 shared/hotkey，本模块只绑定「哪个键 + 菜单文案」。
 *
 * 对话键可配（`hotkeys.chat`，见 config.jsonc 注释）：默认仍是 L，配置只改按键、不改规则——
 * 仍然要求「裸键」（不带 Ctrl/Meta/Alt）且焦点不在输入框里。
 * @module dsh-pet/src/shared/chat/hotkey
 */
import { isBareKey } from '../hotkey.ts';
import type { HotkeyEvent } from '../hotkey.ts';

export { isTypingTarget } from '../hotkey.ts';
export type { HotkeyEvent } from '../hotkey.ts';

/** 对话键的缺省值（小写单字符，与 {@link isChatHotkey} 比较时统一转小写）。 */
export const DEFAULT_CHAT_HOTKEY = 'l';

/** 把配置里的按键归一成可比较的小写单字符；非法/缺失回落缺省。 */
export function normalizeChatHotkey(raw: unknown): string {
  return typeof raw === 'string' && /^[A-Za-z0-9]$/.test(raw) ? raw.toLowerCase() : DEFAULT_CHAT_HOTKEY;
}

/** 缺省对话键的显示文案（菜单项右侧灰字）。配置改了按键时用 {@link chatHotkeyHint}。 */
export const CHAT_HOTKEY_HINT = 'L 键';

/** 截图的显示文案；没有菜单项，只给设置页那张卡用。 */
export const CAPTURE_HOTKEY_HINT = 'S 键';

/**
 * 某个对话键的显示文案（配置里的键大写 + 「键」）。
 *
 * @param raw - 配置值（可能缺失或非法）。
 * @returns 例如 `T 键`；缺省时就是 L。
 */
export function chatHotkeyHint(raw: unknown): string {
  return normalizeChatHotkey(raw).toUpperCase() + ' 键';
}

/**
 * 这次按键该不该打开对话。
 *
 * @param e - 键盘事件。
 * @param hotkey - 配置的对话键（原始值；缺省/非法按 L）。
 * @returns 裸按该键（含大写）时为 true，输入框里打字则为 false。
 */
export function isChatHotkey(e: HotkeyEvent, hotkey: unknown = DEFAULT_CHAT_HOTKEY): boolean {
  return isBareKey(e, normalizeChatHotkey(hotkey));
}

/**
 * 这次按键该不该截图。
 *
 * @param e - 键盘事件。
 * @returns 裸按 `S`（含大写）时为 true，输入框里打字则为 false。
 */
export function isCaptureHotkey(e: HotkeyEvent): boolean {
  return isBareKey(e, 's');
}
