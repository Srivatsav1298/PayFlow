import { Role } from '@prisma/client';
import { Request } from 'express';

export interface AuthedRequest extends Request {
  user?: { id: string };
  org?: { id: string; role: Role };
  rawBody?: Buffer;
}

export const ROLE_RANK: Record<Role, number> = { ANALYST: 1, MANAGER: 2, ADMIN: 3 };
