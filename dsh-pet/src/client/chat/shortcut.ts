/**
 * 「打开右侧栏桌宠对话」的快捷键。
 *
 * 注册后自动出现在 设置 → 通用 → 快捷键（可改绑、有冲突提示），
 * 侧栏 guide 卡片通过 `commandId` 显示键帽。服务缺失（旧宿主）只告警，不影响面板本身。
 * @module dsh-pet/src/client/chat/shortcut
 */
import { keycapOf, readShortcutKeycap, registerAppShortcut, type ShortcutHost } from '../app-shortcut.ts';

/** 命令 id：guide 卡片的 `commandId` 与注册都用它。 */
export const PET_CHAT_COMMAND_ID = 'pet-chat.open';

/**
 * 桌面端的默认键位：主修饰键 + L（Windows/Linux 上是 Ctrl+L，macOS 是 Cmd+L）。
 *
 * 选单个字母是为了「不用先把鼠标放到桌宠身上」——桌宠卡片上的悬停键只在指针落上去时生效，
 * 而这条是应用级命令，焦点在 DSH 任何位置都能按。
 */
export const DESKTOP_BINDING = { code: 'KeyL', modifiers: ['primary'] } as const;

/**
 * Web 端的默认键位：主修饰键 + Shift + P。
 *
 * 网页里 Ctrl+L 是浏览器地址栏的保留组合，DSH 的 Web 白名单只放行
 * 「主键 + Shift/Alt + 字母」，写成 Ctrl+L 会让 `register` 直接抛
 * `Unsupported Web shortcut`，连桌面端的这条命令一起没掉。
 */
export const WEB_BINDING = { code: 'KeyP', modifiers: ['primary', 'shift'] } as const;

/** 逐档默认键位：桌面三档用 Ctrl+L，Web 两档留在白名单里。 */
const PROFILES = {
  'desktop:macos': DESKTOP_BINDING,
  'desktop:windows': DESKTOP_BINDING,
  'desktop:linux': DESKTOP_BINDING,
  'web:macos': WEB_BINDING,
  'web:windows': WEB_BINDING,
} as const;

/**
 * 设置页显示的键帽：跟着用户改绑走。
 *
 * @param ctx - 客户端上下文。
 * @returns 键帽文案；还没登记、或宿主没有快捷键服务时退回桌面默认组合。
 */
export function petChatShortcutKeycap(ctx: ShortcutHost): string {
  return readShortcutKeycap(ctx, PET_CHAT_COMMAND_ID) ?? keycapOf(DESKTOP_BINDING);
}

/**
 * 注册「打开桌宠对话」。
 *
 * @param ctx - 客户端上下文（只用到软取）。
 * @param label - 设置页里显示的标题；惰性求值，切语言后重算。
 * @param open - 触发时执行的动作（打开对话标签）。
 * @returns `registered` 表示命令是否真的登记成功；`dispose` 用于注销（失败时是空函数）。
 *   失败时调用方不能再把 `commandId` 交给侧栏——指向不存在的命令会让侧栏注册抛错。
 */
export function registerPetChatShortcut(
  ctx: ShortcutHost,
  label: () => string,
  open: () => void,
): { registered: boolean; dispose: () => void } {
  return registerAppShortcut(ctx, {
    id: PET_CHAT_COMMAND_ID,
    label,
    binding: DESKTOP_BINDING,
    profiles: PROFILES,
    run: open,
  });
}
