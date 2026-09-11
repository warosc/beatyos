-- Identificador del JWT de refresco (claim `jti`).
--
-- El token se persiste hasheado (ADR-0005), de modo que no se puede consultar por su
-- valor. El `jti` viaja en claro dentro del JWT firmado y hace de clave de busqueda; el
-- hash confirma despues la posesion del token completo. Es la misma separacion que entre
-- un nombre de usuario y su contrasena.
--
-- Se mantiene aparte de `id` para no exponer la clave primaria de la tabla en un valor
-- que viaja al cliente.
--
-- La columna entra como NOT NULL sin valor por defecto porque la tabla esta vacia: esta
-- migracion se aplica antes de la primera puesta en produccion.
ALTER TABLE "refresh_tokens" ADD COLUMN "jti" TEXT NOT NULL;

CREATE UNIQUE INDEX "refresh_tokens_jti_key" ON "refresh_tokens"("jti");
