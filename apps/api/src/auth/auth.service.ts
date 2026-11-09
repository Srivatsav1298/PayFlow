import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuditService } from '../audit-logs/audit-logs.module';
import { hashPassword, randomToken, sha256, verifyPassword } from '../common/crypto.util';
import { PrismaService } from '../common/prisma.service';
import { LoginDto, RegisterDto } from './auth.dto';

// Used to equalise timing when the account does not exist (no user enumeration).
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async register(dto: RegisterDto, ip?: string) {
    const email = dto.email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException('Email is already registered');
    }
    const passwordHash = await hashPassword(dto.password);
    const user = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email, name: dto.name, passwordHash } });
      const org = await tx.organisation.create({
        data: { name: dto.organisationName, slug: `${slugify(dto.organisationName)}-${randomToken(4).toLowerCase()}` },
      });
      await tx.organisationMembership.create({ data: { userId: user.id, organisationId: org.id, role: Role.ADMIN } });
      await this.audit.log(
        { organisationId: org.id, actorId: user.id, action: 'auth.register', entityType: 'User', entityId: user.id, ip },
        tx,
      );
      return user;
    });
    return this.issueSession(user.id);
  }

  async login(dto: LoginDto, ip?: string) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    const ok = await verifyPassword(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok || !user.isActive) {
      await this.audit.log({ action: 'auth.login_failed', entityType: 'User', ip });
      throw new UnauthorizedException('Invalid credentials');
    }
    await this.audit.log({ actorId: user.id, action: 'auth.login', entityType: 'User', entityId: user.id, ip });
    return this.issueSession(user.id);
  }

  /** Rotating refresh tokens. Re-presenting a revoked token revokes the entire family (theft signal). */
  async refresh(rawToken: string) {
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
    if (!record) throw new UnauthorizedException('Invalid refresh token');
    if (record.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: record.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Refresh token reuse detected');
    }
    if (record.expiresAt < new Date()) throw new UnauthorizedException('Refresh token expired');

    const user = await this.prisma.user.findUnique({ where: { id: record.userId } });
    if (!user?.isActive) throw new UnauthorizedException('Account disabled');

    // Atomically claim the token so two concurrent refreshes cannot both succeed.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: record.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count !== 1) throw new UnauthorizedException('Invalid refresh token');
    return this.issueSession(record.userId, record.familyId);
  }

  async logout(rawToken: string) {
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(rawToken) } });
    if (record) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: record.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    return { success: true };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { memberships: { include: { organisation: true } } },
    });
    return this.profile(user);
  }

  private profile(user: {
    id: string; email: string; name: string;
    memberships: { organisationId: string; role: Role; organisation: { name: string } }[];
  }) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      memberships: user.memberships.map((m) => ({
        organisationId: m.organisationId,
        organisationName: m.organisation.name,
        role: m.role,
      })),
    };
  }

  private async issueSession(userId: string, familyId: string = randomUUID()) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { memberships: { include: { organisation: true } } },
    });
    const accessToken = await this.jwt.signAsync(
      { sub: user.id },
      {
        secret: this.config.getOrThrow('JWT_ACCESS_SECRET'),
        expiresIn: this.config.get('JWT_ACCESS_TTL', '15m'),
        algorithm: 'HS256',
      },
    );
    const refreshToken = randomToken();
    const ttlDays = Number(this.config.get('REFRESH_TOKEN_TTL_DAYS', 30));
    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
      },
    });
    return { accessToken, refreshToken, user: this.profile(user) };
  }
}
