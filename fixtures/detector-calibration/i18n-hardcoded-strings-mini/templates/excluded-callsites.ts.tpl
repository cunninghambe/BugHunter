// Negative edge: short strings, console logs, imports, aria-/data- attrs — all excluded.
console.log('debug message that should not fire');
import { something } from './other-module';

export const SHORT = 'ab'; // below minStringLength
export const SINGLE_WORD = 'single'; // requireWhitespace excludes this

const NumericStart = '42 banana';  // doesn't start with letter, excluded
