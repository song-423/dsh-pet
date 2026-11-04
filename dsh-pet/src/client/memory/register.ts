/**
 * 把「桌宠记忆」注册成 DSH 右侧栏的第二种标签页（与「桌宠对话」并列）。
 *
 * 标签注册失败不影响对话标签与宠物本体：两个标签各自独立降级，
 * 缺 `sidebarRightTabs` 时这里只告警。
 * @module dsh-pet/src/client/memory/register
 */
import { makeMemoryPanel } from './panel.ts';
import type { ChatPanelRuntime } from '../chat/runtime.ts';
import { injectPanelCss } from '../chat/styles.ts';

/** 标签实现身份；同时也是正文插槽的 key。 */
const TAB_ID = 'dsh-pet-memory';
/** 标签类型；`openTab` 按它打开。 */
const TAB_KIND = 'pet-memory';
/** 标签头与指南页卡片的文案。 */
const TAB_TITLE = '桌宠记忆';

/** 右侧栏标签注册表的最小形状（只声明用到的成员）。 */
interface SidebarTabRegistry {
  register(definition: {
    readonly id: string;
    readonly kind: string;
    readonly priority: 'extension';
    readonly title: () => string;
    readonly guide: readonly {
      id: string;
      order: number;
      title: () => string;
      description?: () => string;
      icon?: () => unknown;
    }[];
  }): () => void;
}

/** 注册记忆标签需要的最小上下文。 */
export interface PetMemoryTabHost {
  get?(name: string): unknown;
  slots: {
    inject(name: string, generator: () => Generator<unknown, void, unknown>): void;
    register(registration: { name: string; key: string; order: number }, component: () => unknown): () => void;
  };
}

/**
 * 打开右侧栏的记忆标签。
 *
 * @param ctx - 客户端上下文（只用到软取）。
 */
export function openPetMemoryTab(ctx: PetMemoryTabHost): void {
  const controller = ctx.get?.('sidebarRight') as { openTab?(kind: string): void } | undefined;
  controller?.openTab?.(TAB_KIND);
}

/**
 * 注册记忆标签（标签类型 + 正文插槽 + 样式）。
 *
 * @param ctx - 客户端上下文。
 * @param rt - 注入的 react 能力。
 * @returns 注销函数；正文插槽随插件卸载。
 */
export function registerPetMemoryTab(ctx: PetMemoryTabHost, rt: ChatPanelRuntime): () => void {
  const tabs = ctx.get?.('sidebarRightTabs') as SidebarTabRegistry | undefined;
  if (tabs === undefined || typeof tabs.register !== 'function') {
    console.warn('[dsh-pet] 右侧栏不可用：没有 sidebarRightTabs 服务，桌宠记忆标签未注册');
    return () => {};
  }
  // 面板 CSS 与对话标签共用一份；谁先注册谁注入，重复注入是幂等的
  const disposeCss = injectPanelCss();
  const Panel = makeMemoryPanel(rt);

  const disposeType = tabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    priority: 'extension',
    title: () => TAB_TITLE,
    guide: [
      {
        id: TAB_KIND,
        order: 401,
        title: () => TAB_TITLE,
        description: () => '看它记住了你什么，也能手动增改删',
      },
    ],
  });
  ctx.slots.inject('sidebar.right.pane.tab', function* () {
    yield ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, order: 101 }, () => rt.h(Panel, {}));
  });
  return () => {
    disposeType();
    disposeCss();
  };
}
