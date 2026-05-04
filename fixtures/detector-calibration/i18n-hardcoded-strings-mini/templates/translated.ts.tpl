// Negative: properly-translated strings using t() — should NOT fire.
import React from 'react';
import { useTranslation } from 'react-i18next';

export function TranslatedComponent() {
  const { t } = useTranslation();
  return (
    <div>
      <h1>{t('store.welcome')}</h1>
      <p>{t('store.browse_products')}</p>
      <button>{t('cart.add')}</button>
    </div>
  );
}

export const TRANSLATED_LABEL = useTranslation().t('order.summary');
