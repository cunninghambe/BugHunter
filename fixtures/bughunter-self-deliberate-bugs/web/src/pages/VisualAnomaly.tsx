import React from 'react';

export default function VisualAnomaly(): React.ReactElement {
  return React.createElement('div', null,
    React.createElement('h1', null, 'Visual Anomaly Page'),
    // SELF-TEST: triggers visual_anomaly — overlapping elements and broken layout
    React.createElement('div', {
      style: {
        position: 'relative',
        height: '200px',
        border: '1px solid red',
        overflow: 'hidden',
      },
    },
      React.createElement('div', {
        style: { position: 'absolute', top: 0, left: 0, width: '100%', background: '#f00', color: '#fff', padding: '8px' },
      }, 'ERROR BANNER overlaps content'),
      React.createElement('div', {
        style: { position: 'absolute', top: 10, left: 0, width: '100%', background: '#fff' },
      }, 'Content hidden under banner — visual anomaly'),
    ),
    React.createElement('p', null, 'The banner above overlaps the content, creating a visual layout anomaly.'),
  );
}
