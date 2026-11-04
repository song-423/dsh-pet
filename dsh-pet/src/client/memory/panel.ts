/**
 * 右侧栏「桌宠记忆」标签页：事实记忆的查看、增改删，以及对话历史的入口说明。
 *
 * 与「桌宠对话」面板分两个标签：对话是流水（每天几十条），记忆是沉淀（几条、长期有效），
 * 混在一页里改一条事实要滚过几十条聊天记录。
 * 样式复用 ../chat/panel-css 的那套类名（面板 CSS 只注入一次，两个标签共用）。
 * @module dsh-pet/src/client/memory/panel
 */
import { fetchChatConfig } from '../chat/api.ts';
import type { ChatPanelRuntime } from '../chat/runtime.ts';
import { addFact, dropFacts, fetchFacts, updateFact, type FactView } from './api.ts';
import type { Pet } from '../../shared/types.ts';

/** 判定返回是不是失败（`FactsError` 带 `ok:false`，成功体没有这个字段）。 */
function failureOf(result: unknown): string | undefined {
  const r = result as { ok?: boolean; message?: string } | null;
  return r !== null && r !== undefined && r.ok === false ? (r.message ?? '失败') : undefined;
}

/** 一条事实的正文摘要：太长的截断显示，编辑时才给全文。 */
function previewOf(text: string): string {
  return text.length > 120 ? text.slice(0, 120) + '…' : text;
}

/**
 * 造记忆面板组件。
 *
 * @param rt - 注入的 react 能力（与对话面板同一套契约）。
 * @returns 无参组件。
 */
