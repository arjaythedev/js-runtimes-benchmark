import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ArticlesModule } from './articles/articles.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ErrorsFilter } from './common/errors.filter.js';
import { DatabaseModule } from './database/database.module.js';
import { ProfilesModule } from './profiles/profiles.module.js';
import { TagsModule } from './tags/tags.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [DatabaseModule, AuthModule, UsersModule, ProfilesModule, ArticlesModule, TagsModule],
  providers: [
    // RealWorld reports validation failures as 422.
    { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, transform: true, errorHttpStatusCode: 422 }) },
    { provide: APP_FILTER, useClass: ErrorsFilter },
  ],
})
export class AppModule {}
