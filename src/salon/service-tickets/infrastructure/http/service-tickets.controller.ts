import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PERMISSIONS } from '../../../../core/permissions/domain/permission-catalog';
import type { AccessTokenClaims } from '../../../../shared/application/ports';
import { WILDCARD_PERMISSION } from '../../../../shared/domain/authorization';
import { DomainValidationError, ForbiddenActionError } from '../../../../shared/domain/errors';
import type { Env } from '../../../../shared/infrastructure/config/env.schema';
import {
  CurrentUser,
  RequireAnyPermission,
  RequirePermissions,
} from '../../../../shared/infrastructure/http/decorators';
import {
  STYLIST_REPOSITORY,
  type StylistRepository,
} from '../../../stylists/domain/stylist.repository';
import {
  CancelServiceTicketUseCase,
  ChargeServiceTicketUseCase,
  ListAssignableServicesUseCase,
  ListServiceTicketsUseCase,
  RegisterServiceTicketUseCase,
  type ServiceTicketView,
} from '../../application/service-ticket.use-cases';
import {
  AssignableServiceResponse,
  AssignableServicesQueryDto,
  CancelServiceTicketDto,
  ChargeServiceTicketDto,
  RegisterServiceTicketDto,
  ServiceTicketCancelResponse,
  ServiceTicketChargeResponse,
  ServiceTicketPageResponse,
  ServiceTicketQueryDto,
  ServiceTicketResponse,
} from './service-ticket.dto';

/** Marca de «usuario con permiso `.own` y sin ficha profesional»: no ve nada. */
const NO_STYLIST_PROFILE = '__sin_ficha_profesional__';

/**
 * Adaptador HTTP de las comandas de servicio (ADR-0019).
 *
 * Tiene ámbito por filas como la agenda (ADR-0006): la profesional trabaja con permisos
 * `.own` y solo ve, registra y anula lo suyo; caja trabaja con los permisos completos. El
 * controlador resuelve quién es la profesional y el caso de uso impone el filtro.
 */
@ApiTags('Comandas de servicio')
@Controller({ path: 'service-tickets', version: '1' })
export class ServiceTicketsController {
  private readonly currency: string;

  constructor(
    private readonly registerTicket: RegisterServiceTicketUseCase,
    private readonly chargeTicket: ChargeServiceTicketUseCase,
    private readonly cancelTicket: CancelServiceTicketUseCase,
    private readonly listTickets: ListServiceTicketsUseCase,
    private readonly listAssignable: ListAssignableServicesUseCase,
    @Inject(STYLIST_REPOSITORY) private readonly stylists: StylistRepository,
    config: ConfigService<Env, true>,
  ) {
    this.currency = config.get('DEFAULT_CURRENCY', { infer: true });
  }

  /**
   * `null` si el usuario tiene el permiso completo; si no, el id de su ficha profesional.
   * Un usuario `.own` sin ficha recibe un id imposible: no ve nada en lugar de verlo todo.
   */
  private async ownScopeFor(user: AccessTokenClaims, fullPermission: string) {
    const permissions = new Set(user.permissions);
    if (permissions.has(WILDCARD_PERMISSION) || permissions.has(fullPermission)) return null;

    const stylist = await this.stylists.findByUserId(user.sub);
    return stylist?.id ?? NO_STYLIST_PROFILE;
  }

  /**
   * Profesional por cuenta de quien se registra o se consulta.
   *
   * Con el permiso completo se puede indicar cualquiera; si no se indica, la propia ficha
   * de quien inicia sesión. Con `.own` siempre es la propia, llegue lo que llegue.
   */
  private async actingStylistId(
    user: AccessTokenClaims,
    requested: string | undefined,
  ): Promise<string> {
    const scope = await this.ownScopeFor(user, PERMISSIONS.serviceTickets.create);
    if (scope === NO_STYLIST_PROFILE) {
      throw new ForbiddenActionError(
        PERMISSIONS.serviceTickets.createOwn,
        'Tu cuenta no tiene ficha profesional vinculada. Pide a la administración que la cree.',
      );
    }
    if (scope) return scope;
    if (requested) return requested;

    const own = await this.stylists.findByUserId(user.sub);
    if (!own) throw new DomainValidationError('Indique la profesional', 'stylistId');
    return own.id;
  }

  @Get()
  @RequireAnyPermission(PERMISSIONS.serviceTickets.read, PERMISSIONS.serviceTickets.readOwn)
  @ApiOperation({
    operationId: 'service_tickets_list',
    summary: 'Lista comandas con su importe actual',
    description:
      'Caja filtra por `status=PENDING` para ver lo que falta cobrar. Con ' +
      '`service-tickets.read.own` solo se ven las propias.',
  })
  @ApiOkResponse({ type: ServiceTicketPageResponse })
  async list(@Query() query: ServiceTicketQueryDto, @CurrentUser() user: AccessTokenClaims) {
    const page = await this.listTickets.execute({
      filter: {
        stylistId: query.stylistId,
        status: query.status,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
      },
      page: query.toPageRequest(),
      currency: this.currency,
      restrictToStylistId: await this.ownScopeFor(user, PERMISSIONS.serviceTickets.read),
    });

    return { data: page.data.map(present), meta: page.meta };
  }

