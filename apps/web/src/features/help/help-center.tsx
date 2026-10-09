'use client';
import Image from 'next/image';
import Link from 'next/link';
import { useAccess } from '@/components/session-access';
import { Card } from '@/components/ui/card';

const guides = [
  {
    image: '/help/agenda.svg',
    title: 'Agenda tu primera cita',
    text: 'Abre Agenda, elige clienta, profesional, fecha y servicios. El sistema valida jornada, ausencias y cruces.',
    href: '/agenda',
    permissions: ['appointments.create', 'appointments.create.own'],
  },
  {
    image: '/help/clientes.svg',
    title: 'Consulta clientes con privacidad',
    text: 'La ficha muestra solo los datos permitidos para tu rol. La información de contacto y gasto está protegida.',
    href: '/clientes',
    permissions: ['clients.read'],
  },
  {
    image: '/help/caja.svg',
    title: 'Abre, opera y cierra caja',
    text: 'Registra el fondo inicial, movimientos y el efectivo contado. La propietaria puede revisar quién abrió cada turno.',
    href: '/caja',
    permissions: ['cash.read'],
  },
  {
    image: '/help/caja.svg',
    title: 'Cobra en Ventas sin soltar el teclado',
    text: 'Escribe el nombre, SKU o código de barras y pulsa Enter para agregar. Asigna la profesional de cada línea, cobra con F2 y anota lo que entrega la clienta: el vuelto se calcula solo. También puedes dividir el pago entre efectivo y tarjeta.',
    href: '/ventas',
    permissions: ['invoices.create'],
  },
  {
    image: '/help/caja.svg',
    title: 'Cuadra el día: Ventas y Caja',
    text: 'Ventas registra todo lo vendido, con cualquier método de pago; Caja es solo el efectivo del turno. En Ventas realizadas ves lo cobrado por efectivo, tarjeta y transferencia, reimprimes comprobantes y la propietaria anula una venta equivocada: el efectivo sale de la caja abierta y el producto vuelve al inventario. Al cerrar caja, compara la tarjeta con el cierre del datáfono e imprime el corte.',
    href: '/ventas/historial',
    permissions: ['invoices.read'],
  },
  {
    image: '/help/agenda.svg',
    title: 'Registra lo que le hiciste a cada clienta',
    text: 'En Mi día ves a quién atiendes ahora: cuando llega la hora de la cita aparece sola. Toca «Registrar lo que le hice», marca los servicios (los reservados ya vienen marcados) y envíalo a caja. Tú no cobras: caja lo recibe al instante. Si se te pasa alguna, el menú te lo recuerda.',
    href: '/mi-dia',
    permissions: ['service-tickets.create.own'],
  },
  {
    image: '/help/equipo.svg',
    title: 'Configura servicios y jornadas',
    text: 'Define comisiones, agrega o retira servicios, asigna qué servicios realiza cada profesional y registra descansos, vacaciones y horarios.',
    href: '/comisiones',
    permissions: ['services.update', 'stylists.manage-schedule'],
  },
];
export function HelpCenter() {
  const { can } = useAccess();
  const visible = guides.filter((g) => g.permissions.some((permission) => can(permission)));
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-primary">Centro de ayuda</p>
        <h1 className="mt-1 font-display text-4xl font-semibold">Primeros pasos en BeautyOS</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Estas guías se adaptan a las funciones disponibles para tu usuario.
        </p>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        {visible.map((g) => (
          <Card key={g.title} className="overflow-hidden">
            <Image
              src={g.image}
              alt=""
              width={800}
              height={360}
              className="h-44 w-full object-cover"
            />
            <div className="p-5">
              <h2 className="font-display text-xl font-semibold">{g.title}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{g.text}</p>
              <Link
                href={g.href}
                className="mt-4 inline-flex min-h-10 items-center font-semibold text-primary"
              >
                Ir a la sección →
              </Link>
            </div>
          </Card>
        ))}
      </div>
      <Card className="p-6">
        <h2 className="font-display text-xl font-semibold">Consejos rápidos</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-muted-foreground">
          <li>
            Si una cita no cabe en la jornada, cambia la fecha u hora y vuelve a reservar sin cerrar
            la ventana.
          </li>
          <li>
            Los precios de venta se muestran al equipo; los costos quedan reservados a los roles
            autorizados.
          </li>
          <li>
            En Ventas: <kbd>/</kbd> busca, <kbd>↑</kbd> <kbd>↓</kbd> eligen, <kbd>Enter</kbd>{' '}
            agrega, <kbd>F2</kbd> cobra y <kbd>Esc</kbd> cierra la ventana abierta.
          </li>
          <li>
            Una ausencia bloquea automáticamente la disponibilidad de la profesional durante ese
            período.
          </li>
        </ul>
      </Card>
    </div>
  );
}
