import { Module } from '@nestjs/common';
import { UserController, UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  controllers: [UsersController, UserController],
  providers: [UsersService],
})
export class UsersModule {}
