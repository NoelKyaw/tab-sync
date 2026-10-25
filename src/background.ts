// Service worker. Event-driven only: Chrome shuts it down when idle, and the
// sync state it needs lives in chrome.storage.
import { startSync } from './sync/engine.ts';

startSync();
