import type { Metadata } from 'next';
import { MyDay } from '@/features/stylist-day/my-day';

export const metadata: Metadata = { title: 'Mi día' };

export default function Page() {
  return <MyDay />;
}
