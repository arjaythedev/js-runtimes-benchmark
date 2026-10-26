import { Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Auth, Viewer } from '../auth/auth.decorators.js';
import { ProfilesService } from './profiles.service.js';

@Controller('profiles')
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get(':username')
  @Auth('optional')
  get(@Viewer() viewer: number, @Param('username') username: string) {
    return this.profiles.get(viewer, username);
  }

  @Post(':username/follow')
  @HttpCode(200)
  follow(@Viewer() viewer: number, @Param('username') username: string) {
    return this.profiles.follow(viewer, username, true);
  }

  @Delete(':username/follow')
  unfollow(@Viewer() viewer: number, @Param('username') username: string) {
    return this.profiles.follow(viewer, username, false);
  }
}
