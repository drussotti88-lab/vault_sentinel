import { useRef, useState } from "react";
import { useSettings } from "../hooks/useSettings";
import { useProfile } from "../hooks/useProfile";
import { clearAllData, exportData, importData } from "../shared/storage";

export function Options() {
  const { settings, loading, update } = useSettings();
  const { profile, update: updateProfile } = useProfile();
  const [status, setStatus] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function flash(message: string) {
    setStatus(message);
    setTimeout(() => setStatus(null), 3000);
  }

  async function handleExport() {
    const json = await exportData();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `proxy-shopper-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    flash("Data exported.");
  }

  async function handleImport(file: File | undefined) {
    if (!file) return;
    try {
      const { imported } = await importData(await file.text());
      flash(`Imported ${imported} product${imported === 1 ? "" : "s"}.`);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Import failed.");
    }
    if (fileInput.current) fileInput.current.value = "";
  }

  async function handleClear() {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    await clearAllData();
    setConfirmClear(false);
    flash("All data cleared.");
  }

  if (loading) return <div className="options">Loading…</div>;

  return (
    <div className="options">
      <header className="options__header">
        <h1>Proxy Shopper 2.0 — Settings</h1>
        {status && <span className="options__status">{status}</span>}
      </header>

      <section className="section">
        <h2>Monitoring</h2>
        <label className="field">
          <span>Check products every (minutes)</span>
          <input
            type="number"
            min={1}
            max={240}
            value={settings.checkIntervalMinutes}
            onChange={(e) => {
              const v = Math.max(1, Math.min(240, Number(e.target.value) || 1));
              void update({ checkIntervalMinutes: v });
            }}
          />
        </label>
        <p className="hint">
          Checks run one product at a time with a short gap between them, to stay polite to the
          retailer. <strong>2–5 minutes</strong> is the sustainable sweet spot. You can go as low as
          1 minute for an active drop, but very short intervals across many items can get your
          requests throttled by the retailer — which makes monitoring <em>slower</em>, not faster.
          A tab you have open updates for free, with no extra requests.
        </p>
      </section>

      <section className="section">
        <h2>Notifications</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.enableNotifications}
            onChange={(e) => void update({ enableNotifications: e.target.checked })}
          />
          <span>Enable browser notifications</span>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            disabled={!settings.enableNotifications}
            checked={settings.enablePriceDropAlerts}
            onChange={(e) => void update({ enablePriceDropAlerts: e.target.checked })}
          />
          <span>Price drop &amp; target-price alerts</span>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            disabled={!settings.enableNotifications}
            checked={settings.enableRestockAlerts}
            onChange={(e) => void update({ enableRestockAlerts: e.target.checked })}
          />
          <span>Restock &amp; availability alerts</span>
        </label>
      </section>

      <section className="section">
        <h2>Quiet hours</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.quietHoursEnabled}
            onChange={(e) => void update({ quietHoursEnabled: e.target.checked })}
          />
          <span>Silence notifications during quiet hours</span>
        </label>
        <div className="field-row">
          <label className="field">
            <span>From</span>
            <input
              type="time"
              disabled={!settings.quietHoursEnabled}
              value={settings.quietHoursStart ?? "22:00"}
              onChange={(e) => void update({ quietHoursStart: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Until</span>
            <input
              type="time"
              disabled={!settings.quietHoursEnabled}
              value={settings.quietHoursEnd ?? "08:00"}
              onChange={(e) => void update({ quietHoursEnd: e.target.value })}
            />
          </label>
        </div>
      </section>

      <section className="section">
        <h2>Proxy Assist Mode</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.enableProxyAssist}
            onChange={(e) => void update({ enableProxyAssist: e.target.checked })}
          />
          <span>Highlight purchase actions on the product page after an alert</span>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            disabled={!settings.enableProxyAssist}
            checked={settings.assistAutoOpenTab}
            onChange={(e) => void update({ assistAutoOpenTab: e.target.checked })}
          />
          <span>Automatically open the product page when conditions are met</span>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            disabled={!settings.enableProxyAssist}
            checked={settings.assistAutoAddToCart}
            onChange={(e) => void update({ assistAutoAddToCart: e.target.checked })}
          />
          <span>Express Lane: auto-add to cart and open the cart on an alert</span>
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            disabled={!settings.enableProxyAssist}
            checked={settings.assistAutoAdvanceCheckout}
            onChange={(e) => void update({ assistAutoAdvanceCheckout: e.target.checked })}
          />
          <span>Express Lane: auto-advance intermediate checkout steps (Continue, Review, etc.)</span>
        </label>
        <p className="hint">
          Express Lane gets you to a ready-to-confirm order automatically — adding to cart, advancing
          through the “Continue/Review” steps, and filling your saved info. But{" "}
          <strong>you always place the order yourself</strong>: the final “Place order” button is
          only highlighted, never clicked. Proxy Shopper never submits an order or charges your card
          on its own.
        </p>
      </section>

      <section className="section">
        <h2>Checkout profile</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Used by Express Lane's <strong>“Fill my info”</strong> button to populate contact and
          shipping fields at checkout. <strong>No payment data is stored here</strong> — card
          numbers and passwords stay in your Target account or Chrome autofill, never in this
          extension.
        </p>
        <div className="field-row">
          <label className="field">
            <span>First name</span>
            <input
              value={profile.firstName}
              onChange={(e) => void updateProfile({ firstName: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Last name</span>
            <input
              value={profile.lastName}
              onChange={(e) => void updateProfile({ lastName: e.target.value })}
            />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              value={profile.email}
              onChange={(e) => void updateProfile({ email: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Phone</span>
            <input
              type="tel"
              value={profile.phone}
              onChange={(e) => void updateProfile({ phone: e.target.value })}
            />
          </label>
        </div>
        <label className="field">
          <span>Address line 1</span>
          <input
            style={{ width: "100%" }}
            value={profile.address1}
            onChange={(e) => void updateProfile({ address1: e.target.value })}
          />
        </label>
        <label className="field">
          <span>Address line 2 (optional)</span>
          <input
            style={{ width: "100%" }}
            value={profile.address2}
            onChange={(e) => void updateProfile({ address2: e.target.value })}
          />
        </label>
        <div className="field-row">
          <label className="field">
            <span>City</span>
            <input value={profile.city} onChange={(e) => void updateProfile({ city: e.target.value })} />
          </label>
          <label className="field">
            <span>State</span>
            <input
              maxLength={2}
              placeholder="CA"
              value={profile.state}
              onChange={(e) => void updateProfile({ state: e.target.value.toUpperCase() })}
            />
          </label>
          <label className="field">
            <span>ZIP</span>
            <input value={profile.zip} onChange={(e) => void updateProfile({ zip: e.target.value })} />
          </label>
        </div>
      </section>

      <section className="section">
        <h2>Data</h2>
        <div className="button-row">
          <button className="btn" onClick={() => void handleExport()}>
            Export data
          </button>
          <button className="btn" onClick={() => fileInput.current?.click()}>
            Import data
          </button>
          <button className={`btn ${confirmClear ? "btn--danger" : ""}`} onClick={() => void handleClear()}>
            {confirmClear ? "Click again to confirm" : "Clear all data"}
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="application/json"
          hidden
          onChange={(e) => void handleImport(e.target.files?.[0])}
        />
      </section>
    </div>
  );
}