export function makeMemoryPanel(rt: ChatPanelRuntime): () => unknown {
  const { h, useState, useEffect } = rt;

  return function PetMemoryPanel(): unknown {
    // 宠物清单：与对话面板同一份 /config，不额外定义「哪些宠物有记忆」
    const [pets, setPets] = useState<Pet[]>([]);
    const [petId, setPetId] = useState('');
    const [facts, setFacts] = useState<FactView[]>([]);
    const [max, setMax] = useState(60);
    const [draft, setDraft] = useState('');
    const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [loaded, setLoaded] = useState(false);

    // 首次加载：先拿宠物清单，选第一只
    useEffect(() => {
      let alive = true;
      void (async () => {
        try {
          const cfg = await fetchChatConfig();
          if (!alive) return;
          setPets(cfg.pets);
          const first = cfg.pets[0];
          if (first !== undefined) setPetId(first.id);
          else setLoaded(true);
        } catch (e) {
          if (alive) {
            setError('读配置失败：' + (e instanceof Error ? e.message : String(e)));
            setLoaded(true);
          }
        }
      })();
      return () => {
        alive = false;
      };
    }, []);

    // 切换宠物或首次选定后读它的事实清单
    useEffect(() => {
      if (petId === '') return;
      let alive = true;
      const ac = new AbortController();
      void (async () => {
        const result = await fetchFacts(petId, ac.signal);
        if (!alive) return;
        const failed = failureOf(result);
        if (failed !== undefined) {
          setError(failed);
        } else {
          const snap = result as { facts: FactView[]; max: number };
          setFacts(snap.facts);
          setMax(snap.max);
          setError('');
        }
        setLoaded(true);
      })();
      return () => {
        alive = false;
        ac.abort();
      };
    }, [petId]);

    /** 所有写操作共用的外壳：busy + 错误 + 结果落地。 */
    const run = async (action: () => Promise<unknown>): Promise<void> => {
      setBusy(true);
      setError('');
      try {
        const result = await action();
        const failed = failureOf(result);
        if (failed !== undefined) {
          setError(failed);
          return;
        }
        const snap = result as { facts: FactView[]; max: number };
        setFacts(snap.facts);
        setMax(snap.max);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };

    const submitDraft = (): void => {
      const text = draft.trim();
      if (text === '' || petId === '' || busy) return;
      void run(async () => {
        const result = await addFact(petId, text);
        if (failureOf(result) === undefined) setDraft('');
        return result;
      });
    };

    const submitEdit = (): void => {
      const current = editing;
      if (current === null || petId === '') return;
      const text = current.text.trim();
      if (text === '' || busy) return;
      void run(async () => {
        const result = await updateFact(petId, current.id, text);
        if (failureOf(result) === undefined) setEditing(null);
        return result;
      });
    };

    const removeOne = (id: string): void => {
      if (petId === '' || busy) return;
      void run(() => dropFacts(petId, [id]));
    };

    const clearAll = (): void => {
      if (petId === '' || busy) return;
      void run(() => dropFacts(petId, []));
    };

    /** 宠物切换按钮条。 */
    const tabsNode = h('div', {
      className: 'pet-chat-tabs',
      children: pets.map((pet) =>
        h('button', {
          key: pet.id,
          type: 'button',
          className: 'pet-chat-tab',
          'aria-pressed': pet.id === petId ? 'true' : 'false',
          title: pet.name,
          onClick: () => setPetId(pet.id),
          children: pet.name,
        }),
      ),
    });

    /** 一条事实：正文 + 改 + 删。 */
    const factRow = (fact: FactView): unknown => {
      const isEditing = editing !== null && editing.id === fact.id;
      return h('div', {
        key: fact.id,
        className: 'pet-chat-round',
        style: { display: 'block', padding: '8px 10px' },
        children: [
          isEditing
            ? h('input', {
                key: 'edit',
                className: 'pet-chat-input',
                value: editing.text,
                onInput: (e: { target: { value: string } }) => setEditing({ id: fact.id, text: e.target.value }),
                onKeyDown: (e: { key: string }) => {
                  if (e.key === 'Enter') submitEdit();
                  if (e.key === 'Escape') setEditing(null);
                },
              })
            : h('div', { key: 'text', className: 'pet-chat-text', children: previewOf(fact.text) }),
          h('div', {
            key: 'ops',
            style: { display: 'flex', gap: '8px', marginTop: '6px', alignItems: 'center' },
            children: [
              h('span', {
                key: 'src',
                className: 'pet-chat-hint',
                children: fact.source === 'auto' ? '自动提炼' : '手动添加',
              }),
              h('span', {
                key: 'spacer',
                style: { flex: '1' },
              }),
              isEditing
                ? h('button', {
                    key: 'ok',
                    type: 'button',
                    className: 'pet-chat-tool',
                    onClick: submitEdit,
                    children: '保存',
                  })
                : h('button', {
                    key: 'edit',
                    type: 'button',
                    className: 'pet-chat-tool',
                    onClick: () => setEditing({ id: fact.id, text: fact.text }),
                    children: '改',
                  }),
              isEditing
                ? h('button', {
                    key: 'cancel',
                    type: 'button',
                    className: 'pet-chat-tool',
                    onClick: () => setEditing(null),
                    children: '取消',
                  })
                : h('button', {
                    key: 'del',
                    type: 'button',
                    className: 'pet-chat-tool',
                    onClick: () => removeOne(fact.id),
                    children: '删',
                  }),
            ],
          }),
        ],
      });
    };

    const body = ((): unknown[] => {
      if (!loaded) return [h('p', { key: 'loading', className: 'pet-chat-hint', children: '读取中…' })];
      if (pets.length === 0) {
        return [h('p', { key: 'nopet', className: 'pet-chat-hint', children: '还没有桌宠。先在设置页添加一只。' })];
      }
      return [
        tabsNode,
        h('p', {
          key: 'count',
          className: 'pet-chat-hint',
          children: `记住 ${facts.length} 条（上限 ${max} 条）；每次对话最常用的 25 条会一起交给模型。`,
        }),
        h('div', {
          key: 'composer',
          className: 'pet-chat-composer',
          children: [
            h('input', {
              key: 'input',
              className: 'pet-chat-input',
              value: draft,
              placeholder: '手动记一条：例如「主人喜欢喝拿铁」',
              disabled: busy,
              onInput: (e: { target: { value: string } }) => setDraft(e.target.value),
              onKeyDown: (e: { key: string }) => {
                if (e.key === 'Enter') submitDraft();
              },
            }),
            h('button', {
              key: 'send',
              type: 'button',
              className: 'pet-chat-send',
              disabled: busy || draft.trim() === '',
              onClick: submitDraft,
              children: '记住',
            }),
          ],
        }),
        error !== ''
          ? h('p', { key: 'err', className: 'pet-chat-error', style: { color: '#d05050' }, children: error })
          : null,
        h('div', {
          key: 'list',
          className: 'pet-chat-list',
          children:
            facts.length === 0
              ? [
                  h('p', {
                    key: 'empty',
                    className: 'pet-chat-hint',
                    children: '还没有记住的事。多聊几次会自动提炼，也可以在上面手动加一条。',
                  }),
                ]
              : facts.map(factRow),
        }),
        h('div', {
          key: 'footer',
          style: { display: 'flex', gap: '8px', marginTop: '8px' },
          children: [
            h('button', {
              key: 'clear',
              type: 'button',
              className: 'pet-chat-tool',
              disabled: busy || facts.length === 0,
              onClick: clearAll,
              children: '清空全部事实',
            }),
            h('span', {
              key: 'hint',
              className: 'pet-chat-hint',
              style: { flex: '1' },
              children: '对话原文在「桌宠对话」标签里，可按轮删除。',
            }),
          ],
        }),
      ];
    })();

    return h('div', { className: 'pet-chat', children: body });
  };
}
