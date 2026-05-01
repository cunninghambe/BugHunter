import React from 'react';
import { Box, Text } from 'ink';
import type { BugCluster } from '../../types.js';

type Props = {
  cluster: BugCluster | undefined;
  explanation: string | undefined;
};

export function ClusterDetail({ cluster, explanation }: Props): React.ReactElement {
  if (cluster === undefined) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text dimColor>No cluster selected</Text>
      </Box>
    );
  }

  if (explanation !== undefined) {
    return (
      <Box flexDirection="column" flexGrow={1}>
        <Text bold>Explanation</Text>
        <Text>{explanation}</Text>
        <Text dimColor>r — return to detail</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold>Cluster detail</Text>
      <Text>{`ID: ${cluster.id}`}</Text>
      <Text>{`Kind: ${cluster.kind}`}</Text>
      <Text>{`Identity: ${cluster.signatureKey ?? '(none)'}`}</Text>
      <Text>{`Size: ${cluster.clusterSize} occurrences`}</Text>
      <Text bold>Suspected files:</Text>
      {cluster.suspectedFiles.length === 0
        ? <Text dimColor>  (none)</Text>
        : cluster.suspectedFiles.map(f => <Text key={f}>{`  ${f}`}</Text>)
      }
      <Text bold>Root cause:</Text>
      <Text>{`  ${cluster.rootCause}`}</Text>
    </Box>
  );
}
