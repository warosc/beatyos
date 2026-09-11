export interface Appointment {
  id: string;
  clientId: string;
  stylistId: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  status: string;
  estimatedTotal: string;
  currency: string;
  services: { serviceId: string }[];
}
export interface Stylist {
  id: string;
  displayName: string;
  color: string;
  isBookable: boolean;
}
export interface Service {
  id: string;
  name: string;
  blockedMinutes: number;
  priceWithTax: string;
  currency: string;
  isBookable: boolean;
}
export interface AgendaClient {
  id: string;
  fullName: string;
  phone: string | null;
}
