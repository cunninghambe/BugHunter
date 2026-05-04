// Edge: hardcoded string explicitly allowed via // i18n-allow comment — should NOT fire.
export const ALLOWED = (() => {
  // i18n-allow
  return 'This is intentionally hardcoded for tests';
})();
