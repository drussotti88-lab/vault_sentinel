import { useEffect, useState } from "react";
import type { ProductData } from "../types";
import { formatPrice } from "../utils/format";

interface Props {
  product: ProductData;
  onWatch(product: ProductData, targetPrice: number): Promise<void>;
}

/**
 * Shown at the top of the side panel when the active tab is a supported
 * product page that isn't being watched yet. One click adds it.
 */
export function DetectedProductBanner({ product, onWatch }: Props) {
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pre-fill the desired price with the current price when detected.
  useEffect(() => {
    setPrice(product.currentPrice != null ? String(product.currentPrice) : "");
    setError(null);
  }, [product.productId, product.currentPrice]);

  async function handleWatch() {
    setBusy(true);
    setError(null);
    try {
      await onWatch(product, Number(price));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="detected">
      <div className="detected__top">
        {product.imageUrl ? (
          <img className="detected__image" src={product.imageUrl} alt="" />
        ) : (
          <div className="detected__image detected__image--placeholder">🛍️</div>
        )}
        <div className="detected__info">
          <span className="detected__label">On this page</span>
          <span className="detected__name" title={product.productName}>
            {product.productName}
          </span>
          <span className="detected__price">
            {product.currentPrice != null ? formatPrice(product.currentPrice) : "Price unknown"}
          </span>
        </div>
      </div>
      <div className="detected__actions">
        <input
          type="number"
          min="0.01"
          step="0.01"
          placeholder="Desired price ($)"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          aria-label="Desired price"
        />
        <button className="btn btn--primary" disabled={busy} onClick={() => void handleWatch()}>
          {busy ? "Adding…" : "Watch this"}
        </button>
      </div>
      {error && <p className="detected__error">{error}</p>}
    </div>
  );
}
