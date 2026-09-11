import { DomainValidationError } from '@shared/domain/errors';
import { Email, PersonName, Phone } from '@shared/domain/value-objects/contact.vo';
import { aUser, OWNER_ROLE, RECEPTIONIST_ROLE, STYLIST_ROLE } from '@test/builders/user.builder';

import { User } from './user.entity';
import {
  AccountLockedError,
  AccountNotActiveError,
  SamePasswordError,
  WeakPasswordError,
} from './user.errors';

describe('User', () => {
  const NOW = new Date('2026-09-02T10:00:00.000Z');

  describe('alta', () => {
    it('crea un usuario activo con versión de token en cero', () => {
      const user = User.create({
        id: 'u-1',
        tenantId: 'tenant-1',
        email: Email.create('ana@salon.es'),
        passwordHash: '$fake$Clave',
        name: PersonName.create('Ana', 'García'),
        now: NOW,
        actorId: 'admin',
      });

      expect(user.status).toBe('ACTIVE');
      expect(user.tokenVersion).toBe(0);
      expect(user.failedLoginAttempts).toBe(0);
      expect(user.roles).toEqual([]);
      expect(user.audit.createdBy).toBe('admin');
    });

    it('admite teléfono, idioma y estado inicial explícitos', () => {
      const user = User.create({
        id: 'u-2',
        tenantId: null,
        email: Email.create('admin@plataforma.es'),
        passwordHash: '$fake$Clave',
        name: PersonName.create('Ada', 'Lovelace'),
        phone: Phone.create('+34600111222'),
        locale: 'en-GB',
        status: 'PENDING_VERIFICATION',
        roles: [OWNER_ROLE],
        now: NOW,
        actorId: null,
      });

      expect(user.phone?.value).toBe('+34600111222');
      expect(user.locale).toBe('en-GB');
      expect(user.status).toBe('PENDING_VERIFICATION');
      // `tenantId` nulo identifica a una cuenta de plataforma (ADR-0003).
      expect(user.tenantId).toBeNull();
    });
  });

  describe('permisos efectivos', () => {
    it('son la unión de los de todos sus roles', () => {
      const user = aUser().withRoles(RECEPTIONIST_ROLE, STYLIST_ROLE).build();

      // Unión y no intersección: sumar un rol siempre concede, nunca quita. Lo contrario
      // haría que dar más permisos a alguien pudiera reducirle el acceso.
      expect(user.effectivePermissions).toContain('appointments.create');
      expect(user.effectivePermissions).toContain('appointments.read.own');
    });

    it('no repite un permiso presente en dos roles', () => {
      const user = aUser().withRoles(RECEPTIONIST_ROLE, STYLIST_ROLE).build();
      const readCount = user.effectivePermissions.filter((p) => p === 'clients.read').length;
      expect(readCount).toBe(1);
    });

    it('vienen ordenados, para que el token sea reproducible', () => {
      const user = aUser().withRoles(OWNER_ROLE).build();
      expect(user.effectivePermissions).toEqual([...user.effectivePermissions].sort());
    });

    it('hasPermission responde sobre los permisos concretos', () => {
      const user = aUser().withRoles(STYLIST_ROLE).build();
      expect(user.hasPermission('appointments.read.own')).toBe(true);
      expect(user.hasPermission('reports.financial')).toBe(false);
    });

    it('el comodín concede cualquier permiso', () => {
      const user = aUser()
        .withRoles({ id: 'r', code: 'PLATFORM_ADMIN', permissions: ['*'] })
        .build();

      expect(user.hasPermission('lo.que.sea')).toBe(true);
    });

    it('expone los códigos de rol', () => {
      expect(aUser().withRoles(OWNER_ROLE, STYLIST_ROLE).build().roleCodes).toEqual([
        'OWNER',
        'STYLIST',
      ]);
    });
  });

  describe('reglas de acceso', () => {
    it('una cuenta activa puede autenticarse', () => {
      expect(() => aUser().build().assertCanAuthenticate(NOW)).not.toThrow();
    });

    it('una cuenta inactiva no', () => {
      expect(() => aUser().inactive().build().assertCanAuthenticate(NOW)).toThrow(
        AccountNotActiveError,
      );
    });

    it('una cuenta eliminada no está activa', () => {
      expect(aUser().deleted().build().isActive()).toBe(false);
    });

    it('el bloqueo se comprueba antes que el estado', () => {
      // Verificar Argon2 cuesta CPU a propósito; comprobar el bloqueo primero evita
      // gastarla en cuentas que no van a entrar.
      const locked = aUser()
        .inactive()
        .locked(new Date(NOW.getTime() + 60_000))
        .build();

      expect(() => locked.assertCanAuthenticate(NOW)).toThrow(AccountLockedError);
    });

    it('un bloqueo caducado ya no impide el acceso', () => {
      const user = aUser()
        .locked(new Date(NOW.getTime() - 60_000))
        .build();

      expect(user.isLocked(NOW)).toBe(false);
      expect(() => user.assertCanAuthenticate(NOW)).not.toThrow();
    });

    it('el mensaje de bloqueo indica cuánto falta', () => {
      const user = aUser()
        .locked(new Date(NOW.getTime() + 10 * 60_000))
        .build();

      // Quien ha fallado tres veces merece saber cuánto esperar, no creer que el sistema
      // está roto. A estas alturas ya ha demostrado conocer una cuenta existente.
      expect(() => user.assertCanAuthenticate(NOW)).toThrow(/minutos/);
    });
  });

  describe('intentos fallidos', () => {
    it('acumula intentos sin bloquear hasta el umbral', () => {
      const user = aUser().build();

      user.registerFailedLogin(NOW, 5, 15);
      user.registerFailedLogin(NOW, 5, 15);

      expect(user.failedLoginAttempts).toBe(2);
      expect(user.isLocked(NOW)).toBe(false);
    });

    it('bloquea al alcanzar el umbral, de forma temporal', () => {
      const user = aUser().withFailedAttempts(4).build();

      user.registerFailedLogin(NOW, 5, 15);

      expect(user.isLocked(NOW)).toBe(true);
      // Temporal y no permanente: un bloqueo indefinido convertiría el formulario de
      // acceso en una herramienta de denegación de servicio contra cuentas ajenas.
      expect(user.lockedUntil).toEqual(new Date(NOW.getTime() + 15 * 60_000));
    });

    it('un acceso correcto limpia el contador y el bloqueo', () => {
      const user = aUser().withFailedAttempts(3).build();

      user.registerSuccessfulLogin(NOW);

      expect(user.failedLoginAttempts).toBe(0);
      expect(user.lockedUntil).toBeNull();
      expect(user.lastLoginAt).toEqual(NOW);
    });
  });

  describe('contraseña', () => {
    it('cambiarla invalida todas las sesiones abiertas', () => {
      const user = aUser().withPassword('Antigua').withTokenVersion(3).build();

      user.changePassword('$fake$Nueva', NOW, 'u-1');

      // Cambiar la contraseña suele ser la reacción a sospechar que la han comprometido:
      // dejar vivas las sesiones haría inútil el cambio justo cuando más importa.
      expect(user.tokenVersion).toBe(4);
      expect(user.passwordHash).toBe('$fake$Nueva');
    });

    it('rechaza reutilizar la contraseña actual', () => {
      const user = aUser().withPassword('Actual').build();
      expect(() => user.changePassword('$fake$Actual', NOW, 'u-1')).toThrow(SamePasswordError);
    });

    it('el rehash silencioso NO cierra las sesiones', () => {
      const user = aUser().withTokenVersion(2).build();

      user.upgradePasswordHash('$argon2id$nuevo', NOW);

      // La contraseña es la misma; solo cambia cómo se almacena. Cerrar la sesión aquí
      // castigaría al usuario por una mejora interna del sistema.
      expect(user.tokenVersion).toBe(2);
      expect(user.passwordHash).toBe('$argon2id$nuevo');
    });

    describe('política de fortaleza', () => {
      it('acepta una frase larga sin caracteres especiales', () => {
        expect(() => User.validatePasswordStrength('MiSalonFavorito2026')).not.toThrow();
      });

      it('rechaza contraseñas cortas', () => {
        expect(() => User.validatePasswordStrength('Corta1')).toThrow(WeakPasswordError);
      });

      it('enumera TODOS los requisitos incumplidos de una vez', () => {
        // Devolverlos uno a uno obligaría al usuario a reintentar cuatro veces.
        try {
          User.validatePasswordStrength('aaaaaaaaaaaa');
          fail('se esperaba WeakPasswordError');
        } catch (error) {
          const reasons = (error as WeakPasswordError).details?.reasons as string[];
          expect(reasons).toHaveLength(2);
        }
      });

      it('exige mayúscula, minúscula y dígito', () => {
        // El mensaje es genérico a propósito; el detalle va en `details.reasons`, que es
        // lo que la interfaz muestra campo a campo.
        const reasonsFor = (password: string): string[] => {
          try {
            User.validatePasswordStrength(password);
            return [];
          } catch (error) {
            return ((error as WeakPasswordError).details?.reasons as string[]) ?? [];
          }
        };

        expect(reasonsFor('todominuscula1').join(' ')).toMatch(/mayúscula/);
        expect(reasonsFor('TODOMAYUSCULA1').join(' ')).toMatch(/minúscula/);
        expect(reasonsFor('SinNumerosAqui').join(' ')).toMatch(/número/);
      });

      it('admite una política a medida', () => {
        expect(() =>
          User.validatePasswordStrength('corta', {
            minLength: 4,
            requireUppercase: false,
            requireLowercase: false,
            requireDigit: false,
          }),
        ).not.toThrow();
      });
    });
  });

  describe('ciclo de vida', () => {
    it('actualiza el perfil sin tocar lo no indicado', () => {
      const user = aUser().withPhone('+34600111222').build();

      user.updateProfile({ locale: 'ca-ES' }, NOW, 'admin');

      expect(user.locale).toBe('ca-ES');
      expect(user.phone?.value).toBe('+34600111222');
    });

    it('permite vaciar el teléfono con null', () => {
      const user = aUser().withPhone('+34600111222').build();
      user.updateProfile({ phone: null }, NOW, 'admin');
      expect(user.phone).toBeNull();
    });

    it('cambiar de correo cierra las sesiones y marca el correo sin verificar', () => {
      const user = aUser().withEmail('vieja@salon.es').withTokenVersion(1).build();

      user.changeEmail(Email.create('nueva@salon.es'), NOW, 'admin');

      // El correo es el identificador de acceso: cambiarlo equivale a cambiar credencial.
      expect(user.email.value).toBe('nueva@salon.es');
      expect(user.tokenVersion).toBe(2);
      expect(user.emailVerifiedAt).toBeNull();
    });

    it('cambiar al mismo correo no hace nada', () => {
      const user = aUser().withEmail('ana@salon.es').withTokenVersion(1).build();
      user.changeEmail(Email.create('ANA@salon.es'), NOW, 'admin');
      expect(user.tokenVersion).toBe(1);
    });

    it('desactivar corta el acceso de inmediato', () => {
      const user = aUser().withTokenVersion(0).build();

      user.deactivate(NOW, 'admin');

      expect(user.status).toBe('INACTIVE');
      // Sin subir la versión, la persona seguiría trabajando hasta que caducara su token.
      expect(user.tokenVersion).toBe(1);
    });

    it('reactivar limpia bloqueos e intentos', () => {
      const user = aUser()
        .inactive()
        .locked(new Date(NOW.getTime() + 60_000))
        .build();

      user.activate(NOW, 'admin');

      expect(user.status).toBe('ACTIVE');
      expect(user.lockedUntil).toBeNull();
      expect(user.failedLoginAttempts).toBe(0);
    });

    it('verificar el correo activa una cuenta pendiente', () => {
      const user = aUser().withStatus('PENDING_VERIFICATION').build();

      user.markEmailVerified(NOW);

      expect(user.emailVerifiedAt).toEqual(NOW);
      expect(user.status).toBe('ACTIVE');
    });

    it('verificar el correo no reactiva una cuenta desactivada a propósito', () => {
      const user = aUser().inactive().build();
      user.markEmailVerified(NOW);
      expect(user.status).toBe('INACTIVE');
    });

    it('reasignar roles invalida las sesiones', () => {
      const user = aUser().withRoles(STYLIST_ROLE).withTokenVersion(0).build();

      user.assignRoles([OWNER_ROLE], NOW, 'admin');

      expect(user.roleCodes).toEqual(['OWNER']);
      // Los permisos viajan dentro del token: sin subir la versión, retirar un permiso
      // no tendría efecto durante hasta quince minutos.
      expect(user.tokenVersion).toBe(1);
    });

    it('no se puede dejar a un usuario sin ningún rol', () => {
      const user = aUser().build();
      expect(() => user.assignRoles([], NOW, 'admin')).toThrow(DomainValidationError);
    });

    it('revocar sesiones sube la versión sin tocar nada más', () => {
      const user = aUser().withTokenVersion(5).build();

      user.revokeAllSessions(NOW);

      expect(user.tokenVersion).toBe(6);
      expect(user.status).toBe('ACTIVE');
    });
  });
});
