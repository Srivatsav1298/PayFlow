import { Body, Controller, Get, HttpCode, Ip, Module, Post } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, Public, SkipOrg } from '../common/decorators';
import { LoginDto, RefreshDto, RegisterDto } from './auth.dto';
import { AuthService } from './auth.service';

// Credential endpoints get a much tighter rate limit than the global default.
const STRICT = { default: { limit: Number(process.env.AUTH_THROTTLE_LIMIT ?? 10), ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public() @Throttle(STRICT) @Post('register')
  register(@Body() dto: RegisterDto, @Ip() ip: string) {
    return this.auth.register(dto, ip);
  }

  @Public() @Throttle(STRICT) @HttpCode(200) @Post('login')
  login(@Body() dto: LoginDto, @Ip() ip: string) {
    return this.auth.login(dto, ip);
  }

  @Public() @Throttle(STRICT) @HttpCode(200) @Post('refresh')
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public() @HttpCode(200) @Post('logout')
  logout(@Body() dto: RefreshDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @ApiBearerAuth() @SkipOrg() @Get('me')
  me(@CurrentUser() user: { id: string }) {
    return this.auth.me(user.id);
  }
}

@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [JwtModule],
})
export class AuthModule {}
