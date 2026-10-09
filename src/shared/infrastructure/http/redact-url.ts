/**
 * Ruta de la petición apta para el registro.
 *
 * El enlace de la cita es la credencial de la clienta: quien lo tenga puede confirmar o
 * cancelar su cita. No se escribe en los logs, ni en la línea de cada petición ni en la de
 * los errores, porque una vez que llega al recolector de logs ya no se puede retirar.
 */
export function redactUrl(url: string): string {
  return url.replace(/(\/public\/appointment-links\/)[^/?]+/, '$1…');
}
