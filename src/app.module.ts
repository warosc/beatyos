import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuthModule } from './core/auth/auth.module';
import { HealthModule } from './core/health/health.module';
import { UsersModule } from './core/users/users.module';
import { RolesModule } from './core/roles/roles.module';
import { ClientsModule } from './salon/clients/clients.module';
import { AppointmentsModule } from './salon/appointments/appointments.module';
import { CatalogModule } from './salon/catalog/catalog.module';
import { StylistsModule } from './salon/stylists/stylists.module';
import { InventoryModule } from './salon/inventory/inventory.module';
import { SalesModule } from './salon/sales/sales.module';
import { CashModule } from './salon/cash/cash.module';
import { ReportsModule } from './salon/reports/reports.module';
import { PurchasesModule } from './salon/purchases/purchases.module';
import { GoalsModule } from './salon/goals/goals.module';
import { SharedModule } from './shared/shared.module';
import type { Env } from './shared/infrastructure/config/env.schema';
import {
  RequestContextMiddleware,
  ResponseEnvelopeInterceptor,
  HttpLoggingInterceptor,
} from './shared/infrastructure/http/interceptors';
import { JwtAuthGuard, PermissionsGuard } from './shared/infrastructure/security/guards';
import { ScopedThrottlerGuard } from './shared/infrastructure/security/scoped-throttler.guard';

/**
 * Composición de la aplicación.
 *
 * El orden de los guards globales importa y no es intercambiable:
 *
 *   1. `ScopedThrottlerGuard` — el primero. Rechazar un exceso de peticiones antes de verificar
 *      firmas es lo que hace que el límite sirva de algo: si el orden fuera el inverso,
 *      un atacante consumiría CPU en verificaciones criptográficas de tokens basura.
 *   2. `JwtAuthGuard` — establece quién hace la petición y en qué salón.
 *   3. `PermissionsGuard` — decide si ese quién puede hacer esto.
 *
 * Los tres son globales: la protección es lo predeterminado y abrir un endpoint exige
 * una anotación explícita (`@Public()`). Al revés —proteger endpoint por endpoint— el
 * primer olvido queda expuesto y nadie se entera hasta que alguien lo encuentra.
 */
@Module({
  imports: [
    SharedModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        // Tres ventanas superpuestas (ADR-0007): la corta frena las ráfagas, la media el
        // uso abusivo sostenido y la larga el rastreo lento que las otras dos no verían.
        throttlers: [
          {
            name: 'short',
            ttl: config.get('THROTTLE_SHORT_TTL', { infer: true }),
            limit: config.get('THROTTLE_SHORT_LIMIT', { infer: true }),
          },
          {
            name: 'medium',
            ttl: config.get('THROTTLE_MEDIUM_TTL', { infer: true }),
            limit: config.get('THROTTLE_MEDIUM_LIMIT', { infer: true }),
          },
          {
            name: 'long',
            ttl: config.get('THROTTLE_LONG_TTL', { infer: true }),
            limit: config.get('THROTTLE_LONG_LIMIT', { infer: true }),
          },
          // Ventana propia para el inicio de sesión, mucho más estrecha. NO es global:
          // solo actúa donde el endpoint la declara con @ApplyThrottler('auth'). Ver
          // ScopedThrottlerGuard, que existe precisamente por esto.
          {
            name: 'auth',
            ttl: config.get('AUTH_THROTTLE_TTL', { infer: true }),
            limit: config.get('AUTH_THROTTLE_LIMIT', { infer: true }),
          },
        ],
      }),
    }),

    // --- Núcleo ---
    UsersModule,
    RolesModule,
    AuthModule,
    HealthModule,

    // --- Salón ---
    ClientsModule,
    StylistsModule,
    CatalogModule,
    AppointmentsModule,
    InventoryModule,
    SalesModule,
    CashModule,
    ReportsModule,
    PurchasesModule,
    GoalsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ScopedThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: HttpLoggingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Antes que cualquier guard: todo lo demás da por hecho que el contexto existe.
    consumer
      .apply(RequestContextMiddleware)
      .forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
