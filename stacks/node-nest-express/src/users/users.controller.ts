import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { Auth, Token, Viewer } from '../auth/auth.decorators.js';
import { LoginDto, RegisterDto, UpdateUserDto } from './users.dto.js';
import { UsersService } from './users.service.js';

@Controller('users')
@Auth('none')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  register(@Body() body: RegisterDto) {
    return this.users.register(body.user);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() body: LoginDto) {
    return this.users.login(body.user);
  }
}

@Controller('user')
export class UserController {
  constructor(private readonly users: UsersService) {}

  @Get()
  current(@Viewer() viewer: number, @Token() token: string) {
    return this.users.current(viewer, token);
  }

  @Put()
  update(@Viewer() viewer: number, @Token() token: string, @Body() body: UpdateUserDto) {
    return this.users.update(viewer, token, body.user);
  }
}
