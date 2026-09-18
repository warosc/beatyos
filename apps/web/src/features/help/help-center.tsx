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
    text: 'La ficha muestra solo los datos permitidos para tu rol. La informaciÃ³n de contacto y gasto estÃ¡ protegida.',
    href: '/clientes',
    permissions: ['clients.read'],
  },
  {
    image: '/help/caja.svg',
    title: 'Abre, opera y cierra caja',
    text: 'Registra el fondo inicial, movimientos y el efectivo contado. La propiedad puede auditar quiÃ©n abriÃ³ cada turno.',
    href: '/caja',
    permissions: ['cash.read'],
  },
  {
    image: '/help/equipo.svg',
    title: 'Configura servicios y jornadas',
    text: 'Define comisiones, agrega o retira servicios y registra descansos, vacaciones y horarios por profesional.',
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
          Estas guÃ­as se adaptan a las funciones disponibles para tu usuario.
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
                Ir a la secciÃ³n â†’
              </Link>
            </div>
          </Card>
        ))}
      </div>
      <Card className="p-6">
        <h2 className="font-display text-xl font-semibold">Consejos rÃ¡pidos</h2>
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
            Una ausencia bloquea automÃ¡ticamente la disponibilidad del profesional durante ese
            perÃ­odo.
          </li>
        </ul>
      </Card>
    </div>
  );
}
