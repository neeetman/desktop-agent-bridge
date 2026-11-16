import { apiError } from './contracts.mjs';

export function requireNewRecoveryKey(recovery, key) {
  if (!recovery) return;
  const callerKey = key?.replace(/^(?:mcp-create:[^:]+:[^:]+:|script-create:[^:]+:)/, '');
  if (!callerKey?.startsWith(recovery.newKeyPrefix) || callerKey.length === recovery.newKeyPrefix.length)
    throw Object.assign(apiError(409, `Historical request cannot be ruled out after ledger recovery. Only for confirmed new work, use a key starting with ${recovery.newKeyPrefix}`), {
      code: 'RECOVERY_KEY_REQUIRED', dispatchNotStarted: true,
    });
}
