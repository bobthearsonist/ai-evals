import { rmSync } from 'node:fs';

const retryable = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function removeTemporaryDirectory(path, { remove = rmSync, sleep = sleepSync } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return remove(path, { recursive: true, force: true });
    } catch (error) {
      if (!retryable.has(error.code) || attempt >= 9) throw error;
      sleep(attempt * 200);
    }
  }
}
