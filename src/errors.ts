/**
 * 错误识别：按 `error.name` 识别宿主领域错误，避免 dual-package hazard。
 */
export function isNamedError(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
