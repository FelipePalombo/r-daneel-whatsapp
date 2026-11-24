import type { WAMessage } from '@whiskeysockets/baileys';
import { authorizationStatus } from './request.js';

/** O som segue a mesma lista de autorização das demais funções do bot. */
export function soundEnabledFor(message: WAMessage, enabled: boolean, allowed: readonly string[]): boolean {
  return enabled && !authorizationStatus(message, allowed);
}
