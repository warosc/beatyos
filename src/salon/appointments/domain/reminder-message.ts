import type { ReminderContext } from './agenda.ports';

/**
 * Redacción del recordatorio y normalización del teléfono.
 *
 * Funciones puras: el mismo texto sale por WhatsApp automático, por el botón manual de
 * recepción y en el registro de desarrollo, y tiene que ser idéntico en los tres.
 */

/**
 * Teléfono en formato internacional (`+50255551234`), o `null` si no parece un número.
 *
 * Los salones guardan los teléfonos como los dicta la clienta: «5555-1234», «(502) 5555
 * 1234», «+34 600 111 222». WhatsApp exige el internacional sin adornos. Un número sin
 * prefijo de país se completa con el del salón, porque es lo que significa en la práctica:
 * nadie apunta el +502 de una clienta de la misma ciudad.
 */
export function toInternationalPhone(
  raw: string | null | undefined,
  defaultCountryCode: string,
): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  let international: string;
  if (trimmed.startsWith('+')) international = digits;
  else if (digits.startsWith('00')) international = digits.slice(2);
  else if (digits.length <= 8) international = `${defaultCountryCode.replace(/\D/g, '')}${digits}`;
  else international = digits;

  // E.164 admite hasta 15 cifras; por debajo de 8 no hay número real con prefijo de país.
  if (international.length < 8 || international.length > 15) return null;
  return `+${international}`;
}

/** Enlace `wa.me` con el mensaje ya escrito, para enviarlo desde el teléfono del salón. */
export function whatsappLink(phone: string, message: string): string {
  return `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`;
}

export function composeReminderMessage(
  context: ReminderContext,
  confirmationUrl: string,
  timeZone: string,
): string {
  const when = new Intl.DateTimeFormat('es-GT', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(context.startsAt);
  const hour = new Intl.DateTimeFormat('es-GT', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(context.startsAt);
  const services = context.serviceNames.length ? ` (${context.serviceNames.join(', ')})` : '';

  return (
    `Hola ${context.clientFirstName}, te recordamos tu cita en ${context.salonName} ` +
    `el ${when} a las ${hour} con ${context.stylistName}${services}.\n\n` +
    `Confirma o cancela aquí: ${confirmationUrl}\n\n` +
    '¡Te esperamos!'
  );
}
