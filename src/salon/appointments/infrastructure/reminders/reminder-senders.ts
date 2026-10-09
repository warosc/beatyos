import { Logger } from '@nestjs/common';

import type {
  OutboundReminder,
  ReminderChannelValue,
  ReminderSender,
} from '../../domain/agenda.ports';

/**
 * Canal de desarrollo: escribe el recordatorio en el registro y no lo envía.
 *
 * Igual que el correo (ver `LoggingEmailSender`), elegir proveedor de mensajería es una
 * decisión de despliegue con coste por mensaje detrás. Mientras no se tome, este canal
 * deja recorrer el circuito completo —incluido el enlace de confirmación, que sale en el
 * registro y se puede abrir— y recepción sigue teniendo el botón de WhatsApp manual.
 */
export class LoggingReminderSender implements ReminderSender {
  readonly channel: ReminderChannelValue = 'LOG';
  private readonly logger = new Logger('Recordatorios');

  send(reminder: OutboundReminder): Promise<{ providerId: string | null }> {
    // Ni el teléfono ni el texto: el mensaje lleva un enlace vivo que confirma o cancela la
    // cita, y el registro de Docker no es sitio para eso.
    this.logger.log(`Recordatorio simulado (sin proveedor): ${reminder.body.length} caracteres`);
    return Promise.resolve({ providerId: null });
  }
}

export interface TwilioCredentials {
  readonly accountSid: string;
  readonly authToken: string;
  /** Remitente: `whatsapp:+14155238886` para WhatsApp, o un número para SMS. */
  readonly from: string;
}

/**
 * Twilio, por WhatsApp o por SMS.
 *
 * Se habla con su API REST directamente en lugar de con su SDK: es una sola llamada, y el
 * SDK son varios megas de dependencias para hacerla. WhatsApp exige además una plantilla
 * aprobada por Meta para escribir a quien no ha escrito antes al salón; el texto de
 * `composeReminderMessage` es el que hay que registrar como plantilla.
 */
export class TwilioReminderSender implements ReminderSender {
  constructor(
    readonly channel: Extract<ReminderChannelValue, 'WHATSAPP' | 'SMS'>,
    private readonly credentials: TwilioCredentials,
  ) {}

  async send(reminder: OutboundReminder): Promise<{ providerId: string | null }> {
    const prefix = this.channel === 'WHATSAPP' ? 'whatsapp:' : '';
    const body = new URLSearchParams({
      From: this.credentials.from,
      To: `${prefix}${reminder.to}`,
      Body: reminder.body,
    });

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.credentials.accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${this.credentials.accountSid}:${this.credentials.authToken}`,
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(10_000),
      },
    );

    const payload = (await response.json().catch(() => ({}))) as {
      sid?: string;
      message?: string;
    };
    if (!response.ok) {
      throw new Error(`Twilio rechazó el mensaje (${response.status}): ${payload.message ?? ''}`);
    }
    return { providerId: payload.sid ?? null };
  }
}
