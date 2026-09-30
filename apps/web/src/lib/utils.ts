import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const currency = new Intl.NumberFormat('es-GT', {
  style: 'currency',
  currency: 'GTQ',
  maximumFractionDigits: 0,
});

const withCents = new Intl.NumberFormat('es-GT', { style: 'currency', currency: 'GTQ' });

/** Importe en quetzales con céntimos, tal como se cobra. `currency` redondea a unidades. */
export const money = (amount: string | number) => withCents.format(Number(amount));
