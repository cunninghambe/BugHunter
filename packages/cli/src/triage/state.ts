import type { BugCluster } from '../types.js';

export type ModalKind = 'none' | 'verdict' | 'suppress' | 'explain-loading' | 'explain-detail' | 'help';

export type TriageState = {
  clusters: BugCluster[];
  selectedIdx: number;
  modalKind: ModalKind;
  inputField: 'pattern' | 'reason' | null;
  patternDraft: string;
  reasonDraft: string;
  explanationCache: Map<string, string>;
  status: string;
};

export type TriageAction =
  | { type: 'SELECT_NEXT' }
  | { type: 'SELECT_PREV' }
  | { type: 'SELECT_FIRST' }
  | { type: 'SELECT_LAST' }
  | { type: 'OPEN_VERDICT_MODAL' }
  | { type: 'OPEN_SUPPRESS_MODAL'; patternDraft: string }
  | { type: 'OPEN_HELP' }
  | { type: 'CLOSE_MODAL' }
  | { type: 'SET_STATUS'; message: string }
  | { type: 'SET_INPUT_FIELD'; field: 'pattern' | 'reason' }
  | { type: 'SET_PATTERN_DRAFT'; value: string }
  | { type: 'SET_REASON_DRAFT'; value: string }
  | { type: 'START_EXPLAIN_LOADING' }
  | { type: 'SET_EXPLAIN_RESULT'; bugIdentity: string; markdown: string }
  | { type: 'SHOW_EXPLAIN_DETAIL' };

export function makeInitialState(clusters: BugCluster[]): TriageState {
  return {
    clusters,
    selectedIdx: 0,
    modalKind: 'none',
    inputField: null,
    patternDraft: '',
    reasonDraft: '',
    explanationCache: new Map(),
    status: '',
  };
}

export function triageReducer(state: TriageState, action: TriageAction): TriageState {
  switch (action.type) {
    case 'SELECT_NEXT':
      return {
        ...state,
        selectedIdx: state.clusters.length === 0
          ? 0
          : (state.selectedIdx + 1) % state.clusters.length,
      };

    case 'SELECT_PREV':
      return {
        ...state,
        selectedIdx: state.clusters.length === 0
          ? 0
          : (state.selectedIdx - 1 + state.clusters.length) % state.clusters.length,
      };

    case 'SELECT_FIRST':
      return { ...state, selectedIdx: 0 };

    case 'SELECT_LAST':
      return {
        ...state,
        selectedIdx: Math.max(0, state.clusters.length - 1),
      };

    case 'OPEN_VERDICT_MODAL':
      return { ...state, modalKind: 'verdict' };

    case 'OPEN_SUPPRESS_MODAL':
      return {
        ...state,
        modalKind: 'suppress',
        patternDraft: action.patternDraft,
        reasonDraft: '',
        inputField: 'pattern',
      };

    case 'OPEN_HELP':
      return { ...state, modalKind: 'help' };

    case 'CLOSE_MODAL':
      return { ...state, modalKind: 'none', inputField: null };

    case 'SET_STATUS':
      return { ...state, status: action.message };

    case 'SET_INPUT_FIELD':
      return { ...state, inputField: action.field };

    case 'SET_PATTERN_DRAFT':
      return { ...state, patternDraft: action.value };

    case 'SET_REASON_DRAFT':
      return { ...state, reasonDraft: action.value };

    case 'START_EXPLAIN_LOADING':
      return { ...state, modalKind: 'explain-loading' };

    case 'SET_EXPLAIN_RESULT': {
      const newCache = new Map(state.explanationCache);
      newCache.set(action.bugIdentity, action.markdown);
      return { ...state, explanationCache: newCache };
    }

    case 'SHOW_EXPLAIN_DETAIL':
      return { ...state, modalKind: 'explain-detail' };

    default:
      return state;
  }
}
