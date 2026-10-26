// Row -> JSON shapes from SPEC.md.

export const profile = (r: any, following: boolean = r.following) => ({
  username: r.username as string,
  bio: r.bio as string | null,
  image: r.image as string | null,
  following,
});

export const article = (r: any, withBody: boolean) => ({
  slug: r.slug,
  title: r.title,
  description: r.description,
  ...(withBody ? { body: r.body } : {}),
  tagList: r.tag_list,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  favorited: r.favorited,
  favoritesCount: r.favorites_count,
  author: profile(r),
});

export const comment = (r: any, following: boolean = r.following) => ({
  id: r.id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  body: r.body,
  author: profile(r, following),
});

export const user = (r: any, token: string) => ({
  email: r.email,
  token,
  username: r.username,
  bio: r.bio,
  image: r.image,
});
