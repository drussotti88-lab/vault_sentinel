import { useState, type FormEvent } from "react";

interface Props {
  onAdd(url: string, targetPrice: number): Promise<void>;
}

export function AddProductForm({ onAdd }: Props) {
  const [url, setUrl] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onAdd(url, Number(price));
      setUrl("");
      setPrice("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="add-form" onSubmit={handleSubmit}>
      <input
        type="url"
        required
        placeholder="https://www.target.com/p/..."
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        aria-label="Product URL"
      />
      <div className="add-form__row">
        <input
          type="number"
          required
          min="0.01"
          step="0.01"
          placeholder="Desired price ($)"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          aria-label="Desired price"
        />
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {busy ? "Adding…" : "Watch"}
        </button>
      </div>
      {error && <p className="add-form__error">{error}</p>}
    </form>
  );
}
