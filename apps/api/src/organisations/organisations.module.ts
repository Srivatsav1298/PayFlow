import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable,
  Module, Param, ParseUUIDPipe, Patch, Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsEmail, IsEnum, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { AuditService } from '../audit-logs/audit-logs.module';
import { CurrentUser, MinRole, Org } from '../common/decorators';
import { hashPassword } from '../common/crypto.util';
import { PrismaService } from '../common/prisma.service';
import { MatchingConfig, resolveConfig } from '../reconciliation/matching.config';

export class UpdateOrganisationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^[A-Z]{3}$/) baseCurrency?: string;
  @ApiPropertyOptional({ description: 'Partial matching config; unspecified keys use defaults' })
  @IsOptional() @IsObject() reconciliationConfig?: Partial<MatchingConfig>;
}

export class AddMemberDto {
  @ApiProperty() @IsEmail() email: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) name: string;
  @ApiProperty({ description: 'Initial password (used only when creating a new account)' })
  @IsString() @MinLength(10) @MaxLength(128) @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/)
  password: string;
  @ApiProperty({ enum: Role }) @IsEnum(Role) role: Role;
}

export class UpdateMemberDto {
  @ApiProperty({ enum: Role }) @IsIn(Object.values(Role)) role: Role;
}

@Injectable()
class OrganisationsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async get(orgId: string) {
    const org = await this.prisma.organisation.findUniqueOrThrow({ where: { id: orgId } });
    return { ...org, reconciliationConfig: resolveConfig(org.reconciliationConfig) };
  }

  async update(orgId: string, actorId: string, dto: UpdateOrganisationDto) {
    const data: Record<string, unknown> = {};
    if (dto.name) data.name = dto.name;
    if (dto.baseCurrency) data.baseCurrency = dto.baseCurrency;
    if (dto.reconciliationConfig) {
      // resolveConfig validates ranges and throws on nonsense (e.g. negative tolerance)
      data.reconciliationConfig = resolveConfig(dto.reconciliationConfig) as object;
    }
    const org = await this.prisma.organisation.update({ where: { id: orgId }, data });
    await this.audit.log({ organisationId: orgId, actorId, action: 'organisation.update', entityType: 'Organisation', entityId: orgId, metadata: dto as Record<string, unknown> });
    return { ...org, reconciliationConfig: resolveConfig(org.reconciliationConfig) };
  }

  members(orgId: string) {
    return this.prisma.organisationMembership.findMany({
      where: { organisationId: orgId },
      select: { id: true, role: true, createdAt: true, user: { select: { id: true, email: true, name: true, isActive: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addMember(orgId: string, actorId: string, dto: AddMemberDto) {
    const email = dto.email.toLowerCase();
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (user) {
      const existing = await this.prisma.organisationMembership.findUnique({
        where: { userId_organisationId: { userId: user.id, organisationId: orgId } },
      });
      if (existing) throw new ConflictException('User is already a member');
    } else {
      user = await this.prisma.user.create({ data: { email, name: dto.name, passwordHash: await hashPassword(dto.password) } });
    }
    const m = await this.prisma.organisationMembership.create({
      data: { userId: user.id, organisationId: orgId, role: dto.role },
    });
    await this.audit.log({ organisationId: orgId, actorId, action: 'member.add', entityType: 'OrganisationMembership', entityId: m.id, metadata: { email, role: dto.role } });
    return { id: m.id, role: m.role, user: { id: user.id, email: user.email, name: user.name } };
  }

  private async assertNotLastAdmin(orgId: string, membershipId: string) {
    const target = await this.prisma.organisationMembership.findFirst({ where: { id: membershipId, organisationId: orgId } });
    if (!target) throw new BadRequestException('Membership not found');
    if (target.role === Role.ADMIN) {
      const admins = await this.prisma.organisationMembership.count({ where: { organisationId: orgId, role: Role.ADMIN } });
      if (admins <= 1) throw new ForbiddenException('An organisation must keep at least one admin');
    }
    return target;
  }

  async updateMember(orgId: string, actorId: string, id: string, dto: UpdateMemberDto) {
    const existing = await this.prisma.organisationMembership.findFirst({ where: { id, organisationId: orgId } });
    if (!existing) throw new BadRequestException('Membership not found');
    // Demoting the last admin would orphan the organisation.
    if (dto.role !== Role.ADMIN) await this.assertNotLastAdmin(orgId, id);
    const m = await this.prisma.organisationMembership.update({ where: { id: existing.id }, data: { role: dto.role } });
    await this.audit.log({ organisationId: orgId, actorId, action: 'member.role_change', entityType: 'OrganisationMembership', entityId: id, metadata: { role: dto.role } });
    return m;
  }

  async removeMember(orgId: string, actorId: string, id: string) {
    await this.assertNotLastAdmin(orgId, id);
    await this.prisma.organisationMembership.delete({ where: { id } });
    await this.audit.log({ organisationId: orgId, actorId, action: 'member.remove', entityType: 'OrganisationMembership', entityId: id });
    return { success: true };
  }
}

@ApiTags('organisations')
@ApiBearerAuth()
@Controller('organisations/current')
class OrganisationsController {
  constructor(private readonly svc: OrganisationsService) {}

  @Get() get(@Org() org: { id: string }) { return this.svc.get(org.id); }

  @Patch() @MinRole(Role.ADMIN)
  update(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Body() dto: UpdateOrganisationDto) {
    return this.svc.update(org.id, u.id, dto);
  }

  @Get('members') @MinRole(Role.ADMIN)
  members(@Org() org: { id: string }) { return this.svc.members(org.id); }

  @Post('members') @MinRole(Role.ADMIN)
  add(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Body() dto: AddMemberDto) {
    return this.svc.addMember(org.id, u.id, dto);
  }

  @Patch('members/:id') @MinRole(Role.ADMIN)
  patchMember(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMemberDto) {
    return this.svc.updateMember(org.id, u.id, id, dto);
  }

  @Delete('members/:id') @MinRole(Role.ADMIN)
  remove(@Org() org: { id: string }, @CurrentUser() u: { id: string }, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.removeMember(org.id, u.id, id);
  }
}

@Module({ controllers: [OrganisationsController], providers: [OrganisationsService] })
export class OrganisationsModule {}
