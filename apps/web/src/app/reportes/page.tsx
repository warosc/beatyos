import type { Metadata } from 'next';
import { ExecutiveReportView } from '@/features/reports/executive-report';
export const metadata: Metadata = { title: 'Reportes ejecutivos' };
export default function Page() {
  return <ExecutiveReportView />;
}
