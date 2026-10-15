/**
 * 封面占位渐变：按 id 生成稳定的渐变色（真实封面接入前使用）。
 * 明度压到 48%~58%，保证叠加白色占位文字时对比度 ≥ 3:1。
 */
export function coverGradient(id: number, angle = 135): string {
  const hues = [201, 262, 330, 20, 150, 42, 220, 280, 190, 95, 300, 350];
  const hue = hues[id % hues.length];
  return `linear-gradient(${angle}deg, hsl(${hue} 72% 48%), hsl(${(hue + 42) % 360} 74% 58%))`;
}
