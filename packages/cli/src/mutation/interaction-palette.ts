// v0.38 interaction-palette planner — stub for type-safety until v0.38 ships.
// Returns no cases; the feature gate (config.interactionPalette?.enabled) prevents execution.

import type { BugHunterConfig, DiscoveredPage, TestCase } from '../types.js';

export function mintInteractionPaletteCases(
  _baseCases: TestCase[],
  _pages: DiscoveredPage[],
  _config: BugHunterConfig,
  _roles: string[],
): { cases: TestCase[]; skips: string[] } {
  return { cases: [], skips: [] };
}
