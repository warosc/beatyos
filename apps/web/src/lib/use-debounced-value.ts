'use client';
import { useEffect, useState } from 'react';

/** Devuelve `value` cuando lleva `delay` ms sin cambiar: una consulta por pausa, no por tecla. */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
