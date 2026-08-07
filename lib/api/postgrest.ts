/**
 * Escapes a user-supplied value for use inside a PostgREST filter string
 * (e.g. the argument to `.or()`), where reserved characters like `,` `.`
 * `(` `)` would otherwise break out of the filter grammar.
 *
 * PostgREST allows a filter value to be double-quoted; inside those quotes
 * only `"` and `\` are special. Callers must wrap the returned value in
 * double quotes themselves, e.g. `title.ilike."%${escaped}%"`.
 */
export function escapePostgrestFilterValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
