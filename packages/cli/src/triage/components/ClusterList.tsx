import React from 'react';
import { Box, Text } from 'ink';
import type { BugCluster } from '../../types.js';

type Props = {
  clusters: BugCluster[];
  selectedIdx: number;
};

export function ClusterList({ clusters, selectedIdx }: Props): React.ReactElement {
  return (
    <Box flexDirection="column" width={32}>
      <Text bold>{`Clusters (${clusters.length})`}</Text>
      {clusters.map((cluster, idx) => {
        const marker = idx === selectedIdx ? '>' : ' ';
        const label = `${idx + 1}. ${cluster.kind}`;
        return (
          <Text key={cluster.id} color={idx === selectedIdx ? 'cyan' : undefined}>
            {`${marker} ${label}`}
          </Text>
        );
      })}
      <Text dimColor>{'j/k navigate · m mark · s suppress · e explain · f fix · q quit'}</Text>
    </Box>
  );
}
