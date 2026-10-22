import { registerRunner, CLIENT_STATUS, makeRunResult } from './contract.mjs';

function stub(id, requirements) {
  return registerRunner({
    id,
    capabilities: { hermetic: false, skillTrace: false, usageObservable: false, hardLimits: false, implemented: false },
    requirements,
    async preflight() {
      return { ok: false, problems: [`${id} adapter not implemented`, ...requirements] };
    },
    plannedSessions: () => 0,
    prepare() {
      throw new Error(`${id} adapter not implemented`);
    },
    parseTrace() {
      throw new Error(`${id} adapter not implemented`);
    },
    async run() {
      return makeRunResult({ client: id, status: CLIENT_STATUS.NOT_IMPLEMENTED, caveats: requirements });
    },
  });
}

export function registerStubs() {
  stub('opencode', [
    'no official eval tool; needs driver around `opencode run --format json`',
    'config isolation via OPENCODE_CONFIG_DIR (unverified)',
  ]);
}
