'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Store } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAccess } from '@/components/session-access';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { problem } from '@/features/service-tickets/types';
import { fetchTenantProfile, TENANT_PROFILE_KEY } from '@/features/sales/types';
import { applyBrand, asBrand, BRANDS, DEFAULT_BRAND } from '@/lib/brand';
import { sessionFetch } from '@/lib/session-fetch';

const FIELDS = [
  { name: 'name', label: 'Nombre comercial', hint: 'Encabeza el comprobante', max: 120 },
  { name: 'legalName', label: 'Razón social', hint: 'Si es distinta del nombre', max: 160 },
  { name: 'taxId', label: 'NIT', max: 20 },
  { name: 'phone', label: 'Teléfono', max: 30 },
  { name: 'addressLine', label: 'Dirección', hint: 'Por ejemplo: Zona 4 de Mixco', max: 200 },
  { name: 'city', label: 'Ciudad', max: 80 },
  { name: 'email', label: 'Correo', max: 160 },
] as const;

/**
 * Identidad del salón: lo que sale impreso en los comprobantes y los cortes de caja, y los
 * colores con los que todo el equipo ve la aplicación.
 */
export function SalonProfile() {
  const { can } = useAccess();
  const qc = useQueryClient();
  const profile = useQuery({
    queryKey: TENANT_PROFILE_KEY,
    enabled: can('settings.update'),
    queryFn: fetchTenantProfile,
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  if (!can('settings.update')) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const brandTheme = asBrand(String(form.get('brandTheme'))) ?? DEFAULT_BRAND;
    setBusy(true);
    setNotice(null);
    const response = await sessionFetch('/api/tenant/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...Object.fromEntries(FIELDS.map(({ name }) => [name, form.get(name)])),
        receiptNote: form.get('receiptNote'),
        brandTheme,
      }),
    });
    setBusy(false);
    if (!response.ok) {
      setNotice({ ok: false, text: await problem(response, 'No se pudieron guardar los datos.') });
      return;
    }
    applyBrand(brandTheme);
    await qc.invalidateQueries({ queryKey: TENANT_PROFILE_KEY });
    setNotice({ ok: true, text: 'Datos del salón guardados.' });
  }

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-display text-xl font-semibold">
        <Store size={20} className="text-primary" />
        Datos del salón
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Salen impresos en los comprobantes de venta y en los cortes de caja.
      </p>
      {profile.error ? (
        <p role="alert" className="mt-4 text-sm text-danger">
          {profile.error.message}
        </p>
      ) : profile.data ? (
        <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <label key={field.name} className="text-sm font-medium">
              {field.label}
              {'hint' in field && (
                <span className="ml-1 font-normal text-muted-foreground">· {field.hint}</span>
              )}
              <input
                name={field.name}
                type={field.name === 'email' ? 'email' : 'text'}
                required={field.name === 'name' || field.name === 'email'}
                maxLength={field.max}
                defaultValue={profile.data[field.name] ?? ''}
                className="mt-1 h-11 w-full rounded-xl border bg-background px-3 font-normal"
              />
            </label>
          ))}
          <label className="text-sm font-medium sm:col-span-2">
            Texto adicional del comprobante
            <span className="ml-1 font-normal text-muted-foreground">
              · Opcional: redes, horario o un mensaje para la clienta
            </span>
            <textarea
              name="receiptNote"
              maxLength={200}
              rows={2}
              defaultValue={profile.data.receiptNote ?? ''}
              placeholder="Por ejemplo: Síguenos en Instagram @tusalon"
              className="mt-1 w-full rounded-xl border bg-background p-3 font-normal"
            />
          </label>

          <fieldset className="sm:col-span-2">
            <legend className="text-sm font-medium">
              Colores del salón
              <span className="ml-1 font-normal text-muted-foreground">
                · Los ve todo el equipo al entrar
              </span>
            </legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {BRANDS.map((brand) => (
                <label
                  key={brand.id}
                  className="flex cursor-pointer items-center gap-3 rounded-xl border bg-background p-3 has-checked:border-primary has-checked:ring-2 has-checked:ring-primary/30"
                >
                  <input
                    type="radio"
                    name="brandTheme"
                    value={brand.id}
                    defaultChecked={
                      (asBrand(profile.data.brandTheme) ?? DEFAULT_BRAND) === brand.id
                    }
                    className="sr-only"
                  />
                  <span aria-hidden className="flex shrink-0 -space-x-2">
                    {brand.swatches.map((color) => (
                      <span
                        key={color}
                        className="size-7 rounded-full border-2 border-card"
                        style={{ background: color }}
                      />
                    ))}
                  </span>
                  <span className="min-w-0 leading-tight">
                    <span className="block text-sm font-semibold">{brand.label}</span>
                    <span className="block text-xs text-muted-foreground">{brand.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex items-center justify-end gap-3 sm:col-span-2">
            {notice && (
              <p
                role={notice.ok ? 'status' : 'alert'}
                className={notice.ok ? 'text-sm text-success' : 'text-sm text-danger'}
              >
                {notice.text}
              </p>
            )}
            <Button disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</Button>
          </div>
        </form>
      ) : (
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          Cargando…
        </p>
      )}
    </Card>
  );
}
