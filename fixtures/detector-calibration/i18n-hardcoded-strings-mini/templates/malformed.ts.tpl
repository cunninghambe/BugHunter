// Input degradation: malformed TypeScript with hardcoded strings — scanner should
// still flag the strings without crashing on the broken syntax.
export const TITLE = 'Welcome to broken syntax page';

function broken( {
  return 'Body content visible to user';
// missing close brace, missing semicolon, scanner should still emit
