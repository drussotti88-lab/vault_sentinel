import { AddProductForm } from "../components/AddProductForm";
import { DetectedProductBanner } from "../components/DetectedProductBanner";
import { ProductCard } from "../components/ProductCard";
import { useWatchlist } from "../hooks/useWatchlist";
import { useActiveTabProduct } from "../hooks/useActiveTabProduct";

export function Popup() {
  const { products, loading, checkingIds, addProduct, addDetected, updateProduct, deleteProduct, refreshProduct, refreshAll } =
    useWatchlist();
  const { detected, refresh: refreshDetected } = useActiveTabProduct(products);

  async function watchDetected(data: Parameters<typeof addDetected>[0], targetPrice: number) {
    await addDetected(data, targetPrice);
    refreshDetected();
  }

  return (
    <div className="popup">
      <header className="popup__header">
        <h1>Proxy Shopper</h1>
        <div className="popup__header-actions">
          {products.length > 0 && (
            <button
              className="btn btn--small"
              disabled={checkingIds.size > 0}
              onClick={() => void refreshAll()}
              title="Check all products now"
            >
              {checkingIds.size > 0 ? "Checking…" : "Check all"}
            </button>
          )}
          <button
            className="btn btn--small"
            title="Settings"
            onClick={() => void chrome.runtime.openOptionsPage()}
          >
            ⚙
          </button>
        </div>
      </header>

      {detected && <DetectedProductBanner product={detected} onWatch={watchDetected} />}

      <AddProductForm onAdd={addProduct} />

      <main className="popup__list">
        {loading ? (
          <p className="popup__empty">Loading…</p>
        ) : products.length === 0 ? (
          <p className="popup__empty">
            No products watched yet.
            <br />
            Paste a Target product URL above to start monitoring.
          </p>
        ) : (
          products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              checking={checkingIds.has(product.id)}
              onUpdate={updateProduct}
              onDelete={deleteProduct}
              onRefresh={refreshProduct}
            />
          ))
        )}
      </main>
    </div>
  );
}
