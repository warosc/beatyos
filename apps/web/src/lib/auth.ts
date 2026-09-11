export interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  tenantId: string | null;
  roles: string[];
  permissions: string[];
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: SessionUser;
}
