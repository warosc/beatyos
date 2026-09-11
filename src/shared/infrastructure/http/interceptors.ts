import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  NestMiddleware,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { map, tap, type Observable } from 'rxjs';

import { RequestContextStore } from '../context/request-context';

/**
 * Middleware que abre el contexto de petición.
 *
 * Debe ser lo **primero** de la cadena: guards, interceptores, casos de uso y
 * repositorios asumen que existe. Aquí solo se rellena lo que se sabe antes de
 * autenticar (correlación, IP, agente); el guard completa después usuario y salón.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    // Se respeta el identificador de correlación entrante si viene de una pasarela o de
    // un servicio llamante: así una traza atraviesa varios saltos sin romperse.
    const incoming = request.header('x-correlation-id') ?? request.header('x-request-id');

    RequestContextStore.run(
      {
        ...(incoming ? { correlationId: incoming } : {}),
        ipAddress: this.clientIp(request),
        userAgent: request.header('user-agent') ?? null,
      },
      () => {
        // Devolverlo permite que el cliente lo cite en una incidencia y que el equipo
        // encuentre la petición exacta en los logs sin buscar por hora aproximada.
        response.setHeader('x-correlation-id', RequestContextStore.correlationId);
        next();
      },
    );
  }

  private clientIp(request: Request): string | null {
    // `x-forwarded-for` solo es fiable si la app está detrás de un proxy de confianza y
    // `trust proxy` está configurado; en otro caso el cliente puede falsearla. Se usa
    // para diagnóstico y auditoría, nunca para decisiones de autorización.
    const forwarded = request.header('x-forwarded-for');
    if (forwarded) return forwarded.split(',')[0]?.trim() ?? null;
    return request.ip ?? request.socket.remoteAddress ?? null;
  }
}

/**
 * Envoltura uniforme de respuesta (ADR-0007).
 *
 * Todo lo que devuelve un controlador sale como `{ data: ... }`, y las colecciones
 * paginadas añaden `meta`. Se hace aquí, una vez, en lugar de en cada controlador: así
 * un endpoint nuevo no puede olvidarse del formato, y añadir un campo de metadatos
 * —un aviso de deprecación, por ejemplo— no obliga a tocar cuarenta ficheros.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((payload: unknown) => {
        if (payload === undefined || payload === null) {
          return { data: null };
        }

        // Un `Page` del dominio ya trae `data` y `meta`: se deja pasar tal cual en vez
        // de anidarlo en otro `data`.
        if (this.isPage(payload)) {
          return { data: payload.data, meta: payload.meta };
        }

        // Ya envuelto por el controlador (poco frecuente, pero ocurre en respuestas de
        // autenticación que añaden campos propios).
        if (typeof payload === 'object' && 'data' in payload) {
          return payload;
        }

        return { data: payload };
      }),
    );
  }

  private isPage(value: unknown): value is { data: unknown[]; meta: unknown } {
    return (
      typeof value === 'object' &&
      value !== null &&
      'data' in value &&
      'meta' in value &&
      Array.isArray((value as { data: unknown }).data)
    );
  }
}

/**
 * Registro de acceso.
 *
 * Deliberadamente escueto: método, ruta, estado, duración y correlación. Ni cuerpos ni
 * cabeceras —un log de aplicación no es sitio para contraseñas, tokens ni datos de
 * clientes, y una vez que llegan al recolector de logs ya no se pueden retirar.
 */
@Injectable()
export class HttpLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const startedAt = Date.now();
    const { correlationId, userId, tenantId } = RequestContextStore.get();

    return next.handle().pipe(
      tap({
        next: () => {
          const elapsed = Date.now() - startedAt;
          this.logger.log(
            `${request.method} ${request.originalUrl} ${response.statusCode} ${elapsed}ms ` +
              `[cid=${correlationId}${tenantId ? ` tenant=${tenantId}` : ''}${userId ? ` user=${userId}` : ''}]`,
          );
        },
        // Los errores no se registran aquí: lo hace el filtro global, que además conoce
        // el estado HTTP final. Duplicarlo produciría dos líneas por cada fallo.
        error: () => undefined,
      }),
    );
  }
}
