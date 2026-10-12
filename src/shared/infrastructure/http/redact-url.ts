/**
 * Ruta de la petición apta para el registro.
 *
 * Los enlaces públicos son credenciales: el de la cita deja a la clienta confirmar o
 * cancelar, y el de la pantalla de turnos muestra la fila del salón (ADR-0024). No se
 * escriben en los logs, ni en la línea de cada petición ni en la de los errores, porque una
 * vez que llegan al recolector de logs ya no se pueden retirar.
 */
export function redactUrl(url: string): string {
  return url.replace(/(\/public\/(?:appointment-links|queue-display)\/)[^/?]+/, '$1…');
}
