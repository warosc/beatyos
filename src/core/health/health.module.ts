import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { Public } from '../../shared/infrastructure/http/decorators';
import { PrismaService } from '../../shared/infrastructure/persistence/prisma/prisma.service';

/**
 * Comprobaciones de salud.
 *
 * Son **dos** endpoints distintos porque responden a preguntas distintas, y confundirlos
 * provoca caídas en cascada:
 *
 * - `live` (*liveness*): ¿el proceso responde? Si falla, el orquestador **reinicia** el
 *   contenedor. Por eso no toca la base de datos: si lo hiciera, una caída de PostgreSQL
 *   haría que Kubernetes reiniciara en bucle todas las réplicas, que es exactamente lo
 *   contrario de lo que conviene mientras se recupera la base.
 *
 * - `ready` (*readiness*): ¿puede atender tráfico? Si falla, el balanceador **deja de
 *   enviarle peticiones** sin matarlo. Aquí sí se comprueba la base: sin ella la
 *   aplicación no sirve de nada, pero se recuperará sola en cuanto vuelva.
 */
@ApiTags('Salud')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(private readonly prisma: PrismaService) {}

  @Get('live')
  @Public()
  @SkipThrottle()
  @ApiOperation({
    summary: 'Sonda de vida',
    description: 'Solo confirma que el proceso responde. No consulta la base de datos.',
  })
  live(): { status: string; uptimeSeconds: number } {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  @Get('ready')
  @Public()
  @SkipThrottle()
  @ApiOperation({
    summary: 'Sonda de disponibilidad',
    description:
      'Comprueba la conexión con PostgreSQL. Un 503 retira la instancia del balanceador.',
  })
  async ready(): Promise<{ status: string; database: string }> {
    const databaseUp = await this.prisma.ping();

    if (!databaseUp) {
      // 503 y no 200 con un campo de estado: los balanceadores y orquestadores miran el
      // código HTTP, no el cuerpo. Un 200 con `{"status":"down"}` seguiría recibiendo
      // tráfico que no puede atender.
      throw new ServiceUnavailableException({
        status: 'unavailable',
        database: 'down',
      });
    }

    return { status: 'ok', database: 'up' };
  }
}

@Module({
  controllers: [HealthController],
})
export class HealthModule {}
