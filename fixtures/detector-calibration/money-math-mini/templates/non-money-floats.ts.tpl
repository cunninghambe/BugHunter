// Negative: float math on non-money values (animation timing, percentages of UI) — silent.
export function fadeOpacity(currentOpacity: number, fadeRate: number): number {
  return currentOpacity * (1 - fadeRate);
}

export function progressPercentage(elapsed: number, total: number): number {
  return (elapsed / total) * 100;
}
