# ADR-0005: Autenticación JWT con refresh token rotativo

- **Estado:** Aceptado
- **Fecha:** 2026-09-02

## Contexto

La API es sin estado y la consumen SPA y clientes móviles. Se necesita sesión larga sin
que un token robado conceda acceso indefinido.

## Decisión

**Dos tokens con responsabilidades separadas:**

| | Access token | Refresh token |
| --- | --- | --- |
| Vida | 15 min | 7 días |
| Contenido | `sub`, `tenantId`, `roles`, `permissions`, `tv`, `jti` | `sub`, `jti`, `familyId` |
| Validación | Solo firma (sin consulta a BD) | Firma **+** consulta a `RefreshToken` |
| Almacenado | No | Sí, **hasheado con Argon2id** |

Decisiones específicas:

1. **Rotación en cada uso.** Refrescar invalida el refresh presentado y emite uno nuevo.
2. **Detección de reutilización.** Si llega un refresh ya rotado, se revoca la **familia
   completa** (`familyId`) y se audita: es la firma de un token robado.
3. **El refresh se guarda hasheado.** Un volcado de la tabla no permite suplantar a nadie.
4. **El access token no se consulta en BD** por diseño: la ventana de 15 minutos es el
   precio aceptado por no pagar un `SELECT` en cada petición.

   `tokenVersion` (claim `tv`) se compara contra la fila del usuario **al refrescar**,
   no en cada petición: hacerlo en cada petición reintroduciría exactamente el `SELECT`
   que este punto evita. Incrementarlo —al cambiar la contraseña, desactivar la cuenta o
   modificar los roles— corta de inmediato la capacidad de obtener tokens nuevos, y los
   access token ya emitidos caducan como mucho 15 minutos después.

   La consecuencia hay que decirla sin adornos: **existe una ventana de hasta 15 minutos
   en la que un access token de una cuenta ya revocada sigue siendo válido.** Es el
   compromiso consciente de este diseño. Si un caso de uso no lo tolerase (bloqueo por
   fraude, por ejemplo), la salida es una lista de revocación en memoria compartida
   consultada solo para los `jti` revocados, no un `SELECT` por petición.
5. **Contraseñas con Argon2id** (`memoryCost` 19 MiB, `timeCost` 2, `parallelism` 1),
   parámetros mínimos recomendados por OWASP. Nunca bcrypt ni SHA.
6. **Login con respuesta uniforme**: usuario inexistente y contraseña incorrecta devuelven
   el mismo error, y siempre se compara contra un hash señuelo cuando el usuario no existe,
   para no filtrar por tiempo qué correos están dados de alta.
7. **Bloqueo por intentos fallidos**: `failedLoginAttempts` y `lockedUntil` en `User`,
   con backoff. Complementa al rate limiting por IP (ADR-0007), que un atacante distribuido
   puede eludir.

## Consecuencias

- Un access token robado es válido como máximo 15 minutos, o menos si se incrementa
  `tokenVersion`.
- La tabla `RefreshToken` requiere purga periódica de expirados.
- El cliente debe implementar el reintento tras 401. Se documenta en el README.
- Los secretos de firma de access y refresh son **distintos**: un refresh no puede
  presentarse como access aunque se comprometa uno de los dos.

## Alternativas descartadas

- **Sesiones en servidor.** Requieren almacén compartido y rompen el escalado sin estado.
- **Solo access token de larga duración.** Imposible de revocar; inaceptable.
- **Refresh en cookie `HttpOnly`.** Mejor para SPA en el mismo dominio, pero no sirve a
  los clientes móviles previstos. El cliente web debe guardar el refresh en almacenamiento
  seguro; se documenta el riesgo de XSS y se mitiga con CSP en el frontend.
