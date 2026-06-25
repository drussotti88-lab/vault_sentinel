/**
 * Non-sensitive checkout profile. Used to fill contact + shipping fields on a
 * checkout page when the user clicks "Fill my info".
 *
 * SECURITY: This intentionally contains NO payment data — no card number, no
 * CVV, no passwords. Those are handled by the user's Target account or Chrome
 * autofill / password manager, never stored by this extension.
 */
export interface CheckoutProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address1: string;
  address2: string;
  city: string;
  /** Two-letter state code, e.g. "CA". */
  state: string;
  zip: string;
}

export const EMPTY_PROFILE: CheckoutProfile = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  address1: "",
  address2: "",
  city: "",
  state: "",
  zip: "",
};

/** True once the profile has enough to be worth offering to fill. */
export function profileHasData(profile: CheckoutProfile): boolean {
  return Object.values(profile).some((v) => v.trim() !== "");
}
