/**
 * 宿主服务取用：一律使用 `ctx.get(name, false)` 懒取，缺失时明确报错。
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-title";

/** 会话存储（`ctx.sessions`）：仅用于查询当前进程内的 live 会话。 */
export function requireSessions(ctx: Context) {
  const sessions = ctx.get("sessions", false);
  if (sessions === undefined) {
    throw new Error("this dsh deployment mounts no session store, so session state cannot be managed");
  }
  return sessions;
}

/** 会话标题服务（`ctx.sessionTitle`）：读写 `session/title` 的官方入口。 */
export function requireSessionTitles(ctx: Context) {
  const titles = ctx.get("sessionTitle", false);
  if (titles === undefined) {
    throw new Error("this dsh deployment mounts no session-title service, so session state cannot be updated");
  }
  return titles;
}
