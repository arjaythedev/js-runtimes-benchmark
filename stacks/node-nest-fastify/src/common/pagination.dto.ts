import { IsOptional, IsString, Matches } from 'class-validator';

// Query strings stay strings; the patterns reject signs, spaces, decimals and out-of-range values.
export class PaginationQueryDto {
  @IsOptional()
  @Matches(/^0*([1-9]|[1-9][0-9]|100)$/, { message: 'limit must be an integer from 1 to 100' })
  limit?: string;

  @IsOptional()
  @Matches(/^0*[0-9]{1,15}$/, { message: 'offset must be a non-negative integer' })
  offset?: string;
}

export class ListArticlesQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() tag?: string;
  @IsOptional() @IsString() author?: string;
  @IsOptional() @IsString() favorited?: string;
}

export const page = (q: PaginationQueryDto) => ({
  limit: q.limit === undefined ? 20 : Number(q.limit),
  offset: q.offset === undefined ? 0 : Number(q.offset),
});
