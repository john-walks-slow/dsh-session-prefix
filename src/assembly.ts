/**
 * 按当前设置装配工具表：
 * - `enabled: false` 时不注册 `session_state`（模型不可见）；
 * - 状态预设列表、默认状态、自定义前缀开关或自定义指令发生任何变化时，在 `turn/start` 重新注册工具，
 *   让最新的状态清单与指令在下一个回合立即生效。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { SettingsConfig, SettingsSnapshot } from "./config.js";
import type { StateTracker } from "./state.js";
import { stateToolDefinition } from "./tools.js";

export interface Registration {
  readonly name: string;
  readonly signature: string;
  readonly dispose: () => void;
}

/**
 * 把宿主工具表对齐到当前设置快照。
 */
export function syncTools(
  ctx: Context,
  tracker: StateTracker,
  settings: SettingsSnapshot,
  registered: Registration[],
  config?: SettingsConfig,
): string[] {
  if (!settings.enabled) {
    disposeTools(registered);
    return [];
  }

  const definition = stateToolDefinition(ctx, tracker, settings, config);
  const signature = JSON.stringify({
    description: definition.description,
    allowCustomPrefix: settings.allowCustomPrefix,
    defaultState: settings.defaultState,
    states: settings.states,
  });

  if (
    registered.length === 1 &&
    registered[0]?.name === definition.name &&
    registered[0]?.signature === signature
  ) {
    return [definition.name];
  }

  disposeTools(registered);
  registered.push({
    name: definition.name,
    signature,
    dispose: ctx.tools.register(definition),
  });
  return [definition.name];
}

/** 注销本插件注册的全部工具。 */
export function disposeTools(registered: Registration[]): void {
  for (const entry of registered) entry.dispose();
  registered.length = 0;
}
