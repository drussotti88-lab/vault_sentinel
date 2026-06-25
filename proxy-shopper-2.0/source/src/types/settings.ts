/** Global user preferences. Persisted in chrome.storage.local. */
export interface UserSettings {
  /** How often the background monitor checks watched products (minutes). */
  checkIntervalMinutes: number;

  /** Master switch for all browser notifications. */
  enableNotifications: boolean;

  enablePriceDropAlerts: boolean;
  enableRestockAlerts: boolean;

  quietHoursEnabled: boolean;
  /** "HH:MM" 24h local time. Quiet range may span midnight. */
  quietHoursStart?: string;
  quietHoursEnd?: string;

  /** Proxy Assist Mode: highlight actions on the product page after an alert. */
  enableProxyAssist: boolean;
  /** Proxy Assist Mode: automatically open the product page when conditions are met. */
  assistAutoOpenTab: boolean;
  /**
   * Express Lane: when assist is active on a product page, automatically add
   * the item to the cart and open the cart. Final checkout is always manual.
   */
  assistAutoAddToCart: boolean;
  /**
   * Express Lane: automatically click INTERMEDIATE checkout steps (Continue,
   * Save & continue, Review order, etc.) to advance toward the final screen.
   * The final order-submitting button is never clicked automatically.
   */
  assistAutoAdvanceCheckout: boolean;

  /**
   * Queue-it waiting-room detector. When on, the extension alerts you the
   * moment your browser is dropped into a Queue-it waiting room (Pokémon
   * Center, Walmart, Target, …) — i.e. a drop just went live — and again when
   * you clear the line. It only reports the queue; it never bypasses it.
   */
  queueDetectorEnabled: boolean;

  /**
   * Optional Discord webhook URL. When set, every alert that fires is also
   * posted to this Discord channel (in addition to the browser notification),
   * so alerts reach you wherever you watch Discord.
   */
  discordWebhookUrl?: string;
}

export const DEFAULT_SETTINGS: UserSettings = {
  checkIntervalMinutes: 10,
  enableNotifications: true,
  enablePriceDropAlerts: true,
  enableRestockAlerts: true,
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
  enableProxyAssist: true,
  assistAutoOpenTab: false,
  assistAutoAddToCart: false,
  assistAutoAdvanceCheckout: false,
  queueDetectorEnabled: true,
  discordWebhookUrl: "",
};
