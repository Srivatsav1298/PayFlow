import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/;
const PASSWORD_MSG = 'password must contain upper-case, lower-case and a digit';

export class RegisterDto {
  @ApiProperty() @IsEmail() @MaxLength(254) email: string;
  @ApiProperty({ minLength: 10 }) @IsString() @MinLength(10) @MaxLength(128) @Matches(PASSWORD_RULE, { message: PASSWORD_MSG })
  password: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(100) name: string;
  @ApiProperty({ description: 'Name of the organisation to create; the registrant becomes its admin' })
  @IsString() @IsNotEmpty() @MaxLength(100)
  organisationName: string;
}

export class LoginDto {
  @ApiProperty() @IsEmail() email: string;
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(128) password: string;
}

export class RefreshDto {
  @ApiProperty() @IsString() @IsNotEmpty() @MaxLength(256) refreshToken: string;
}
