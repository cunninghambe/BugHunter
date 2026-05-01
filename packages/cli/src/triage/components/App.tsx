import React, { useReducer, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import type { BugCluster } from '../../types.js';
import { triageReducer, makeInitialState } from '../state.js';
import { ClusterList } from './ClusterList.js';
import { ClusterDetail } from './ClusterDetail.js';
import { Modal } from './Modal.js';
import type { AppCallbacks } from '../index.js';

type Props = {
  clusters: BugCluster[];
  actor: string;
  runId: string;
  callbacks: AppCallbacks;
};

export function App({ clusters, actor, runId, callbacks }: Props): React.ReactElement {
  const [state, dispatch] = useReducer(triageReducer, clusters, makeInitialState);

  const selectedCluster = state.clusters[state.selectedIdx];

  const handleKeyInput = useCallback((input: string, key: { escape?: boolean; tab?: boolean; return?: boolean }) => {
    if (state.modalKind === 'verdict') {
      if (key.escape) { dispatch({ type: 'CLOSE_MODAL' }); return; }
      const verdictMap: Record<string, string> = {
        b: 'bug', f: 'fix-priority', p: 'false-positive', k: 'known',
      };
      const mark = verdictMap[input];
      if (mark !== undefined && selectedCluster !== undefined) {
        callbacks.onVerdict(selectedCluster, mark as 'bug' | 'fix-priority' | 'false-positive' | 'known');
        dispatch({ type: 'CLOSE_MODAL' });
        dispatch({ type: 'SET_STATUS', message: `Marked ${mark}` });
      }
      return;
    }

    if (state.modalKind === 'suppress') {
      if (key.escape) { dispatch({ type: 'CLOSE_MODAL' }); return; }
      if (key.tab) {
        dispatch({ type: 'SET_INPUT_FIELD', field: state.inputField === 'pattern' ? 'reason' : 'pattern' });
        return;
      }
      if (key.return) {
        if (selectedCluster !== undefined && state.reasonDraft.trim() !== '') {
          callbacks.onSuppress(selectedCluster, state.patternDraft, state.reasonDraft, actor, runId)
            .then(suppressionId => {
              dispatch({ type: 'CLOSE_MODAL' });
              dispatch({ type: 'SET_STATUS', message: `Suppressed (${suppressionId})` });
            })
            .catch((err: unknown) => {
              dispatch({ type: 'CLOSE_MODAL' });
              dispatch({ type: 'SET_STATUS', message: `Suppress failed: ${String(err)}` });
            });
        }
        return;
      }
      if (input.length > 0) {
        if (state.inputField === 'pattern') dispatch({ type: 'SET_PATTERN_DRAFT', value: state.patternDraft + input });
        else dispatch({ type: 'SET_REASON_DRAFT', value: state.reasonDraft + input });
      }
      return;
    }

    if (state.modalKind === 'explain-loading') return;

    if (state.modalKind === 'explain-detail') {
      if (input === 'r') dispatch({ type: 'CLOSE_MODAL' });
      return;
    }

    if (state.modalKind === 'help') {
      dispatch({ type: 'CLOSE_MODAL' });
      return;
    }

    // Normal navigation
    if (input === 'q') { callbacks.onQuit(); return; }
    if (input === 'j') { dispatch({ type: 'SELECT_NEXT' }); return; }
    if (input === 'k') { dispatch({ type: 'SELECT_PREV' }); return; }
    if (input === 'g') { dispatch({ type: 'SELECT_FIRST' }); return; }
    if (input === 'G') { dispatch({ type: 'SELECT_LAST' }); return; }
    if (input === '?') { dispatch({ type: 'OPEN_HELP' }); return; }
    if (input === 'm') { dispatch({ type: 'OPEN_VERDICT_MODAL' }); return; }
    if (input === 's' && selectedCluster !== undefined) {
      const pattern = `bugIdentity:${selectedCluster.signatureKey ?? selectedCluster.id}`;
      dispatch({ type: 'OPEN_SUPPRESS_MODAL', patternDraft: pattern });
      return;
    }
    if (input === 'e' && selectedCluster !== undefined) {
      dispatch({ type: 'START_EXPLAIN_LOADING' });
      dispatch({ type: 'SET_STATUS', message: 'Explaining…' });
      const identity = selectedCluster.signatureKey ?? selectedCluster.id;
      callbacks.onExplain(selectedCluster)
        .then(({ markdown, cacheHit, cost }) => {
          dispatch({ type: 'SET_EXPLAIN_RESULT', bugIdentity: identity, markdown });
          dispatch({ type: 'SHOW_EXPLAIN_DETAIL' });
          dispatch({ type: 'SET_STATUS', message: cacheHit ? '(cached)' : `Cost: $${cost?.toFixed(4)}` });
          callbacks.onExplainEvent(selectedCluster, cacheHit, cost, actor, runId);
        })
        .catch((err: unknown) => {
          dispatch({ type: 'CLOSE_MODAL' });
          dispatch({ type: 'SET_STATUS', message: `Explain failed: ${String(err)}` });
        });
      return;
    }
    if (input === 'f' && selectedCluster !== undefined) {
      callbacks.onFixDispatched(selectedCluster, actor, runId);
      dispatch({ type: 'SET_STATUS', message: `Fix intent recorded. Run: claude -p '/bughunt fix ${runId} ${selectedCluster.id}'` });
      return;
    }
  }, [state, selectedCluster, callbacks, actor, runId]);

  useInput(handleKeyInput);

  const identity = selectedCluster?.signatureKey ?? selectedCluster?.id;
  const explanation = identity !== undefined ? state.explanationCache.get(identity) : undefined;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <ClusterList clusters={state.clusters} selectedIdx={state.selectedIdx} />
        <Text> </Text>
        <ClusterDetail
          cluster={selectedCluster}
          explanation={state.modalKind === 'explain-detail' ? explanation : undefined}
        />
      </Box>
      <Modal
        kind={state.modalKind}
        verdictProps={state.modalKind === 'verdict' ? { onClose: () => dispatch({ type: 'CLOSE_MODAL' }) } : undefined}
        suppressProps={state.modalKind === 'suppress' ? {
          patternDraft: state.patternDraft,
          reasonDraft: state.reasonDraft,
          activeField: state.inputField,
          onClose: () => dispatch({ type: 'CLOSE_MODAL' }),
        } : undefined}
        helpProps={state.modalKind === 'help' ? { onClose: () => dispatch({ type: 'CLOSE_MODAL' }) } : undefined}
      />
      {state.status !== '' && <Text dimColor>{state.status}</Text>}
    </Box>
  );
}
