# heap-leak fixture

Synthetic intentional memory leak for v0.8 heap-snapshot diffing tests.

The `leak.js` module exports a `LeakingEventStore` class that captures event callbacks
in a closure-captured array, preventing GC. Each `addEvent()` call grows the array.

Used by `tests/integration/heap-leak.test.ts` to verify that `memory_leak_attributed`
fires with the correct constructor name.
