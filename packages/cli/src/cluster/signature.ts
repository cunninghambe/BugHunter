// Cluster signature derivation per § 3.6.

import type { BugDetection, BugKind } from '../types.js';
import { normalizeErrorMessage, fingerprintStackTrace, shapeResponseBody } from './normalize.js';

export type ClusterKey = string;

export function clusterSignature(detection: BugDetection): ClusterKey {
  switch (detection.kind) {
    case 'console_error':
    case 'react_error':
    case 'unhandled_exception': {
      const msgNorm = normalizeErrorMessage(detection.rootCause);
      const stackFp = detection.stackTrace ? fingerprintStackTrace(detection.stackTrace) : '';
      return `${detection.kind}|${msgNorm}|${stackFp}`;
    }
    case 'network_5xx':
    case 'network_4xx_unexpected': {
      const bodyShape = detection.responseBodyShape ?? '';
      return `${detection.kind}|${detection.endpoint ?? ''}|${detection.status ?? ''}|${bodyShape}`;
    }
    case 'missing_state_change':
    case 'dom_error_text': {
      const actionKind = detection.triggeringAction?.kind ?? '';
      return `${detection.kind}|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}|${actionKind}`;
    }
    case '404_for_linked_route':
      return `${detection.kind}|${detection.targetPath ?? ''}`;
    case 'surface_call_failed':
      return `${detection.kind}|${detection.endpoint ?? ''}`;
    case 'accessibility_critical':
      return `${detection.kind}|${detection.pageRoute ?? ''}|${detection.selectorClass ?? ''}`;
  }
}

export function extractNormalizedFields(detection: BugDetection): {
  errorMessageNormalized?: string;
  stackTraceFingerprint?: string;
} {
  const isMessageBased = (k: BugKind) =>
    k === 'console_error' || k === 'react_error' || k === 'unhandled_exception';

  if (!isMessageBased(detection.kind)) return {};
  return {
    errorMessageNormalized: normalizeErrorMessage(detection.rootCause),
    stackTraceFingerprint: detection.stackTrace ? fingerprintStackTrace(detection.stackTrace) : undefined,
  };
}

export { shapeResponseBody };
