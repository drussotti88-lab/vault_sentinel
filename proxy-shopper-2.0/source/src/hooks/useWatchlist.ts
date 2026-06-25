import { useCallback, useEffect, useState } from "react";
import type { CheckResponse, ProductData, WatchedProduct } from "../types";
import { getProducts, onProductsChanged, removeProduct, saveProduct } from "../shared/storage";
import { getAdapterById, getAdapterForUrl } from "../retailers/registry";
import { generateId } from "../utils/id";

interface UseWatchlist {
  products: WatchedProduct[];
  loading: boolean;
  /** ids of products currently being refreshed */
  checkingIds: Set<string>;
  addProduct(url: string, targetPrice: number): Promise<void>;
  addDetected(data: ProductData, targetPrice: number): Promise<void>;
  updateProduct(product: WatchedProduct): Promise<void>;
  deleteProduct(id: string): Promise<void>;
  refreshProduct(id: string): Promise<void>;
  refreshAll(): Promise<void>;
}

export function useWatchlist(): UseWatchlist {
  const [products, setProducts] = useState<WatchedProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkingIds, setCheckingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    void getProducts().then((list) => {
      setProducts(list);
      setLoading(false);
    });
    return onProductsChanged(setProducts);
  }, []);

  const addProduct = useCallback(async (url: string, targetPrice: number) => {
    const trimmed = url.trim();
    const adapter = getAdapterForUrl(trimmed);
    if (!adapter) {
      throw new Error("That doesn't look like a supported product URL. Paste a Target.com product page link (target.com/p/...).");
    }
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      throw new Error("Enter a desired price greater than $0.");
    }
    // Normalize the URL down to the retailer product id (TCIN for Target).
    const productId = await adapter.extractProductId(trimmed);
    if (!productId) {
      throw new Error("Couldn't find a Target product ID (TCIN) in that link. Make sure it's a product page URL containing \"A-<number>\".");
    }
    const existing = (await getProducts()).find(
      (p) => p.retailerId === adapter.retailerId && p.productId === productId,
    );
    if (existing) {
      throw new Error("You're already watching this product.");
    }

    const now = new Date().toISOString();
    const product: WatchedProduct = {
      id: generateId(),
      retailerId: adapter.retailerId,
      productId,
      lastKnownUrl: trimmed,
      targetPrice,
      availabilityStatus: "unknown",
      notifyOnPriceDrop: true,
      notifyOnRestock: true,
      createdAt: now,
      updatedAt: now,
    };
    await saveProduct(product);
    // Populate name / image / price right away.
    void chrome.runtime.sendMessage({ type: "CHECK_PRODUCT", watchedId: product.id });
  }, []);

  /** Add a product already extracted from the active page (no URL round-trip). */
  const addDetected = useCallback(async (data: ProductData, targetPrice: number) => {
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      throw new Error("Enter a desired price greater than $0.");
    }
    const existing = (await getProducts()).find(
      (p) => p.retailerId === data.retailerId && p.productId === data.productId,
    );
    if (existing) throw new Error("You're already watching this product.");

    const now = new Date().toISOString();
    const adapter = getAdapterById(data.retailerId);
    const product: WatchedProduct = {
      id: generateId(),
      retailerId: data.retailerId,
      productId: data.productId,
      lastKnownUrl: adapter?.buildProductUrl(data.productId),
      productName: data.productName,
      imageUrl: data.imageUrl,
      targetPrice,
      lastSeenPrice: data.currentPrice,
      lastSeenOriginalPrice: data.originalPrice,
      availabilityStatus: data.availabilityStatus,
      shippingAvailable: data.shippingAvailable,
      pickupAvailable: data.pickupAvailable,
      notifyOnPriceDrop: true,
      notifyOnRestock: true,
      createdAt: now,
      updatedAt: now,
      lastCheckedAt: data.lastCheckedAt,
    };
    await saveProduct(product);
  }, []);

  const updateProduct = useCallback(async (product: WatchedProduct) => {
    await saveProduct(product);
  }, []);

  const deleteProduct = useCallback(async (id: string) => {
    await removeProduct(id);
  }, []);

  const refreshProduct = useCallback(async (id: string) => {
    setCheckingIds((prev) => new Set(prev).add(id));
    try {
      await chrome.runtime.sendMessage<unknown, CheckResponse>({
        type: "CHECK_PRODUCT",
        watchedId: id,
      });
    } finally {
      setCheckingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const refreshAll = useCallback(async () => {
    const ids = (await getProducts()).map((p) => p.id);
    setCheckingIds(new Set(ids));
    try {
      await chrome.runtime.sendMessage<unknown, CheckResponse>({ type: "CHECK_ALL_NOW" });
    } finally {
      setCheckingIds(new Set());
    }
  }, []);

  return { products, loading, checkingIds, addProduct, addDetected, updateProduct, deleteProduct, refreshProduct, refreshAll };
}
