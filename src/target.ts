/**
 * 调用者身份解析：默认作用于调用它的那个会话。
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";

/** 调用本工具的 agent 自己的会话 id。 */
export function callerSessionId(exec: ToolRunContext): string {
  const id = (exec.agent as Agent | undefined)?.session?.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("this call has no calling session");
  return id;
}

/**
 * 解析工具的目标会话：省略（`undefined`/`null`）即调用者自己；显式给空串报错，防止静默误改当前会话。
 */
export function targetSessionId(raw: unknown, exec: ToolRunContext): string {
  if (raw === undefined || raw === null) return callerSessionId(exec);
  if (typeof raw !== "string") throw new Error("session_id must be a string");
  const id = raw.trim();
  if (id.length === 0) throw new Error("session_id must be a non-empty string (omit it to act on your own session)");
  return id;
}
