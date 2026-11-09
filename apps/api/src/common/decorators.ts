import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AuthedRequest } from './auth.types';

export const IS_PUBLIC = 'isPublic';
export const SKIP_ORG = 'skipOrg';
export const MIN_ROLE = 'minRole';

/** No authentication at all (login, register, webhooks, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Authenticated, but not scoped to an organisation (e.g. /auth/me). */
export const SkipOrg = () => SetMetadata(SKIP_ORG, true);
/** Minimum role required: ANALYST < MANAGER < ADMIN. Enforced server-side by RolesGuard. */
export const MinRole = (role: Role) => SetMetadata(MIN_ROLE, role);

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user!;
});

/** Resolved organisation context: { id, role } — always validated against membership. */
export const Org = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().org!;
});
