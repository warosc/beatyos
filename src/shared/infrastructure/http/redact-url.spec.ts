import { redactUrl } from './redact-url';

describe('redactUrl', () => {
  it('oculta el enlace de la clienta, también en sus acciones', () => {
    expect(redactUrl('/api/v1/public/appointment-links/AbC_12-xyz')).toBe(
      '/api/v1/public/appointment-links/…',
    );
    expect(redactUrl('/api/v1/public/appointment-links/AbC_12-xyz/cancel?x=1')).toBe(
      '/api/v1/public/appointment-links/…/cancel?x=1',
    );
  });

  it('deja intactas las demás rutas', () => {
    expect(redactUrl('/api/v1/appointments/abc?from=2026-10-09')).toBe(
      '/api/v1/appointments/abc?from=2026-10-09',
    );
  });
});