  @Get('assignable-services')
  @RequireAnyPermission(PERMISSIONS.serviceTickets.create, PERMISSIONS.serviceTickets.createOwn)
  @ApiOperation({
    operationId: 'service_tickets_assignable_services',
    summary: 'Servicios que la profesional puede registrar',
    description:
      'Los activos del catálogo que la administración le ha asignado. Sin asignaciones, todos.',
  })
  @ApiOkResponse({ type: [AssignableServiceResponse] })
  async assignable(
    @Query() query: AssignableServicesQueryDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<AssignableServiceResponse[]> {
    const services = await this.listAssignable.execute({
      stylistId: await this.actingStylistId(user, query.stylistId),
    });

    return services.map((service) => ({
      id: service.id,
      name: service.name,
      durationMinutes: service.durationMinutes,
      price: service.price.toDecimalString(),
      priceWithTax: service.priceWithTax.toDecimalString(),
      currency: service.price.currency,
    }));
  }

  @Post()
  @RequireAnyPermission(PERMISSIONS.serviceTickets.create, PERMISSIONS.serviceTickets.createOwn)
  @ApiOperation({
    operationId: 'service_tickets_register',
    summary: 'Registra los servicios realizados a una clienta para que caja los cobre',
  })
  @ApiCreatedResponse({ type: ServiceTicketResponse })
  async register(@Body() dto: RegisterServiceTicketDto, @CurrentUser() user: AccessTokenClaims) {
    const ticket = await this.registerTicket.execute({
      tenantId: requireTenant(user),
      stylistId: await this.actingStylistId(user, dto.stylistId),
      serviceIds: dto.serviceIds,
      clientId: dto.clientId ?? null,
      clientName: dto.clientName ?? null,
      appointmentId: dto.appointmentId ?? null,
      notes: dto.notes ?? null,
      actorId: user.sub,
    });

    // Se devuelve con importe y nombres, igual que en el listado: la pantalla que registra
    // la pinta en su lista sin volver a pedirla.
    const [view] = await this.listTickets.describe([ticket], this.currency);
    return present(view);
  }

  @Post(':id/charge')
  @RequirePermissions(
    PERMISSIONS.serviceTickets.read,
    PERMISSIONS.invoices.create,
    PERMISSIONS.payments.create,
  )
  @ApiOperation({
    operationId: 'service_tickets_charge',
    summary: 'Cobra una comanda: emite la factura y la marca cobrada en la misma transacción',
  })
  @ApiCreatedResponse({ type: ServiceTicketChargeResponse })
  async charge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChargeServiceTicketDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<ServiceTicketChargeResponse> {
    const { ticket, invoice } = await this.chargeTicket.execute({
      ticketId: id,
      tenantId: requireTenant(user),
      currency: this.currency,
      payments: dto.payments.map((payment) => ({
        method: payment.method,
        amount: payment.amount.toFixed(2),
        reference: payment.reference ?? null,
      })),
      actorId: user.sub,
    });

    return {
      ticketId: ticket.id,
      status: ticket.status,
      invoiceId: invoice.id,
      number: invoice.number,
      total: invoice.total.toDecimalString(),
    };
  }

  @Post(':id/cancel')
  @RequireAnyPermission(PERMISSIONS.serviceTickets.cancel, PERMISSIONS.serviceTickets.cancelOwn)
  @ApiOperation({
    operationId: 'service_tickets_cancel',
    summary: 'Anula una comanda pendiente. Con `.own`, solo las propias',
  })
  @ApiCreatedResponse({ type: ServiceTicketCancelResponse })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelServiceTicketDto,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<ServiceTicketCancelResponse> {
    const ticket = await this.cancelTicket.execute({
      ticketId: id,
      reason: dto.reason,
      actorId: user.sub,
      restrictToStylistId: await this.ownScopeFor(user, PERMISSIONS.serviceTickets.cancel),
    });

    return { ticketId: ticket.id, status: ticket.status };
  }
}

// ---------------------------------------------------------------------------

const present = (view: ServiceTicketView): ServiceTicketResponse => ({
  id: view.ticket.id,
  status: view.ticket.status,
  stylistId: view.ticket.stylistId,
  stylistName: view.stylistName,
  clientId: view.ticket.clientId,
  clientName: view.ticket.clientName,
  appointmentId: view.ticket.appointmentId,
  invoiceId: view.ticket.invoiceId,
  notes: view.ticket.notes,
  lines: view.lines.map((line) => ({
    serviceId: line.serviceId,
    name: line.name,
    unitPrice: line.unitPrice.toDecimalString(),
    taxRate: line.taxRate?.value ?? null,
    lineTotal: line.lineTotal.toDecimalString(),
    available: line.available,
  })),
  total: view.total.toDecimalString(),
  currency: view.total.currency,
  createdAt: view.ticket.audit.createdAt.toISOString(),
  chargedAt: view.ticket.chargedAt?.toISOString() ?? null,
  cancelledAt: view.ticket.cancelledAt?.toISOString() ?? null,
  cancellationReason: view.ticket.cancellationReason,
});

const requireTenant = (user: AccessTokenClaims): string => {
  if (!user.tenantId) {
    throw new ForbiddenActionError(
      'service-tickets',
      'Registrar o cobrar servicios requiere estar asignado a un salón',
    );
  }
  return user.tenantId;
};
