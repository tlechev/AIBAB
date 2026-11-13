declare const verifiedUserIdBrand: unique symbol;

/**
 * A user id that the server obtained from a verified Supabase session
 * (`supabase.auth.getUser()`), never from client input.
 *
 * `withUserTx()` only accepts this type, so passing an arbitrary string is a
 * compile error. The only place allowed to create it is the session module
 * (task 3); ESLint forbids `as VerifiedUserId` casts anywhere else in `src/`.
 */
export type VerifiedUserId = string & { readonly [verifiedUserIdBrand]: true };
