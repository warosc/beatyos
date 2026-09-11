export interface Client {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  birthDate: string | null;
  age: number | null;
  gender: string | null;
  notes: string | null;
  allergies: string | null;
  city: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'BLOCKED';
  marketingConsent: boolean;
  loyaltyPoints: number;
  totalVisits: number;
  totalSpent: string;
  currency: string;
  lastVisitAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientPage {
  data: Client[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
  };
}
