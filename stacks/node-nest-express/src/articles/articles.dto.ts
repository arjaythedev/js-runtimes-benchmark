import { Type } from 'class-transformer';
import { IsArray, IsDefined, IsNotEmpty, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';

export class NewArticleFieldsDto {
  @IsString() @IsNotEmpty() title: string;
  @IsString() @IsNotEmpty() description: string;
  @IsString() @IsNotEmpty() body: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @IsNotEmpty({ each: true }) tagList?: string[] | null;
}

export class CreateArticleDto {
  @IsDefined() @IsObject() @ValidateNested() @Type(() => NewArticleFieldsDto) article: NewArticleFieldsDto;
}

export class UpdateArticleFieldsDto {
  @IsOptional() @IsString() @IsNotEmpty() title?: string | null;
  @IsOptional() @IsString() @IsNotEmpty() description?: string | null;
  @IsOptional() @IsString() @IsNotEmpty() body?: string | null;
}

export class UpdateArticleDto {
  @IsDefined() @IsObject() @ValidateNested() @Type(() => UpdateArticleFieldsDto) article: UpdateArticleFieldsDto;
}

export class NewCommentFieldsDto {
  @IsString() @IsNotEmpty() body: string;
}

export class CreateCommentDto {
  @IsDefined() @IsObject() @ValidateNested() @Type(() => NewCommentFieldsDto) comment: NewCommentFieldsDto;
}
