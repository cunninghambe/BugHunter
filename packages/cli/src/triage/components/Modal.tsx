import React from 'react';
import { Box, Text } from 'ink';
import type { ModalKind } from '../state.js';

type VerdictModalProps = {
  onClose: () => void;
};

type SuppressModalProps = {
  patternDraft: string;
  reasonDraft: string;
  activeField: 'pattern' | 'reason' | null;
  onClose: () => void;
};

type HelpModalProps = {
  onClose: () => void;
};

type Props = {
  kind: ModalKind;
  verdictProps?: VerdictModalProps;
  suppressProps?: SuppressModalProps;
  helpProps?: HelpModalProps;
};

function VerdictModal({ onClose: _ }: VerdictModalProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" padding={1}>
      <Text bold>Mark verdict</Text>
      <Text>b — bug</Text>
      <Text>f — fix-priority</Text>
      <Text>p — false-positive</Text>
      <Text>k — known</Text>
      <Text dimColor>ESC — cancel</Text>
    </Box>
  );
}

function SuppressModal({ patternDraft, reasonDraft, activeField }: SuppressModalProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" padding={1}>
      <Text bold>Add suppression</Text>
      <Text>{`Pattern [${activeField === 'pattern' ? '*' : ' '}]: ${patternDraft}`}</Text>
      <Text>{`Reason  [${activeField === 'reason' ? '*' : ' '}]: ${reasonDraft}`}</Text>
      <Text dimColor>Tab — switch field · Enter — submit · ESC — cancel</Text>
    </Box>
  );
}

function HelpModal(_props: HelpModalProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" padding={1}>
      <Text bold>Keybindings</Text>
      <Text>j/k    — navigate down/up</Text>
      <Text>g/G    — first/last cluster</Text>
      <Text>m      — mark verdict</Text>
      <Text>s      — suppress cluster</Text>
      <Text>e      — explain cluster</Text>
      <Text>f      — dispatch fix</Text>
      <Text>?      — this help</Text>
      <Text>q      — quit</Text>
    </Box>
  );
}

export function Modal({ kind, verdictProps, suppressProps, helpProps }: Props): React.ReactElement | null {
  if (kind === 'verdict' && verdictProps !== undefined) return <VerdictModal {...verdictProps} />;
  if (kind === 'suppress' && suppressProps !== undefined) return <SuppressModal {...suppressProps} />;
  if (kind === 'help' && helpProps !== undefined) return <HelpModal {...helpProps} />;
  return null;
}
