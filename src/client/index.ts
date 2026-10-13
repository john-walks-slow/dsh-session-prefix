/**
 * 客户端半边：把「会话状态」设置页挂进 Web 设置外壳的 `settings.section` 槽位。
 *
 * - `configForms.get(ENTRY_ID)` 绑定的是当前 profile entry id（`session-state`）；
 * - `whileServed` 保证只有该 entry 真正被组合进 profile 时才挂载设置页；
 * - `slots.inject` 等待外壳声明槽位后再注册。
 */
import * as React from "react";
import { SessionStatePanel, type SessionStateScope } from "./settings-panel.js";

/** 本插件在 cordis.patch.yml 里的 entry id。 */
const ENTRY_ID = "session-state";

interface SlotEntry {
  name: string;
  id: string;
  order: number;
  label: () => string;
  inject?: () => Record<string, unknown>;
}

interface ClientCtx {
  effect(dispose: () => () => void): () => void;
  slots: {
    inject(id: string, factory: () => () => void): () => void;
    register<T extends SlotEntry>(entry: T, component: React.ComponentType<Record<string, unknown>>): () => void;
  };
  configForms: {
    get(namespace: string): SessionStateScope;
    whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void;
  };
}

export const inject = ["slots", "configForms"];

export function apply(ctx: ClientCtx): void {
  const form = ctx.configForms.get(ENTRY_ID);
  ctx.effect(() =>
    ctx.configForms.whileServed([ENTRY_ID], () =>
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "session-state",
            order: 129,
            label: () => "会话状态",
            inject: () => ({ scope: form }),
          },
          SessionStatePanel as unknown as React.ComponentType<Record<string, unknown>>,
        ),
      ),
    ),
  );
}
