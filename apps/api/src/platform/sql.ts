/** A LIKE/ILIKE pattern matching `s` anywhere, with %, _ and \ escaped (PostgreSQL's default escape is \). */
export const likeContains = (s: string): string => `%${s.replace(/[%_\\]/g, "\\$&")}%`;
