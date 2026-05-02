// Re-export all viewer-relevant types from the CLI package.
// Never redeclare — the viewer must compile-error if the on-disk shape changes.
export type {
  BugCluster,
  BugDetection,
  BugKind,
  ClusterVerdict,
  ConsoleError,
  NetworkRequest,
  Occurrence,
  OccurrenceFull,
  OccurrenceSummary,
  RunSummary,
  RunPhase,
  Severity,
  Action,
  PreState,
  PostState,
  StaticContext,
  XssContext,
  IdorContext,
  HeaderContext,
  AuthFlowContext,
  InjectionDetectionContext,
  RaceDetectionContext,
  PerfArtifacts,
  SuspectedFileLike,
} from '@bughunter/types';

// Re-export the suspectedFilePath helper so viewer code can normalise
// both legacy string entries and v0.46+ SuspectedFile objects uniformly.
export { suspectedFilePath } from '@bughunter/types';

// Derived types for inline shapes from BugDetection that have no standalone name.
import type { BugDetection } from '@bughunter/types';
export type SeoContext = NonNullable<BugDetection['seoContext']>;
export type HeapContext = NonNullable<BugDetection['heapContext']>;
