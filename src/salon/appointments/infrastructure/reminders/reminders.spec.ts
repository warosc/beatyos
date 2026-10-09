import { Logger } from '@nestjs/common';

import { FixedClock } from '@shared/infrastructure/adapters/system.adapters';
import { RequestContextStore } from '@shared/infrastructure/context/request-context';

import type { SendDueRemindersUseCase } from '../../application/reminder.use-cases';
import type { ReminderLog, ReminderSettings } from '../../domain/agenda.ports';
import { ReminderScheduler } from './reminder-scheduler';
import { LoggingReminderSender, TwilioReminderSender } from './reminder-senders';

const credentials = { accountSid: 'AC123', authToken: 'secreto', from: 'whatsapp:+14155238886' };
const reminder = { to: '+50255551234', body: 'Hola Ana, mañana a las 10:00. https://x/cita/abc' };

describe('Envío de recordatorios', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => jest.restoreAllMocks());

  const reply = (status: number, payload: unknown) =>
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload), { status }));

  const sentRequest = () => {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url, init, form: init.body as URLSearchParams };
  };

  describe('Twilio', () => {
    it('por WhatsApp antepone el canal al teléfono y se identifica con la cuenta', async () => {
      reply(201, { sid: 'SM1' });

      const result = await new TwilioReminderSender('WHATSAPP', credentials).send(reminder);

      expect(result).toEqual({ providerId: 'SM1' });
      const { url, init, form } = sentRequest();
      expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>).Authorization).toBe(
        `Basic ${Buffer.from('AC123:secreto').toString('base64')}`,
      );
      expect(form.get('To')).toBe('whatsapp:+50255551234');
      expect(form.get('From')).toBe('whatsapp:+14155238886');
      expect(form.get('Body')).toBe(reminder.body);
    });

    it('por SMS manda el teléfono tal cual', async () => {
      reply(201, { sid: 'SM2' });

      await new TwilioReminderSender('SMS', { ...credentials, from: '+15005550006' }).send(
        reminder,
      );

      expect(sentRequest().form.get('To')).toBe('+50255551234');
    });

    it('si Twilio lo rechaza, falla con su motivo para que se reintente', async () => {
      reply(400, { message: 'The number is unverified' });

      await expect(new TwilioReminderSender('SMS', credentials).send(reminder)).rejects.toThrow(
        'Twilio rechazó el mensaje (400): The number is unverified',
      );
    });

    it('una respuesta que no es JSON no rompe el envío ni inventa un identificador', async () => {
      fetchMock.mockResolvedValue(new Response('<html>', { status: 503 }));
      await expect(new TwilioReminderSender('SMS', credentials).send(reminder)).rejects.toThrow(
        'Twilio rechazó el mensaje (503): ',
      );

      fetchMock.mockResolvedValue(new Response('', { status: 201 }));
      await expect(new TwilioReminderSender('SMS', credentials).send(reminder)).resolves.toEqual({
        providerId: null,
      });
    });
  });

  it('sin proveedor no escribe ni el teléfono ni el enlace en el registro', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await expect(new LoggingReminderSender().send(reminder)).resolves.toEqual({
      providerId: null,
    });

    const written = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(written).not.toContain(reminder.to);
    expect(written).not.toContain('/cita/');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Planificador de recordatorios', () => {
  const settings = (enabled: boolean): ReminderSettings => ({
    enabled,
    leadHours: 24,
    minimumLeadMinutes: 120,
    publicWebUrl: 'https://salon.example.com',
    defaultCountryCode: '502',
    timeZone: 'America/Guatemala',
  });

  let execute: jest.Mock;
  let tenantsWithDue: jest.Mock;
  let errors: jest.SpyInstance;

  const scheduler = (enabled = true) =>
    new ReminderScheduler(
      { execute } as unknown as SendDueRemindersUseCase,
      { tenantsWithDue } as unknown as ReminderLog,
      settings(enabled),
      new FixedClock(new Date('2026-10-09T15:00:00Z')),
    );

  beforeEach(() => {
    execute = jest.fn().mockResolvedValue(undefined);
    tenantsWithDue = jest.fn().mockResolvedValue([]);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('apagado no programa nada', () => {
    const interval = jest.spyOn(global, 'setInterval');

    const subject = scheduler(false);
    subject.onApplicationBootstrap();
    subject.onModuleDestroy();

    expect(interval).not.toHaveBeenCalled();
  });

  it('encendido programa las pasadas y las detiene al apagar la aplicación', () => {
    const clear = jest.spyOn(global, 'clearInterval');

    const subject = scheduler(true);
    subject.onApplicationBootstrap();
    subject.onModuleDestroy();

    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('busca en la ventana configurada y envía cada salón dentro de su propio contexto', async () => {
    tenantsWithDue.mockResolvedValue(['salon-a', 'salon-b']);
    const seen: (string | null)[] = [];
    execute.mockImplementation(async () => {
      seen.push(RequestContextStore.get().tenantId);
    });

    await scheduler().tick();

    expect(tenantsWithDue).toHaveBeenCalledWith({
      from: new Date('2026-10-09T17:00:00Z'),
      to: new Date('2026-10-10T15:00:00Z'),
    });
    expect(seen).toEqual(['salon-a', 'salon-b']);
  });

  it('un salón que falla no deja sin recordatorios a los demás', async () => {
    tenantsWithDue.mockResolvedValue(['salon-a', 'salon-b']);
    execute.mockRejectedValueOnce(new Error('Twilio caído')).mockResolvedValueOnce(undefined);

    await scheduler().tick();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('salon-a: Twilio caído'));
  });

  it('un fallo al buscar salones queda registrado y no tumba el proceso', async () => {
    tenantsWithDue.mockRejectedValue('base de datos caída');

    await expect(scheduler().tick()).resolves.toBeUndefined();

    expect(errors).toHaveBeenCalledWith(expect.stringContaining('base de datos caída'));
  });

  it('una pasada lenta no se solapa con la siguiente', async () => {
    let finish!: () => void;
    tenantsWithDue.mockReturnValue(
      new Promise<string[]>((resolve) => (finish = () => resolve([]))),
    );
    const subject = scheduler();

    const first = subject.tick();
    await subject.tick();
    finish();
    await first;

    expect(tenantsWithDue).toHaveBeenCalledTimes(1);
  });
});
