/** Joins the class names that are set, skipping false, null, and undefined. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
