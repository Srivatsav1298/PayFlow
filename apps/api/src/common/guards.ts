import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { AuthedRequest, ROLE_RANK } from './auth.types';
import { IS_PUBLIC, MIN_ROLE, SKIP_ORG } from './decorators';
import { PrismaService } from './prisma.service';

function isPublic(reflector: Reflector, ctx: ExecutionContext) {
  return reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (isPublic(this.reflector, ctx)) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const [scheme, token] = (req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Missing bearer token');
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token, {
        secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
        algorithms: ['HS256'],
      });
      req.user = { id: payload.sub };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

/**
 * Resolves the organisation for the request from X-Organisation-Id (or the user's
 * only/first membership) and verifies membership against the DB on every request,
 * so removed members lose access immediately. Every service query is then scoped
 * by req.org.id — the client can never choose an organisation it does not belong to.
 */
@Injectable()
export class OrgContextGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (isPublic(this.reflector, ctx)) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP_ORG, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const requested = req.headers['x-organisation-id'];
    const orgId = Array.isArray(requested) ? requested[0] : requested;

    const membership = await this.prisma.organisationMembership.findFirst({
      where: { userId: req.user!.id, user: { isActive: true }, ...(orgId ? { organisationId: orgId } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    if (!membership) throw new ForbiddenException('Not a member of this organisation');
    req.org = { id: membership.organisationId, role: membership.role };
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const min = this.reflector.getAllAndOverride<Role>(MIN_ROLE, [ctx.getHandler(), ctx.getClass()]);
    if (!min) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.org) throw new ForbiddenException();
    if (ROLE_RANK[req.org.role] < ROLE_RANK[min]) {
      throw new ForbiddenException(`Requires ${min} role or higher`);
    }
    return true;
  }
}
