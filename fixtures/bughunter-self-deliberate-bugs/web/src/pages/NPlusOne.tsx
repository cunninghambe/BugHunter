import React, { useEffect, useState } from 'react';

const ITEM_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

type Item = { id: number; name: string };

export default function NPlusOne(): React.ReactElement {
  const [items, setItems] = useState<Item[]>([]);

  // SELF-TEST: triggers n_plus_one_api_calls — 12 individual fetches, one per item
  useEffect(() => {
    ITEM_IDS.forEach(id => {
      fetch(`/api/item/${id}`)
        .then(r => r.json())
        .then((data: Item) => setItems(prev => [...prev, data]))
        .catch(() => undefined);
    });
  }, []);

  return React.createElement('div', null,
    React.createElement('h1', null, 'N+1 API Calls Page'),
    React.createElement('p', null, `Fetching ${ITEM_IDS.length} items individually instead of batching.`),
    React.createElement('ul', null,
      items.map(item => React.createElement('li', { key: item.id }, item.name)),
    ),
  );
}
