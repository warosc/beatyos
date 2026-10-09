import { Logger, type CallHandler, type ExecutionContext } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { lastValueFrom, of } from 'rxjs';

import { RequestContextStore } from '../context/request-context';
import {
  HttpLoggingInterceptor,
  RequestContextMiddleware,
  ResponseEnvelopeInterceptor,
} from './interceptors';

const httpContext = (request: Partial<Request>, response: Partial<Response> = {}) =>
  ({
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  }) as unknown as ExecutionContext;

const returning = (value: unknown): CallHandler => ({ handle: () => of(value) });

describe('RequestContextMiddleware', () => {
  const run = (headers: Record<string, string>, ip?: string) => {
    const request = {
      header: (name: string) => headers[name],
      ip,
      socket: { remoteAddress: '10.0.0.9' },
    } as unknown as Request;
    const response = { setHeader: jest.fn() } as unknown as Response;
    let seen = RequestContextStore.get();
    new RequestContextMiddleware().use(request, response, (() => {
      seen = RequestContextStore.get();
    }) as NextFunction);
    return { seen, response };
  };

  it('toma como IP la de la visitante, la primera de X-Forwarded-For', () => {
    // De ella dependen los límites de peticiones: si fuera la del contenedor web, todas las
    // clientas compartirían un solo cupo.
    expect(run({ 'x-forwarded-for': ' 190.56.1.2 , 172.18.0.3' }).seen.ipAddress).toBe(
      '190.56.1.2',
    );
  });

  it('sin proxy delante usa la IP de la conexión', () => {
    expect(run({}, '127.0.0.1').seen.ipAddress).toBe('127.0.0.1');
    expect(run({}).seen.ipAddress).toBe('10.0.0.9');
  });

  it('respeta la correlación entrante y la devuelve en la respuesta', () => {
    const { seen, response } = run({ 'x-request-id': 'traza-externa' });

    expect(seen.correlationId).toBe('traza-externa');
    expect(response.setHeader).toHaveBeenCalledWith('x-correlation-id', 'traza-externa');
  });
});

describe('ResponseEnvelopeInterceptor', () => {
  it('no vuelve a envolver lo que ya viene envuelto', async () => {
    const wrapped = { data: { id: 'x' }, accessToken: 'abc' };

    await expect(
      lastValueFrom(
        new ResponseEnvelopeInterceptor().intercept(httpContext({}), returning(wrapped)),
      ),
    ).resolves.toBe(wrapped);
  });
});

describe('HttpLoggingInterceptor', () => {
  let log: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('registra la petición sin el enlace de la clienta', async () => {
    const request = {
      method: 'POST',
      originalUrl: '/api/v1/public/appointment-links/EnlaceSecreto123456/confirm',
      headers: {},
    };

    await lastValueFrom(
      new HttpLoggingInterceptor().intercept(
        httpContext(request, { statusCode: 200 }),
        returning({ ok: true }),
      ),
    );

    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('POST /api/v1/public/appointment-links/…/confirm 200');
    expect(line).not.toContain('EnlaceSecreto123456');
  });

  it('un canal en vivo deja una sola línea al abrirse, con salón y usuaria', () => {
    const request = {
      method: 'GET',
      originalUrl: '/api/v1/agenda/stream',
      headers: { accept: 'text/event-stream' },
    };

    RequestContextStore.run({ tenantId: 'salon-1', userId: 'user-1' }, () =>
      new HttpLoggingInterceptor().intercept(httpContext(request), returning(undefined)),
    );

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(
      /GET \/api\/v1\/agenda\/stream stream abierto \[cid=.+ tenant=salon-1 user=user-1\]/,
    );
  });
});
