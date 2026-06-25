import type { ParseHtmlMessage, ParseHtmlResponse, ProductData } from "../types";

const OFFSCREEN_URL = "src/offscreen/offscreen.html";

let creating: Promise<void> | null = null;

/** Create the offscreen document if it does not already exist. */
async function ensureOffscreenDocument(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
  });
  if (contexts.length > 0) return;

  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["DOM_PARSER" as chrome.offscreen.Reason],
        justification: "Parse fetched retailer product pages to extract price and availability.",
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

/** Parse fetched product-page HTML via the offscreen document. */
export async function parseProductHtml(
  html: string,
  url: string,
  retailerId: string,
  productId: string,
): Promise<ProductData> {
  await ensureOffscreenDocument();
  const message: ParseHtmlMessage = {
    target: "offscreen",
    type: "PARSE_PRODUCT_HTML",
    html,
    url,
    retailerId,
    productId,
  };
  const response = (await chrome.runtime.sendMessage(message)) as ParseHtmlResponse | undefined;
  if (!response?.ok || !response.data) {
    throw new Error(response?.error ?? "Offscreen parser returned no data.");
  }
  return response.data;
}
