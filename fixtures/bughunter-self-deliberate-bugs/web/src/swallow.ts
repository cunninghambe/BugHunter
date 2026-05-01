// SELF-TEST: triggers swallowed_error_empty_catch

function riskyOp(): void {
  throw new Error('risky operation failed');
}

// SELF-TEST: triggers swallowed_error_empty_catch — empty catch block silently swallows the error
export function runRisky(): void {
  try {
    riskyOp();
  } catch (e) {}
}
