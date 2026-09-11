import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import {
  AUDIT_RECORDER,
  CLOCK,
  EMAIL_SENDER,
  ID_GENERATOR,
  PASSWORD_HASHER,
  TOKEN_SIGNER,
} from './application/ports';
import { OBJECT_STORAGE } from './application/object-storage.port';
import { UNIT_OF_WORK, type UnitOfWork } from './domain/ports/repository.port';
import { MinioObjectStorage } from './infrastructure/storage/minio-object-storage.adapter';
import { SystemClock, UuidV7Generator } from './infrastructure/adapters/system.adapters';
import { PrismaAuditRecorder } from './infrastructure/audit/prisma-audit-recorder.adapter';
import { LoggingEmailSender } from './infrastructure/email/logging-email-sender.adapter';
import { validateEnv } from './infrastructure/config/env.schema';
import { PrismaService } from './infrastructure/persistence/prisma/prisma.service';
import { Argon2PasswordHasher } from './infrastructure/security/argon2-password-hasher.adapter';
import { JwtTokenSigner } from './infrastructure/security/jwt-token-signer.adapter';

/**
 * Cableado del shared kernel.
 *
 * Este módulo es el **único** sitio donde los puertos se atan a sus adaptadores. Esa es
 * la parte práctica de la inversión de dependencias del ADR-0001: sustituir Argon2 por
 * otro algoritmo, o Prisma por otro ORM, es cambiar una línea aquí, no buscar
 * importaciones por todo el árbol.
 *
 * Es `@Global` porque estas capacidades —reloj, identificadores, hashing— las necesita
 * casi todo módulo. La alternativa, importar `SharedModule` en cada uno, es ruido sin
 * beneficio: no aporta aislamiento real, ya que igualmente son singletons del proceso.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Se valida el entorno completo al arrancar y se aborta si algo falla: es mucho
      // más barato no arrancar que descubrir a las tres horas que un secreto era el de
      // ejemplo.
      validate: validateEnv,
      /**
       * En tests se carga **solo** `.env.test`, nunca `.env`.
       *
       * Con ambos en la lista, `.env` acaba imponiéndose y la suite hereda en silencio
       * la configuración de desarrollo. Eso no es una molestia menor: significa que los
       * tests corren con parámetros distintos de los que declaran y, en el peor caso,
       * contra la base de datos de desarrollo. Se detectó porque los límites de peticiones
       * de `.env.test` no se aplicaban y la suite se estrangulaba a sí misma.
       *
       * Un fichero por entorno, sin herencia: si a `.env.test` le falta una variable, el
       * arranque falla con un mensaje claro en vez de tomarla de otro sitio.
       */
      envFilePath: process.env.NODE_ENV === 'test' ? ['.env.test'] : ['.env'],
    }),
    // Sin secreto global: cada operación de firma indica el suyo, porque access y
    // refresh usan secretos distintos (ADR-0005) y un secreto por defecto invitaría a
    // olvidarlo y firmar ambos con el mismo.
    JwtModule.register({}),
  ],
  providers: [
    PrismaService,
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    { provide: TOKEN_SIGNER, useClass: JwtTokenSigner },
    { provide: AUDIT_RECORDER, useClass: PrismaAuditRecorder },
    // El almacen de objetos vive aqui y no en el modulo de clientas: las fotos son su
    // primer uso, pero el avatar del profesional y la imagen de un producto son el mismo
    // problema, y tenerlo compartido evita que el segundo caso traiga una segunda
    // implementacion (ADR-0016).
    { provide: OBJECT_STORAGE, useClass: MinioObjectStorage },
    // Sustituya este adaptador por uno de proveedor real (SMTP, SES, Resend…) antes de
    // desplegar: el actual escribe los mensajes en el registro y no envía nada.
    { provide: EMAIL_SENDER, useClass: LoggingEmailSender },
    {
      // La unidad de trabajo se expresa sobre el puerto para que los casos de uso no
      // sepan que por debajo hay una transacción de Prisma.
      provide: UNIT_OF_WORK,
      useFactory: (prisma: PrismaService): UnitOfWork => ({
        execute: (work) => prisma.transaction(work),
      }),
      inject: [PrismaService],
    },
  ],
  exports: [
    ConfigModule,
    JwtModule,
    PrismaService,
    CLOCK,
    ID_GENERATOR,
    PASSWORD_HASHER,
    TOKEN_SIGNER,
    AUDIT_RECORDER,
    UNIT_OF_WORK,
    OBJECT_STORAGE,
    EMAIL_SENDER,
  ],
})
export class SharedModule {}

export { ConfigService };
