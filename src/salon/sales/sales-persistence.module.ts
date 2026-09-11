import { Module } from '@nestjs/common';

import {
  DOCUMENT_NUMBER_GENERATOR,
  INVOICE_REPOSITORY,
  PAYMENT_REPOSITORY,
} from './domain/sales.repositories';
import {
  PrismaDocumentNumberGenerator,
  PrismaInvoiceRepository,
  PrismaPaymentRepository,
} from './infrastructure/persistence/prisma-sales.repositories';

/**
 * Persistencia de ventas, aislada del resto del modulo.
 *
 * Existe para romper un ciclo real, no por gusto de dividir. Ventas necesita caja —un cobro
 * en efectivo se imputa a la sesion abierta— y caja necesita los cobros —el arqueo cuadra
 * el efectivo del dia—. Si cada modulo importara al otro entero, NestJS no podria construir
 * ninguno de los dos.
 *
 * Sacar aqui solo los puertos de persistencia deja a los dos dependiendo de los mismos
 * adaptadores y a ninguno del otro. La alternativa habitual —`forwardRef`— haria compilar
 * el ciclo sin eliminarlo, y un ciclo que compila sigue siendo un ciclo cuando alguien
 * intente entender quien depende de quien.
 */
@Module({
  providers: [
    { provide: INVOICE_REPOSITORY, useClass: PrismaInvoiceRepository },
    { provide: PAYMENT_REPOSITORY, useClass: PrismaPaymentRepository },
    { provide: DOCUMENT_NUMBER_GENERATOR, useClass: PrismaDocumentNumberGenerator },
  ],
  exports: [INVOICE_REPOSITORY, PAYMENT_REPOSITORY, DOCUMENT_NUMBER_GENERATOR],
})
export class SalesPersistenceModule {}
