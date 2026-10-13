/**
 * 面板样式：一次性注入到文档，类名统一 `dss-` 前缀，避免污染宿主样式。
 */
const STYLE_ID = "dsh-session-state-styles";

const CSS = `
.dss-root { display: flex; flex-direction: column; gap: 12px; }
.dss-note { margin: 0; font-size: 12px; line-height: 1.6; opacity: .75; }
.dss-card { border: 1px solid rgba(127,127,127,.25); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.dss-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.dss-actions { justify-content: flex-start; }
.dss-switch { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.dss-title { font-size: 13px; font-weight: 600; }
.dss-hint { margin: 0; font-size: 12px; line-height: 1.5; opacity: .7; }
.dss-select, .dss-input, .dss-textarea { box-sizing: border-box; font: inherit; font-size: 12px; line-height: 1.5; padding: 6px 8px; border-radius: 8px; border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; }
.dss-textarea { width: 100%; resize: vertical; }
.dss-select:disabled, .dss-input:disabled, .dss-textarea:disabled { opacity: .6; }
.dss-state-list { display: flex; flex-direction: column; gap: 6px; }
.dss-state-row { display: grid; grid-template-columns: 72px 100px 110px 1fr auto; gap: 6px; align-items: center; }
@media (max-width: 640px) {
  .dss-state-row { grid-template-columns: 64px 1fr auto; }
}
.dss-btn, .dss-save, .dss-reset { font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 8px; border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit; cursor: pointer; }
.dss-btn:disabled, .dss-save:disabled, .dss-reset:disabled { opacity: .45; cursor: default; }
.dss-count { font-size: 11px; opacity: .55; margin-right: auto; }
.dss-ok { margin: 0; font-size: 12px; color: #2e9e5b; }
.dss-error { margin: 0; font-size: 12px; color: #d05252; }
`;

/** 注入样式（幂等）。 */
export function installStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID) !== null) return;
  const element = document.createElement("style");
  element.id = STYLE_ID;
  element.textContent = CSS;
  document.head.appendChild(element);
}
