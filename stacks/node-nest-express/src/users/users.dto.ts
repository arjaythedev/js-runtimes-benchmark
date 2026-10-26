import { Type } from 'class-transformer';
import { IsByteLength, IsDefined, IsNotEmpty, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';

// bcrypt only looks at the first 72 bytes, so longer passwords are rejected rather than silently truncated.
export class NewUserDto {
  @IsString() @IsNotEmpty() username: string;
  @IsString() @IsNotEmpty() email: string;
  @IsString() @IsNotEmpty() @IsByteLength(1, 72) password: string;
}

export class RegisterDto {
  @IsDefined() @IsObject() @ValidateNested() @Type(() => NewUserDto) user: NewUserDto;
}

export class LoginUserDto {
  @IsString() @IsNotEmpty() email: string;
  @IsString() @IsNotEmpty() password: string;
}

export class LoginDto {
  @IsDefined() @IsObject() @ValidateNested() @Type(() => LoginUserDto) user: LoginUserDto;
}

// Absent or null fields are left unchanged.
export class UpdateUserFieldsDto {
  @IsOptional() @IsString() @IsNotEmpty() email?: string | null;
  @IsOptional() @IsString() @IsNotEmpty() username?: string | null;
  @IsOptional() @IsString() @IsNotEmpty() @IsByteLength(1, 72) password?: string | null;
  @IsOptional() @IsString() bio?: string | null;
  @IsOptional() @IsString() image?: string | null;
}

export class UpdateUserDto {
  @IsDefined() @IsObject() @ValidateNested() @Type(() => UpdateUserFieldsDto) user: UpdateUserFieldsDto;
}
