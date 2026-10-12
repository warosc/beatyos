'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Volume2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { readSignals } from '@/features/agenda/live';
import { problem } from '@/features/service-tickets/types';
import { cn } from '@/lib/utils';
import { announcement, approximateWait, callKey, type QueueDisplay } from './types';

/** Cuánto se destaca una llamada nueva antes de quedar como las demás. */
const HIGHLIGHT_MS = 12_000;

/**
 * Pantalla de turnos de la sala (ADR-0024): la TV del salón.
 *
 * Se abre con el enlace que crea la encargada y se queda encendida todo el día. Enseña a
 * quién se acaba de llamar —número, nombre corto y con quién— y los números que esperan.
 * Con cada llamada nueva, o cuando la vuelven a llamar, suena una campanita y una voz lo
 * dice: «Turno 7. Ana G., pase con Sara».
 *
 * Los navegadores no dejan sonar nada hasta que alguien toca la pantalla, por eso arranca
 * con un botón para activar el sonido. El mismo toque la pone a pantalla completa y le pide
 * que no se apague.
 */
export function QueueDisplayScreen({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const key = ['queue-display', token];
  const [soundOn, setSoundOn] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [fresh, setFresh] = useState<string | null>(null);
  const audio = useRef<AudioContext | null>(null);
  /** Llamadas ya anunciadas. La primera carga las da todas por anunciadas. */
  const announced = useRef<Set<string> | null>(null);

  const display = useQuery({
    queryKey: key,
    // Red de seguridad del canal en vivo: si un aviso se pierde, llega igual al minuto.
    refetchInterval: 60_000,
    retry: (count, error) => !/no es válido|no se encontró/i.test(error.message) && count < 3,
    queryFn: async () => {
      const response = await fetch(`/api/public/queue-display/${encodeURIComponent(token)}`, {
        cache: 'no-store',
      });
      if (!response.ok)
        throw new Error(await problem(response, 'No pudimos cargar la fila del salón.'));
      return ((await response.json()) as { data: QueueDisplay }).data;
    },
  });

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);

  // Con el enlace retirado no hay nada que escuchar: la vista ya explica qué pasa.
  useDisplayLive(
    token,
    !display.error,
    () => void queryClient.invalidateQueries({ queryKey: key }),
  );

  const calls = display.data?.called;
  useEffect(() => {
    if (!calls) return;
    if (!announced.current) {
      announced.current = new Set(calls.map(callKey));
      return;
    }
    const seen = announced.current;
    // De la más antigua a la más reciente: si llegan dos a la vez, se oyen en orden.
    const pending = [...calls].reverse().filter((call) => !seen.has(callKey(call)));
    for (const call of pending) {
      seen.add(callKey(call));
      if (soundOn) announce(audio.current, announcement(call));
    }
    if (pending.length) {
      const latest = pending.at(-1)!;
      setFresh(callKey(latest));
      const timer = setTimeout(() => setFresh(null), HIGHLIGHT_MS);
      return () => clearTimeout(timer);
    }
  }, [calls, soundOn]);

  async function activate() {
    try {
      audio.current ??= new AudioContext();
      await audio.current.resume();
      chime(audio.current);
    } catch {
      /* Sin audio la pantalla sigue sirviendo: se ve igual. */
    }
    setSoundOn(true);
    await document.documentElement.requestFullscreen?.().catch(() => undefined);
    await keepAwake();
  }

  if (display.error) {
    return (
      <main className="grid min-h-dvh place-items-center bg-background p-8 text-center">
        <div className="max-w-lg space-y-3">
          <h1 className="font-display text-4xl font-semibold">Pantalla de turnos</h1>
          <p className="text-lg text-muted-foreground">
            {/no es válido|no se encontró/i.test(display.error.message)
              ? 'Este enlace ya no es válido. Pide uno nuevo en Turnos → Pantalla de la TV.'
              : display.error.message}
          </p>
        </div>
      </main>
    );
  }

  const data = display.data;
  const [latest, ...earlier] = data?.called ?? [];

  return (
    <main className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex items-center justify-between gap-6 border-b px-10 py-6">
        <h1 className="font-display text-4xl font-semibold">{data?.salonName ?? 'Turnos'}</h1>
        <p className="text-4xl font-semibold tabular-nums" aria-label="Hora">
          {now.toLocaleTimeString('es-GT', { hour: '2-digit', minute: '2-digit' })}
        </p>
      </header>

      <div className="grid flex-1 gap-8 p-10 lg:grid-cols-[2fr_1fr]">
        <section aria-live="polite" className="flex flex-col gap-6">
          <h2 className="text-2xl font-bold tracking-widest text-primary uppercase">Llamando</h2>
          {latest ? (
            <div
              className={cn(
                'rounded-3xl border-4 bg-card p-10 shadow-sm transition',
                fresh === callKey(latest) ? 'animate-pulse border-primary' : 'border-border',
              )}
            >
              <p className="text-3xl text-muted-foreground">Turno</p>
              <p className="text-[9rem] leading-none font-bold tabular-nums">{latest.number}</p>
              <p className="mt-4 text-6xl font-semibold">{latest.publicName}</p>
              <p className="mt-3 text-4xl text-muted-foreground">
                pase con <strong className="text-foreground">{latest.stylistName}</strong>
              </p>
            </div>
          ) : (
            <p className="rounded-3xl border-4 border-dashed p-10 text-4xl text-muted-foreground">
              {display.isPending ? 'Cargando…' : 'Te llamaremos aquí por tu número y tu nombre.'}
            </p>
          )}
          {earlier.length > 0 && (
            <ul className="grid gap-3 sm:grid-cols-3">
              {earlier.map((call) => (
                <li key={call.id} className="rounded-2xl bg-card p-5">
                  <p className="text-4xl font-bold tabular-nums">{call.number}</p>
                  <p className="truncate text-2xl">{call.publicName}</p>
                  <p className="truncate text-xl text-muted-foreground">con {call.stylistName}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-6">
          <h2 className="text-2xl font-bold tracking-widest text-muted-foreground uppercase">
            En espera {data ? `(${data.waitingCount})` : ''}
          </h2>
          {data && data.waiting.length > 0 ? (
            <ul className="grid grid-cols-3 gap-3">
              {data.waiting.map((number) => (
                <li
                  key={number}
                  className="rounded-2xl bg-secondary py-4 text-center text-4xl font-bold text-secondary-foreground tabular-nums"
                >
                  {number}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-2xl text-muted-foreground">Nadie en espera.</p>
          )}
          {data && data.waitingCount > data.waiting.length && (
            <p className="text-xl text-muted-foreground">
              y {data.waitingCount - data.waiting.length} más
            </p>
          )}
          {/* Solo con varias llamadas de hoy detrás: con una sería una promesa, no una media. */}
          {data?.estimatedWaitMinutes != null && data.waitingCount > 0 && (
            <p className="rounded-2xl bg-card p-6 text-2xl">
              Espera aproximada
              <strong className="mt-1 block text-5xl">
                {approximateWait(data.estimatedWaitMinutes)}
              </strong>
            </p>
          )}
        </section>
      </div>

      {!soundOn && (
        <button
          type="button"
          onClick={() => void activate()}
          className="fixed bottom-8 left-8 inline-flex items-center gap-3 rounded-2xl bg-primary px-8 py-5 text-2xl font-semibold text-primary-foreground shadow-lg"
        >
          <Volume2 size={28} />
          Activar sonido
        </button>
      )}
    </main>
  );
}

/**
 * Canal en vivo de la pantalla. Como el de la agenda, se reconecta con espera creciente si
 * se corta —un reinicio de la API, el wifi de la sala—, y al volver refresca por si perdió
 * algo.
 *
 * La espera solo vuelve a cero cuando llega un aviso de verdad (también el latido): un canal
 * que se abre y se cierra sin decir nada no cuenta como conexión buena, y reintentar al
 * instante convertiría un fallo en un bucle contra el servidor.
 */
function useDisplayLive(token: string, enabled: boolean, onChange: () => void) {
  const callback = useRef(onChange);
  useEffect(() => {
    callback.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = async (): Promise<void> => {
      if (controller.signal.aborted) return;
      try {
        const response = await fetch(
          `/api/public/queue-display/${encodeURIComponent(token)}/stream`,
          {
            signal: controller.signal,
            cache: 'no-store',
            headers: { Accept: 'text/event-stream' },
          },
        );
        if (response.status === 404) return; // Enlace retirado: la vista ya lo explica.
        if (response.ok && response.body) {
          if (attempt > 0) callback.current();
          await readSignals(response.body, (signal) => {
            attempt = 0;
            if (signal.kind === 'queue') callback.current();
          });
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      attempt += 1;
      timer = setTimeout(() => void connect(), Math.min(30_000, 1_000 * 2 ** attempt));
    };

    void connect();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [token, enabled]);
}

/** Campanita de dos tonos, como la de cualquier sala de espera. */
const CHIME = [
  { frequency: 880, offset: 0 },
  { frequency: 660, offset: 0.35 },
];

function chime(context: AudioContext) {
  const start = context.currentTime;
  for (const { frequency, offset } of CHIME) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.4, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.6);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.65);
  }
}

/** Campanita y, tras ella, la voz. Sin voces en español instaladas, solo la campanita. */
function announce(context: AudioContext | null, text: string) {
  if (context) chime(context);
  if (typeof speechSynthesis === 'undefined') return;
  const utterance = new SpeechSynthesisUtterance(text);
  const voice = speechSynthesis.getVoices().find((candidate) => candidate.lang.startsWith('es'));
  if (voice) utterance.voice = voice;
  utterance.lang = voice?.lang ?? 'es-GT';
  utterance.rate = 0.9;
  setTimeout(() => speechSynthesis.speak(utterance), 900);
}

/** Pide que la pantalla no se apague. Si el navegador no sabe, lo dirá el reposo de la TV. */
async function keepAwake() {
  try {
    const lock = await navigator.wakeLock?.request('screen');
    // Al volver a la pestaña el bloqueo se pierde: se pide otra vez.
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'visible') void keepAwake();
      },
      { once: true },
    );
    return lock;
  } catch {
    return undefined;
  }
}
