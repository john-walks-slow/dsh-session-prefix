/**
 * 面向模型 / UI 的文本整形。
 */
export function oneLine(value: string, max = 60): string {
  const flat = value.replace(/[\u0000-\u001F\u007F-\u009F]+/gu, " ").replace(/\s+/gu, " ").trim();
  const points = [...flat];
  return points.length <= max ? flat : `${points.slice(0, max - 1).join("")}…`;
}

export function quoted(value: string, max = 60): string {
  return JSON.stringify(oneLine(value, max));
}
