import { useState } from "react";
import type { WatchedProduct } from "../types";
import { formatPrice, formatRelativeTime } from "../utils/format";
import { getAdapterById } from "../retailers/registry";
import { StatusBadge } from "./StatusBadge";

interface Props {
  product: WatchedProduct;
  checking: boolean;
  onUpdate(product: WatchedProduct): Promise<void>;
  onDelete(id: string): Promise<void>;
  onRefresh(id: string): Promise<void>;
}

export function ProductCard({ product, checking, onUpdate, onDelete, onRefresh }: Props) {
  const [editing, setEditing] = useState(false);
  const [editPrice, setEditPrice] = useState(String(product.targetPrice));
  const [editDrop, setEditDrop] = useState(product.notifyOnPriceDrop);
  const [editRestock, setEditRestock] = useState(product.notifyOnRestock);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const hit =
    product.availabilityStatus === "in_stock" &&
    product.lastSeenPrice != null &&
    product.lastSeenPrice <= product.targetPrice;

  const productUrl =
    getAdapterById(product.retailerId)?.buildProductUrl(product.productId) ?? product.lastKnownUrl;

  async function saveEdits() {
    const price = Number(editPrice);
    if (!Number.isFinite(price) || price <= 0) return;
    await onUpdate({
      ...product,
      targetPrice: price,
      notifyOnPriceDrop: editDrop,
      notifyOnRestock: editRestock,
    });
    setEditing(false);
  }

  return (
    <article className={`card${hit ? " card--hit" : ""}`}>
      <div className="card__main">
        {product.imageUrl ? (
          <img className="card__image" src={product.imageUrl} alt="" />
        ) : (
          <div className="card__image card__image--placeholder">🛍️</div>
        )}
        <div className="card__info">
          <h3 className="card__name" title={product.productName}>
            {product.productName ?? "Loading product…"}
          </h3>
          <div className="card__prices">
            <span className="card__price-now">{formatPrice(product.lastSeenPrice)}</span>
            {product.lastSeenOriginalPrice != null &&
              product.lastSeenPrice != null &&
              product.lastSeenOriginalPrice > product.lastSeenPrice && (
                <span className="card__price-was">{formatPrice(product.lastSeenOriginalPrice)}</span>
              )}
            <span className="card__price-target">target {formatPrice(product.targetPrice)}</span>
          </div>
          <div className="card__meta">
            <StatusBadge status={product.availabilityStatus} />
            <span className="card__checked" title={product.lastError ?? undefined}>
              {product.lastError ? "⚠ " : ""}checked {formatRelativeTime(product.lastCheckedAt)}
            </span>
          </div>
        </div>
      </div>

      {editing ? (
        <div className="card__edit">
          <label>
            Desired price ($)
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={editPrice}
              onChange={(e) => setEditPrice(e.target.value)}
            />
          </label>
          <label className="card__toggle">
            <input type="checkbox" checked={editDrop} onChange={(e) => setEditDrop(e.target.checked)} />
            Notify on price drops
          </label>
          <label className="card__toggle">
            <input
              type="checkbox"
              checked={editRestock}
              onChange={(e) => setEditRestock(e.target.checked)}
            />
            Notify on restocks
          </label>
          <div className="card__actions">
            <button className="btn btn--primary" onClick={() => void saveEdits()}>
              Save
            </button>
            <button className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="card__actions">
          <button
            className="btn btn--primary"
            disabled={!productUrl}
            onClick={() => productUrl && void chrome.tabs.create({ url: productUrl })}
          >
            Open
          </button>
          <button className="btn" disabled={checking} onClick={() => void onRefresh(product.id)}>
            {checking ? "…" : "Refresh"}
          </button>
          <button
            className="btn"
            onClick={() => {
              setEditPrice(String(product.targetPrice));
              setEditDrop(product.notifyOnPriceDrop);
              setEditRestock(product.notifyOnRestock);
              setEditing(true);
            }}
          >
            Edit
          </button>
          <button
            className={`btn ${confirmRemove ? "btn--danger" : ""}`}
            onClick={() => {
              if (confirmRemove) void onDelete(product.id);
              else {
                setConfirmRemove(true);
                setTimeout(() => setConfirmRemove(false), 2500);
              }
            }}
          >
            {confirmRemove ? "Sure?" : "Remove"}
          </button>
        </div>
      )}
    </article>
  );
}
