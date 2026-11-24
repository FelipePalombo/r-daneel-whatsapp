import type { WAMessage } from '@whiskeysockets/baileys';
import { authorizationStatus } from './request.js';

/** Um teste experimental sempre exige destinatário autorizado e configurado. */
export function soundEnabledFor(message: WAMessage, enabled: boolean, rawPhone?: string): boolean {
  const phone = rawPhone?.replace(/\D/g, '');
  return enabled && !!phone && !authorizationStatus(message, phone);
}
