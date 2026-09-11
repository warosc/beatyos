import { BusinessRuleViolationError, DomainValidationError } from '../../../shared/domain/errors';
import { ClientPhoto, type PhotoConsent } from './client-photo.entity';

const TENANT = '11111111-1111-7111-8111-111111111111';
const NOW = new Date('2026-09-03T10:00:00.000Z');
const CHECKSUM = 'a'.repeat(64);

const consent = (overrides: Partial<PhotoConsent> = {}): PhotoConsent => ({
  givenAt: new Date('2026-09-03T09:00:00.000Z'),
  source: 'IN_PERSON',
  allowsMarketing: false,
  ...overrides,
});

const aPhoto = (overrides: Partial<Parameters<typeof ClientPhoto.register>[0]> = {}) =>
  ClientPhoto.register({
    id: 'photo-1',
    tenantId: TENANT,
    clientId: 'client-1',
    storageKey: 'tenants/t/clients/c/2026/09/photo-1.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 120_000,
    checksum: CHECKSUM,
    consent: consent(),
    now: NOW,
    actorId: 'user-1',
    ...overrides,
  });

describe('ClientPhoto', () => {
  describe('alta', () => {
    it('registra la foto con su consentimiento', () => {
      const photo = aPhoto();

      expect(photo.kind).toBe('OTHER');
      expect(photo.consent.source).toBe('IN_PERSON');
      expect(photo.isViewable).toBe(true);
    });

    it('normaliza la huella a minúsculas', () => {
      expect(aPhoto({ checksum: 'A'.repeat(64) }).checksum).toBe(CHECKSUM);
    });

    it('toma la hora actual como fecha de la foto si no se indica otra', () => {
      expect(aPhoto().takenAt).toEqual(NOW);
    });

    describe('consentimiento', () => {
      it('rechaza guardar una imagen sin consentimiento', () => {
        // Es una regla del negocio y de la ley, no una validación de formulario: si mañana
        // entra otra vía de subida, tiene que chocar con la misma pared.
        expect(() => aPhoto({ consent: undefined as unknown as PhotoConsent })).toThrow(
          BusinessRuleViolationError,
        );
      });

      it('rechaza un consentimiento con fecha futura', () => {
        expect(() =>
          aPhoto({ consent: consent({ givenAt: new Date('2027-01-01T00:00:00.000Z') }) }),
        ).toThrow(DomainValidationError);
      });

      it('distingue guardar de publicar', () => {
        // Son dos decisiones distintas: consentir que se guarde la foto en la ficha no es
        // consentir que aparezca en el escaparate.
        expect(aPhoto().isPublishable).toBe(false);
        expect(aPhoto({ consent: consent({ allowsMarketing: true }) }).isPublishable).toBe(true);
      });
    });

    describe('formato y contenido', () => {
      it('rechaza un tipo que no está en la lista blanca', () => {
        expect(() => aPhoto({ mimeType: 'application/pdf' })).toThrow(/No se admiten ficheros/);
      });

      it('rechaza SVG aunque sea una imagen', () => {
        // Admite `<script>` y se ejecuta al abrirlo en el navegador. Un salón no necesita
        // subir vectores.
        expect(() => aPhoto({ mimeType: 'image/svg+xml' })).toThrow(BusinessRuleViolationError);
      });

      it('admite los formatos que salen de un móvil', () => {
        for (const mimeType of ['image/jpeg', 'image/png', 'image/webp', 'image/heic']) {
          expect(aPhoto({ mimeType }).mimeType).toBe(mimeType);
        }
      });

      it('rechaza un fichero vacío', () => {
        expect(() => aPhoto({ sizeBytes: 0 })).toThrow(DomainValidationError);
      });

      it('rechaza una huella que no es un SHA-256', () => {
        expect(() => aPhoto({ checksum: 'nada' })).toThrow(/SHA-256/);
      });

      it('rechaza una ruta de almacén vacía', () => {
        expect(() => aPhoto({ storageKey: '   ' })).toThrow(DomainValidationError);
      });
    });

    it('rechaza una foto con fecha futura', () => {
      // Siempre es un error de reloj o de zona horaria en el dispositivo, y desordena el
      // historial.
      expect(() => aPhoto({ takenAt: new Date('2027-01-01T00:00:00.000Z') })).toThrow(
        /posterior a hoy/,
      );
    });

    it('guarda el nombre original recortado y sin usarlo como ruta', () => {
      // El nombre solo se muestra. La ruta la construye el sistema: un nombre como
      // `../../otro-salon/foto.jpg` no debe poder influir en dónde acaba el fichero.
      const photo = aPhoto({ originalName: '../../otro-salon/foto.jpg' });

      expect(photo.originalName).toBe('../../otro-salon/foto.jpg');
      expect(photo.storageKey).toBe('tenants/t/clients/c/2026/09/photo-1.jpg');
    });
  });

  describe('descripción', () => {
    it('corrige el tipo y el pie', () => {
      const photo = aPhoto();
      photo.describe({ kind: 'AFTER', caption: '  Resultado final  ' }, NOW, 'user-2');

      expect(photo.kind).toBe('AFTER');
      expect(photo.caption).toBe('Resultado final');
    });

    it('permite vincularla a una cita después', () => {
      const photo = aPhoto();
      photo.describe({ appointmentId: 'appt-1', serviceId: 'srv-1' }, NOW, 'user-2');

      expect(photo.appointmentId).toBe('appt-1');
      expect(photo.serviceId).toBe('srv-1');
    });

    it('no deja modificar una foto dada de baja', () => {
      const photo = aPhoto();
      photo.markDeleted(NOW, 'user-1');

      expect(() => photo.describe({ kind: 'AFTER' }, NOW, 'user-1')).toThrow(
        BusinessRuleViolationError,
      );
    });

    it('rechaza una fecha futura al corregir', () => {
      expect(() =>
        aPhoto().describe({ takenAt: new Date('2027-01-01T00:00:00.000Z') }, NOW, 'user-1'),
      ).toThrow(DomainValidationError);
    });
  });

  describe('consentimiento de publicación', () => {
    it('se puede conceder y retirar', () => {
      // Un consentimiento es revocable por definición: una interfaz que solo permitiera
      // concederlo sería una que no respeta lo que dice pedir.
      const photo = aPhoto();

      photo.setMarketingConsent(true, NOW, 'user-1');
      expect(photo.isPublishable).toBe(true);

      photo.setMarketingConsent(false, NOW, 'user-1');
      expect(photo.isPublishable).toBe(false);
    });

    it('una foto dada de baja no es publicable aunque tenga permiso', () => {
      const photo = aPhoto({ consent: consent({ allowsMarketing: true }) });
      photo.markDeleted(NOW, 'user-1');

      expect(photo.isPublishable).toBe(false);
    });
  });

  describe('baja y purga', () => {
    it('la baja oculta pero no borra el fichero', () => {
      const photo = aPhoto();
      photo.markDeleted(NOW, 'user-1');

      expect(photo.isDeleted).toBe(true);
      expect(photo.isPurged).toBe(false);
      expect(photo.isViewable).toBe(true);
    });

    it('deshace una baja mientras el fichero siga existiendo', () => {
      const photo = aPhoto();
      photo.markDeleted(NOW, 'user-1');
      photo.markRestored(NOW, 'user-2');

      expect(photo.isDeleted).toBe(false);
    });

    it('exige la baja antes de purgar', () => {
      // Purgar una foto activa dejaría la galería mostrando un enlace roto, y borrar un dato
      // personal debe ser una decisión en dos tiempos y no un clic.
      expect(() => aPhoto().markPurged(NOW, 'user-1')).toThrow(/dar de baja/);
    });

    it('marca purgada y deja de ser visible', () => {
      const photo = aPhoto();
      photo.markDeleted(NOW, 'user-1');
      photo.markPurged(NOW, 'user-1');

      expect(photo.isPurged).toBe(true);
      expect(photo.isViewable).toBe(false);
    });

    it('purgar dos veces no cambia nada', () => {
      const photo = aPhoto();
      photo.markDeleted(NOW, 'user-1');
      photo.markPurged(NOW, 'user-1');
      const purgedAt = photo.purgedAt;

      photo.markPurged(new Date('2026-12-01T00:00:00.000Z'), 'user-2');

      expect(photo.purgedAt).toEqual(purgedAt);
    });

    it('no recupera una foto cuyo fichero ya no existe', () => {
      // Dejar que la fila volviera a estar activa daría una galería con huecos que nadie
      // sabría explicar.
      const photo = aPhoto();
      photo.markDeleted(NOW, 'user-1');
      photo.markPurged(NOW, 'user-1');

      expect(() => photo.markRestored(NOW, 'user-1')).toThrow(/eliminó definitivamente/);
    });
  });
});
