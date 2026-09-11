import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { EmailSender, OutboundEmail } from '../../application/ports';
import type { Env } from '../config/env.schema';

/**
 * Adaptador de correo que no envía correo: lo escribe en el registro.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────────────
 *
 * La recuperación de contraseña necesitaba un puerto de envío para dejar de depender de que
 * la API devolviera el token en su propia respuesta. El puerto ya está; elegir **proveedor**
 * —SMTP propio, SES, Resend, Postmark— es una decisión de despliegue con coste y contrato de
 * servicio detrás, y no es de las que conviene tomar de tapadillo dentro de un refactor.
 *
 * Así que éste es el adaptador por defecto: hace visible el mensaje en desarrollo, permite
 * recorrer el flujo completo sin buzón, y deja el cambio a un proveedor real reducido a una
 * línea en `shared.module.ts`.
 *
 * ── Por qué avisa tan fuerte en producción ──────────────────────────────────────────
 *
 * Un adaptador que traga los mensajes en silencio es peor que no tenerlo: el usuario pide
 * recuperar su cuenta, la API responde 202 y no pasa nada más. Nadie se entera hasta que
 * alguien llama por teléfono. El aviso por cada envío convierte ese silencio en ruido.
 *
 * No tumba el arranque a propósito, por el mismo criterio que el almacén de objetos: que no
 * se pueda recuperar una contraseña no debería impedir dar cita ni cobrar.
 */
@Injectable()
export class LoggingEmailSender implements EmailSender {
  private readonly logger = new Logger(LoggingEmailSender.name);
  private readonly isProduction: boolean;

  constructor(config: ConfigService<Env, true>) {
    this.isProduction = config.get('NODE_ENV', { infer: true }) === 'production';
  }

  send(email: OutboundEmail): Promise<void> {
    if (this.isProduction) {
      this.logger.error(
        `No hay proveedor de correo configurado: el mensaje "${email.subject}" para ` +
          `${email.to} NO se ha enviado. Sustituya EMAIL_SENDER por un adaptador real.`,
      );
      return Promise.resolve();
    }

    this.logger.log(`Correo simulado para ${email.to} — ${email.subject}\n${email.body}`);
    return Promise.resolve();
  }
}
