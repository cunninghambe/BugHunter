/**
 * Intentional memory leak fixture for v0.8 heap-snapshot diffing tests.
 *
 * LeakingEventStore captures event objects in a closure-captured array.
 * Each addEvent() call adds a new TradeEvent object that is never freed.
 * This creates a growing class that the heap-snapshot differ should detect.
 */

class TradeEvent {
  constructor(id, data) {
    this.id = id;
    this.data = data;
    this.capturedAt = new Date();
    // Pad retained size: attach a buffer to make the retained delta noticeable.
    this.payload = new Array(1000).fill(id);
  }
}

class LeakingEventStore {
  constructor() {
    // Closure-captured array — never cleared.
    this._events = [];
  }

  addEvent(id) {
    this._events.push(new TradeEvent(id, { action: 'buy', symbol: 'AAPL', qty: id }));
    return this._events.length;
  }

  size() {
    return this._events.length;
  }
}

module.exports = { LeakingEventStore, TradeEvent };
