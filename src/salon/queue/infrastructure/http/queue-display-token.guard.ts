import {
  createParamDecorator,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

import { EntityNotFoundError } from '../../../../shared/domain/errors';
import { displayTokenDigest } from '../../application/queue-board.use-cases';
import {
  QUEUE_DISPLAY_LINKS,
  type QueueDisplayLinks,
  type QueueDisplaySalon,
} from '../../domain/queue.ports';

/** Forma del enlace: 18 bytes en base64url. Otra longitud ni siquiera se busca. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,64}$/;

type DisplayRequest = { params: { token?: string }; queueDisplaySalon?: QueueDisplaySalon };

/**
 * Resuelve el salón del enlace de la pantalla **antes** de llegar al controlador.
 *
 * Tiene que ser un guard y no una comprobación dentro del método: en una ruta `@Sse`, NestJS
 * responde 200 con `text/event-stream` en cuanto el método empieza, y un error lanzado después
 * llega como evento `error` dentro de un canal ya abierto. La pantalla lo tomaba por una
 * conexión buena que se corta y reconectaba cada dos segundos con un enlace retirado. Desde un
 * guard, un enlace que no vale es un 404 de verdad.
 */
@Injectable()
export class QueueDisplayTokenGuard implements CanActivate {
  constructor(@Inject(QUEUE_DISPLAY_LINKS) private readonly links: QueueDisplayLinks) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<DisplayRequest>();
    const token = request.params.token ?? '';
    const salon =
      TOKEN_SHAPE.test(token) && (await this.links.findSalonByDigest(displayTokenDigest(token)));
    if (!salon) throw new EntityNotFoundError('Pantalla de turnos', 'enlace no válido');
    request.queueDisplaySalon = salon;
    return true;
  }
}

/** El salón que `QueueDisplayTokenGuard` encontró para el enlace de la petición. */
export const DisplaySalon = createParamDecorator(
  (_data: unknown, context: ExecutionContext): QueueDisplaySalon =>
    context.switchToHttp().getRequest<DisplayRequest>().queueDisplaySalon!,
);
