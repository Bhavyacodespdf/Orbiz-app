/** The single place email addresses are normalised for comparison and storage. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
