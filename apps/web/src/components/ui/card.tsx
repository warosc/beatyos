import * as React from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'rounded-2xl border border-border bg-card text-card-foreground shadow-[0_1px_2px_rgb(20_20_20/0.03)]',
        className,
      )}
      {...props}
    />
  );
}
